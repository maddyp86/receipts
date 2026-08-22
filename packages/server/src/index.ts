import express from 'express';
import cors from 'cors';
import type { StreamEvent } from '@receipts/shared';
import { config, describeCredentials, describeMode, describeModels } from './config.js';
import { senatorCache } from './data/SenatorCache.js';
import { runQuery } from './orchestrator/loop.js';
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
    await runQuery(politicianId, promiseText, emit, corrections);
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
});
