// ===========================================================================
// run-queries — run a fixed list of queries end to end and record what each
// one decided, for comparing two versions of the code.
//
//   npx tsx tools/run-queries.mts <label>
//
// Writes .data/query-runs/<label>.json: per query, the trace run_id and the
// decisions — verdict, band, reason, every evidence row's effect / outcome /
// direction / record sentence / text version, every gated row's gate, the
// judge's disposition. `tools/trace-cost.mts` prices the runs from their
// traces; diffing two label files shows whether any answer changed.
//
// LIVE AND PAID: real models (~$0.24 a query, measured 2026-10-04) and the
// production database through DATABASE_URL — reads for enrichment, writes
// for persistence and traces, as any query does. It calls runQuery directly,
// so it does not go through the HTTP rate limiters or the global cap.
// ===========================================================================

import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { QueryResult, StreamEvent } from '@receipts/shared';
import { runQuery } from '../packages/server/src/orchestrator/loop.ts';
import { QUERIES as ALL, decisionsOf } from './query-lib.mts';

// The four promises #35 was measured on.
const QUERIES = ALL.slice(0, 4);


const label = process.argv[2];
if (!label) {
  console.error('usage: npx tsx tools/run-queries.mts <label>');
  process.exit(2);
}

const out: unknown[] = [];
for (const q of QUERIES) {
  const events: StreamEvent[] = [];
  const started = Date.now();
  await runQuery(q.senator, q.promise, (e) => events.push(e));
  const runId = events.find((e) => e.type === 'trace')?.run_id ?? null;
  const result = (events.find((e) => e.type === 'result') as { result?: QueryResult } | undefined)?.result ?? null;
  const error = events.find((e) => e.type === 'error') ?? null;
  const d = decisionsOf(result);
  console.log(
    `${q.id}: run ${runId} · ${d ? `${d.verdict}${d.band ? ` · ${d.band}` : ''}${d.nd_reason ? ` · ${d.nd_reason}` : ''}` : 'NO RESULT'}` +
      ` · ${d?.evidence.length ?? 0} evidence, ${d?.gated.length ?? 0} gated · ${Math.round((Date.now() - started) / 1000)}s`,
  );
  out.push({ id: q.id, run_id: runId, decisions: d, error });
}

const dir = fileURLToPath(new URL('../.data/query-runs/', import.meta.url));
await mkdir(dir, { recursive: true });
await writeFile(`${dir}${label}.json`, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote .data/query-runs/${label}.json`);
process.exit(0);
