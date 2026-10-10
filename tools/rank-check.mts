// ===========================================================================
// rank-check — where each must-have bill ranks in a wider search, using the
// query vectors an eval run actually searched with.
//
//   npx tsx tools/rank-check.mts .data/eval/<run>.json [topK=100]
//
// Retrieval only: Pinecone, with each case's saved query vector (written by
// `npm run eval`), for that case's senator. No embedding call, no model call,
// no database. The query path's own topK is untouched; this asks how far down
// the list a bill sits, which a topK-10 search cannot say.
//
// Vectors are per ACTION, so a bill with several recorded actions appears more
// than once; a bill's rank is its best-ranked action.
// ===========================================================================

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const { config } = await import('../packages/server/src/config.ts');
const { actionStore } = await import('../packages/server/src/services.ts');
type EvalCase = import('../packages/server/src/accuracy/checks.ts').EvalCase;

if (config.fixtureMode) throw new Error('rank-check needs live Pinecone; fixture mode is on');

const root = fileURLToPath(new URL('../', import.meta.url));
const [reportPath, k] = process.argv.slice(2);
if (!reportPath) {
  console.error('usage: npx tsx tools/rank-check.mts .data/eval/<run>.json [topK]');
  process.exit(2);
}
const topK = Number(k ?? 100);
const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
  cases: EvalCase[];
  rows: Array<{ id: string; run_id: string | null; vector?: number[] | null }>;
};
const cases = new Map(report.cases.map((c) => [c.id, c]));
const norm = (b: string) => b.trim().toLowerCase();

const buckets = { '1–10': 0, '11–20': 0, '21–30': 0, [`31–${topK}`]: 0, [`not in top ${topK}`]: 0 } as Record<string, number>;
const bucketOf = (rank: number | null) =>
  rank === null ? `not in top ${topK}` : rank <= 10 ? '1–10' : rank <= 20 ? '11–20' : rank <= 30 ? '21–30' : `31–${topK}`;

console.log(`| case | must-have bill | rank (of ${topK}) | score | trace |`);
console.log('|---|---|---|---|---|');
for (const row of report.rows) {
  const c = cases.get(row.id);
  if (!c) continue;
  const bills = c.must_have.flatMap((m) => ('bill' in m ? [m.bill] : m.any_of));
  if (!bills.length) continue;
  if (!row.vector) {
    for (const b of bills) console.log(`| ${row.id} | ${b} | no saved vector (the run never embedded) | — | ${row.run_id ?? '—'} |`);
    continue;
  }
  const res = await actionStore.search({ politicianId: c.senator, vector: row.vector, queryText: '', topK });
  if (!res.ok) {
    console.log(`| ${row.id} | — | search failed: ${res.error.message} | — | ${row.run_id} |`);
    continue;
  }
  // Every returned action, above and below the retrieval floor, best first.
  const ranked = [
    ...res.data.matches.map((m) => ({ bill: norm(String(m.bill_id)), score: m.score })),
    ...res.data.nearMisses.map((m) => ({ bill: norm(m.bill_id), score: m.score })),
  ].sort((a, b) => b.score - a.score);
  for (const b of bills) {
    const i = ranked.findIndex((r) => r.bill === norm(b));
    const rank = i < 0 ? null : i + 1;
    buckets[bucketOf(rank)]! += 1;
    console.log(`| ${row.id} | ${b} | ${rank ?? `not in top ${topK}`} | ${i < 0 ? '—' : ranked[i]!.score.toFixed(3)} | ${row.run_id} |`);
  }
}

console.log('\nMust-have bills by rank:');
for (const [range, n] of Object.entries(buckets)) console.log(`  ${range.padEnd(16)} ${n}`);
process.exit(0);
