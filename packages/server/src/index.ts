import express from 'express';
import cors from 'cors';
import type { StreamEvent } from '@receipts/shared';
import { config, describeCredentials, describeMode, describeModels } from './config.js';
import { senatorCache } from './data/SenatorCache.js';
import { runQuery } from './orchestrator/loop.js';
import { queryStore } from './services.js';
import { describeTraceSinks, traceReader } from './services.js';
import { SupabaseQueryStore } from './data/SupabaseQueryStore.js';
import { primaryIssues, subIssuesFor } from './embeddings/taxonomy.js';
import type { Corrections } from '@receipts/shared';
import { actionStore, embedder } from './services.js';
import { TAXONOMY_IS_COMPLETE } from './embeddings/taxonomy.js';
import { queryBurstLimiter, queryDailyLimiter, readOnlyLimiter } from './rateLimit.js';

const app = express();

// ── trust proxy: get this wrong and the limiter INVERTS ────────────────────
// Render terminates TLS at a proxy, so `req.ip` is the proxy's address unless
// Express is told how many hops to trust. Left unset, every request shares one
// key and the rate limiter becomes a GLOBAL one — the first 15 requests from
// anyone lock out everyone.
//
// A hop COUNT, never `true`: `true` trusts the whole X-Forwarded-For chain,
// which a client can forge, letting an abuser mint a fresh bucket per request.
// Verify the number against a real external address before trusting it; see
// docs/rate-limiting-spec.md.
app.set('trust proxy', config.rateLimit.trustProxyHops);
// An allowlist when one is configured; otherwise open, which is only ever
// correct locally. See the startup warning below.
app.use(
  cors(
    config.corsOrigins.length
      ? {
          origin: config.corsOrigins,
          // No cookies or auth headers are used, so credentials stay off —
          // turning them on would force an exact-origin echo and widen what a
          // misconfigured allowlist could expose.
          credentials: false,
        }
      : {},
  ),
);
app.use(express.json());

// Generous cap on the cheap routes. `/api/health` is exempt inside the
// limiter — Render polls it, and a 429 there would restart the service.
app.use('/api', readOnlyLimiter);

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    demo_mode: config.demoMode,
    fixture_mode: config.fixtureMode,
    store: actionStore.kind,
    embedder: embedder.kind,
    model: config.models.explain,
    taxonomy_complete: TAXONOMY_IS_COMPLETE,
  });
});

/**
 * Share link: read one stored query back by id.
 *
 * By id ONLY — no list, no search, no filter by senator. See QueryStore.ts.
 * Returns 404 on a miss rather than reconstructing anything, so a link to a
 * query that was never persisted says so honestly.
 */
app.get('/api/query/:id', async (req, res) => {
  try {
    const stored = await queryStore.getQuery(String(req.params.id));
    if (!stored) {
      res.status(404).json({
        error: {
          code: 'BAD_INPUT',
          message: 'No stored result for that link.',
          recoverable: false,
        },
      });
      return;
    }
    res.json(stored);
  } catch (err) {
    console.error('[share]', err);
    res.status(503).json({
      error: {
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Could not read that result.',
        recoverable: true,
      },
    });
  }
});

/**
 * The step-by-step trace of one run, by run id ONLY.
 *
 * The id is the first event on every stream and is shown under the reasoning
 * panel, so a result that looks wrong on screen can be walked back gate by
 * gate. Same posture as share links: an opaque uuid, no list, no search.
 * 404 on a miss — a trace that was never written says so rather than being
 * reconstructed from the stored result.
 */
app.get('/api/trace/:runId', async (req, res) => {
  try {
    const trace = await traceReader.get(String(req.params.runId));
    if (!trace) {
      res.status(404).json({
        error: { code: 'BAD_INPUT', message: 'No trace for that run id.', recoverable: false },
      });
      return;
    }
    res.json(trace);
  } catch (err) {
    console.error('[trace]', err);
    res.status(503).json({
      error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Could not read that trace.', recoverable: true },
    });
  }
});

app.get('/api/senators', (_req, res) => {
  res.json({
    senators: senatorCache.list(),
    demo_mode: config.demoMode,
    fixture_mode: config.fixtureMode,
    // The correction UI needs to know whether the override path exists before
    // it offers it. Offering a control that the server will reject is worse
    // than not offering it.
    campaign_promise_override: config.features.campaignPromiseOverride,
  });
});

/**
 * The approved taxonomy, for the correction UI's pickers.
 *
 * Served from the same generated table the query path uses, so the menu a user
 * corrects with cannot drift from the menu retrieval is keyed on.
 */
app.get('/api/taxonomy', (_req, res) => {
  res.json({ primary_issues: primaryIssues().map((p) => ({ primary_issue: p, sub_issues: subIssuesFor(p) })) });
});

/**
 * The query stream.
 *
 * GET + SSE rather than POST + chunked, so the browser can use EventSource and
 * reconnect semantics come for free. Steps are flushed as they resolve — the
 * visible reasoning IS the traceability, so buffering it would defeat the point.
 */
app.get('/api/query', queryDailyLimiter, queryBurstLimiter, async (req, res) => {
  const politicianId = String(req.query.senator ?? '').trim();
  const promiseText = String(req.query.promise ?? '').trim();

  // Corrections arrive as JSON. A malformed blob is rejected rather than
  // silently dropped: a correction that vanishes would show the user a result
  // computed from the classification they just told us was wrong.
  let corrections: Corrections | undefined;
  const rawCorrections = String(req.query.corrections ?? '').trim();
  if (rawCorrections) {
    try {
      corrections = JSON.parse(rawCorrections) as Corrections;
    } catch {
      res.status(400).json({
        error: { code: 'BAD_INPUT', message: 'corrections must be valid JSON.' },
      });
      return;
    }
  }

  if (!politicianId || !promiseText) {
    res.status(400).json({
      error: { code: 'BAD_INPUT', message: 'senator and promise are both required.' },
    });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Defeats proxy buffering, which would otherwise deliver the whole stream
    // in one lump at the end and make the reasoning panel pointless.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  let closed = false;
  req.on('close', () => {
    closed = true;
  });

  const emit = (event: StreamEvent) => {
    if (closed) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Keeps intermediaries from timing out a slow live query.
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': keep-alive\n\n');
  }, 15000);

  try {
    await runQuery(politicianId, promiseText, emit, corrections, {
      userAgent: String(req.headers['user-agent'] ?? '').slice(0, 500) || undefined,
      // Scopes the per-session replay cache. Opaque to the server: it is only
      // ever hashed into a cache key, never stored, logged or interpreted.
      // Bounded so a caller cannot push unbounded input into the hash.
      sessionKey: String(req.query.session ?? '').trim().slice(0, 128) || undefined,
      // Optional. Supplying it lets a bounded statement ("we vote next week")
      // resolve its window instead of halting with STATEMENT_DATE_REQUIRED.
      statementDate: String(req.query.date ?? '').trim() || undefined,
    });
  } finally {
    clearInterval(heartbeat);
    if (!closed) res.end();
  }
});

app.listen(config.port, () => {
  console.info(`\n  Receipts server  http://localhost:${config.port}`);
  console.info(`  mode: ${describeMode()}`);
  console.info(`  ${describeModels()}`);
  console.info(`  ${describeCredentials()}`);
  console.info(
    config.corsOrigins.length
      ? `  cors: allowlist [${config.corsOrigins.join(', ')}]`
      : '  cors: OPEN (any origin) — set CORS_ORIGIN before exposing this publicly.',
  );
  // Its own line: `trust proxy hops` is the value that silently inverts the
  // limiter into a global one when it is wrong, so it needs to be readable in
  // the deploy log rather than trailing off the end of the cors warning.
  console.info(`  ${describeTraceSinks()}`);
  console.info(
    `  rate limit: query ${config.rateLimit.queryPer15Min}/15min, ${config.rateLimit.queryPerDay}/day · ` +
      `read ${config.rateLimit.readPer15Min}/15min · health exempt · trust proxy hops ${config.rateLimit.trustProxyHops}`,
  );
  if (config.demoMode) {
    console.info('  DEMO MODE — interpretation and explanation are canned, and the UI says so.');
  }
  if (config.fixtureMode) {
    console.info('  FIXTURE MODE — matches come from fixtures, not the senator’s real record.');
  }
  if (!TAXONOMY_IS_COMPLETE) {
    console.info(
      '  NOTE: taxonomy.json is a partial snapshot. Export the full Approved Taxonomy sheet before trusting live retrieval.',
    );
  }
  console.info('');

  // Confirms the write path can actually open, and reports WHICH ROLE it
  // opened as. Deliberately non-fatal: persistence is best effort and must not
  // gate the service booting. But it says plainly what it found, because a
  // working connection as the WRONG role looks identical to a correct one
  // until someone audits the firewall months later.
  if (queryStore instanceof SupabaseQueryStore) {
    void queryStore.verifyConnection().then((r) => {
      if (!r.ok) {
        console.error(`  supabase: CONNECTION FAILED — ${r.error}`);
        console.error('  queries will NOT be persisted. The app still serves answers.');
        return;
      }
      console.info(`  supabase: connected as "${r.role}" to "${r.database}"`);
      if (!r.firewallIntact) {
        console.error(
          `  ⚠ WRONG ROLE: connected as "${r.role}", expected "receipts_app". ` +
            'The corpus firewall is only enforced when the app connects as the ' +
            'role that is actually walled. Fix DATABASE_URL before going live.',
        );
      }
    });
  }
});
