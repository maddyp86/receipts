// ===========================================================================
// eval — run the accuracy set (docs/eval/cases.json) through the real query
// path and check each answer against its signed-off outcome.
//
//   npm run eval                 every case
//   npm run eval -- 4 5          only cases whose id starts with 4- or 5-
//   npm run eval -- --explain .data/eval/<file>.json
//                                re-read a finished run's local traces and say
//                                where each missing bill went; free, no query
//
// LIVE AND PAID: real models and production data (mirror reads through
// DATABASE_URL, Pinecone retrieval), about $0.10–0.35 a case. It calls
// runQuery in this process, NOT the public API, so it counts toward neither
// the daily caps nor the IP limiter. Like any query it writes its trace and
// its app_queries row. Answer reuse is off, and there is no session key, so
// every case is a fresh run.
//
// Prints one table, the details of any failed check with the run's trace id
// (`npm run trace -- <run_id>`), and the run's cost priced from its traces.
// Writes the full report to .data/eval/<timestamp>.json. Exits 1 if any case
// fails.
// ===========================================================================

// Before anything reads config.
process.env.ANSWER_REUSE = 'false';

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { evidenceTallySentence, type QueryResult, type StreamEvent } from '@receipts/shared';

(globalThis as { React?: unknown }).React = React;

const { config } = await import('../packages/server/src/config.ts');
const { runQuery } = await import('../packages/server/src/orchestrator/loop.ts');
const { traceSinks, embedder } = await import('../packages/server/src/services.ts');
const { MemoryTraceSink } = await import('../packages/server/src/trace/TraceStore.ts');
const { costOf } = await import('../packages/server/src/trace/pricing.ts');
const { checkCase, verdictLabel } = await import('../packages/server/src/accuracy/checks.ts');
const { whereIsBill, classificationOf } = await import('../packages/server/src/accuracy/diagnose.ts');
type TraceStepLike = import('../packages/server/src/accuracy/diagnose.ts').TraceStepLike;
const { Verdict } = await import('../packages/web/src/components/Verdict.tsx');
type EvalCase = import('../packages/server/src/accuracy/checks.ts').EvalCase;
type CaseReport = import('../packages/server/src/accuracy/checks.ts').CaseReport;

const root = fileURLToPath(new URL('../', import.meta.url));

/** A listed bill's reading, with where it went when it is not in the evidence. */
function explainReadings(readings: Record<string, string>, steps: TraceStepLike[]): Record<string, string> {
  return Object.fromEntries(
    Object.entries(readings).map(([bill, how]) => [bill, how === 'not in evidence' ? `not in evidence: ${whereIsBill(bill, steps)}` : how]),
  );
}

// ---- --explain: diagnose a finished run from its local trace files ---------
if (process.argv[2] === '--explain') {
  const report = JSON.parse(await readFile(process.argv[3]!, 'utf8')) as {
    rows: Array<{ id: string; run_id: string | null; report: { readings: Record<string, string> } | null }>;
  };
  const files = await readdir(`${root}.data/traces`);
  for (const r of report.rows) {
    const f = r.run_id ? files.find((x) => x.includes(r.run_id!)) : undefined;
    if (!f) {
      console.log(`${r.id}: no local trace`);
      continue;
    }
    const steps = (await readFile(`${root}.data/traces/${f}`, 'utf8')).split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as TraceStepLike & { type?: string }).filter((s) => s.type === 'step');
    console.log(`${r.id} · run ${r.run_id}\n  classified as: ${classificationOf(steps)}`);
    for (const [bill, how] of Object.entries(explainReadings(r.report?.readings ?? {}, steps))) console.log(`  ${bill}: ${how}`);
  }
  process.exit(0);
}

if (config.answerReuse.enabled) throw new Error('answer reuse must be off for an eval run');
if (config.demoMode || config.fixtureMode) throw new Error('eval runs against live models and production data; demo/fixture mode is on');

const { cases } = JSON.parse(await readFile(`${root}docs/eval/cases.json`, 'utf8')) as { cases: EvalCase[] };
const only = process.argv.slice(2);
const selected = only.length ? cases.filter((c) => only.some((p) => c.id.startsWith(`${p}-`) || c.id === p)) : cases;

const sink = new MemoryTraceSink();
traceSinks.push(sink);

// The query vector each case searched with, kept for the rank check
// (tools/rank-check.mts): the same vector, a wider search, no re-embedding.
let lastVector: number[] | null = null;
const embed = embedder.embed.bind(embedder);
(embedder as { embed: typeof embed }).embed = async (text: string) => {
  const r = await embed(text);
  if (r.ok) lastVector = r.data;
  return r;
};

const text = (html: string) =>
  html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

interface Row {
  id: string;
  run_id: string | null;
  usd: number;
  seconds: number;
  verdict: string;
  band: string;
  count_line: string;
  classification: string;
  report: CaseReport | null;
  error: string | null;
  vector: number[] | null;
}

const rows: Row[] = [];
for (const c of selected) {
  const events: StreamEvent[] = [];
  const started = Date.now();
  lastVector = null;
  process.stdout.write(`${c.id} … `);
  try {
    await runQuery(c.senator, c.statement, (e) => events.push(e));
  } catch (err) {
    events.push({ type: 'error', error: { code: 'INTERNAL', message: String(err), recoverable: false } } as StreamEvent);
  }
  const runId = events.find((e) => e.type === 'trace')?.run_id ?? null;
  const result = (events.find((e) => e.type === 'result') as { result?: QueryResult } | undefined)?.result ?? null;
  const other = events.find((e) => e.type === 'error' || e.type === 'halt' || e.type === 'uncached');

  // The run's cost, from its own trace.
  let usd = 0;
  const record = runId ? sink.runs.get(runId) : undefined;
  for (const s of record?.steps ?? []) usd += costOf(s.model, s.usage)?.usd ?? 0;

  let report: CaseReport | null = null;
  if (result) {
    const card = text(renderToStaticMarkup(React.createElement(Verdict, { result, traceId: runId, feedbackAvailable: true })));
    report = checkCase(c, result, card);
    report.readings = explainReadings(report.readings, record?.steps ?? []);
  }
  const classification = classificationOf(record?.steps ?? []);
  const row: Row = {
    id: c.id,
    run_id: runId,
    usd,
    seconds: Math.round((Date.now() - started) / 1000),
    verdict: result ? verdictLabel(result) : `NO RESULT (${other ? other.type : 'nothing'})`,
    band: result?.scored.band ?? '—',
    count_line: result ? (evidenceTallySentence(result) ?? '—') : '—',
    classification,
    report,
    error: other && !result ? JSON.stringify(other).slice(0, 300) : null,
    vector: lastVector,
  };
  rows.push(row);
  console.log(`${row.report?.pass ? 'PASS' : 'FAIL'} · ${row.verdict} · $${usd.toFixed(3)} · ${row.seconds}s · run ${runId}`);
}

// ---- The table -------------------------------------------------------------
const mark = (ok: boolean | undefined) => (ok === undefined ? '—' : ok ? 'pass' : '**FAIL**');
const cell = (s: string) => s.replace(/\|/g, '\\|');
const lines: string[] = [
  '| case | verdict | band | count line | verdict ✓ | must-have ✓ | direction ✓ | forbidden ✓ | extra bills found |',
  '|---|---|---|---|---|---|---|---|---|',
];
for (const r of rows) {
  lines.push(
    `| ${r.id} | ${cell(r.verdict)} | ${r.band} | ${cell(r.count_line)} | ${mark(r.report?.verdict.pass)} | ${mark(r.report?.must_have.pass)} | ` +
      `${mark(r.report?.direction.pass)} | ${mark(r.report?.forbidden.pass)} | ${cell(r.report?.extra_bills.join(', ') || '—')} |`,
  );
}
const total = rows.reduce((a, r) => a + r.usd, 0);
const passed = rows.filter((r) => r.report?.pass).length;

console.log(`\n${lines.join('\n')}`);
console.log(`\n${passed} of ${rows.length} cases pass · run cost $${total.toFixed(2)} (priced from the traces, trace/pricing.ts)`);

console.log('\nHow each listed bill was read:');
for (const r of rows) {
  if (!r.report) continue;
  const readings = Object.entries(r.report.readings).map(([b, how]) => `${b} ${how}`);
  console.log(`  ${r.id} (classified as ${r.classification}): ${readings.join('; ') || '—'}${r.report.flags.length ? ` · FLAG: ${r.report.flags.join('; ')}` : ''}`);
}

const failed = rows.filter((r) => !r.report?.pass);
if (failed.length) {
  console.log('\nFailures (trace: npm run trace -- <run_id>):');
  for (const r of failed) {
    console.log(`  ${r.id} · run ${r.run_id}`);
    if (r.error) console.log(`    ${r.error}`);
    if (!r.report) continue;
    for (const [name, check] of Object.entries({ verdict: r.report.verdict, 'must-have': r.report.must_have, direction: r.report.direction, forbidden: r.report.forbidden })) {
      if (!check.pass) console.log(`    ${name}: ${check.detail.join('; ')}`);
    }
  }
}

const dir = `${root}.data/eval/`;
await mkdir(dir, { recursive: true });
const file = `${dir}${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
await writeFile(file, JSON.stringify({ cases: selected, rows, total_usd: total }, null, 2) + '\n');
console.log(`\nwrote ${file.replace(root, '')}`);
process.exit(failed.length ? 1 : 0);
