import express from 'express';
import cors from 'cors';
import type { StreamEvent } from '@receipts/shared';
import { config, describeCredentials, describeMode, describeModels } from './config.js';
import { senatorCache } from './data/SenatorCache.js';
import { runQuery } from './orchestrator/loop.js';
import { queryStore } from './services.js';
import { SupabaseQueryStore } from './data/SupabaseQueryStore.js';
import { primaryIssues, subIssuesFor } from './embeddings/taxonomy.js';
import type { Corrections } from '@receipts/shared';
import { actionStore, embedder } from './services.js';
import { TAXONOMY_IS_COMPLETE } from './embeddings/taxonomy.js';

const app = express();
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
app.get('/api/query', async (req, res) => {
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
