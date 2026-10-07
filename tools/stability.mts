// ===========================================================================
// stability — run each promise N times and record what moved.
//
//   npx tsx tools/stability.mts <label> [--repeat 5] [--ids a,b] [--freeze-from <label>]
//
// --freeze-from replays, for every run of a promise, the classifier answer
// recorded in the FIRST run of that promise under <label>. The interpretation,
// and with it the embedded text, is then byte-identical across runs; what
// still moves comes from retrieval or the judges.
//
// Writes .data/query-runs/<label>.json after every run (a crash keeps what
// finished). Prices every run from its trace as it goes and stops before the
// cumulative spend passes SPEND_LIMIT_USD.
//
// LIVE AND PAID — see tools/run-queries.mts. Calls runQuery directly, so the
// HTTP rate limits and the global cap do not apply.
// ===========================================================================

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { QueryResult, StreamEvent } from '@receipts/shared';
import { runQuery } from '../packages/server/src/orchestrator/loop.ts';
import { costOf } from '../packages/server/src/trace/pricing.ts';
import { QUERIES, decisionsOf, retrievalFacts, traceSteps } from './query-lib.mts';

const SPEND_LIMIT_USD = 9;

const args = process.argv.slice(2);
const label = args[0];
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!label) {
  console.error('usage: npx tsx tools/stability.mts <label> [--repeat 5] [--ids a,b] [--freeze-from <label>]');
  process.exit(2);
}
const repeat = Number(opt('repeat') ?? 5);
const ids = opt('ids')?.split(',');
const freezeFrom = opt('freeze-from');
const dir = fileURLToPath(new URL('../.data/query-runs/', import.meta.url));
await mkdir(dir, { recursive: true });

// The classifier answer each promise is frozen to, from its first recorded run.
const frozen = new Map<string, Record<string, unknown>>();
if (freezeFrom) {
  const source = JSON.parse(await readFile(`${dir}${freezeFrom}.json`, 'utf8')) as Array<{ id: string; rep: number; classifier_input: Record<string, unknown> | null }>;
  for (const r of source) if (r.rep === 1 && r.classifier_input) frozen.set(r.id, r.classifier_input);
}

const queries = QUERIES.filter((q) => !ids || ids.includes(q.id));
const out: unknown[] = [];
let spent = 0;

for (const q of queries) {
  const stored = frozen.get(q.id);
  if (freezeFrom && !stored) throw new Error(`no stored classifier answer for ${q.id} in ${freezeFrom}`);
  for (let rep = 1; rep <= repeat; rep++) {
    const events: StreamEvent[] = [];
    await runQuery(q.senator, q.promise, (e) => events.push(e), undefined, stored ? { classifyFetcher: async () => structuredClone(stored) } : {});
    const runId = events.find((e) => e.type === 'trace')?.run_id ?? null;
    const result = (events.find((e) => e.type === 'result') as { result?: QueryResult } | undefined)?.result ?? null;
    const error = (events.find((e) => e.type === 'error') as { error?: unknown } | undefined)?.error ?? null;
    const facts = runId ? await retrievalFacts(runId) : null;
    let usd = 0;
    if (runId) for (const s of await traceSteps(runId)) usd += costOf(s.model, s.usage)?.usd ?? 0;
    spent += usd;
    const d = decisionsOf(result);
    console.log(
      `${q.id} #${rep}: ${d ? `${d.verdict}${d.band ? ` · ${d.band}` : ''}${d.nd_reason ? ` · ${d.nd_reason}` : ''}` : 'NO RESULT'}` +
        ` · top10 ${facts?.top10.length ?? 0} · admitted ${facts?.admitted.length ?? 0} · $${usd.toFixed(3)} (total $${spent.toFixed(2)})`,
    );
    out.push({
      id: q.id, rep, run_id: runId, decisions: d, error, usd,
      embedded_text: facts?.embedded_text ?? null,
      top10: facts?.top10 ?? [], admitted: facts?.admitted ?? [],
      classifier_input: facts?.classifier_input ?? stored ?? null,
    });
    await writeFile(`${dir}${label}.json`, JSON.stringify(out, null, 2) + '\n');
    if (spent > SPEND_LIMIT_USD) {
      console.error(`STOP: spend $${spent.toFixed(2)} passed $${SPEND_LIMIT_USD}.`);
      process.exit(3);
    }
  }
}
console.log(`done: ${out.length} runs, $${spent.toFixed(2)} · .data/query-runs/${label}.json`);
process.exit(0);
