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
//
//   npx tsx tools/rank-check.mts --compare .data/eval/<run>.json [topK]
//
// GATE G2 (docs/v2/plan.md). The same saved vectors against BOTH stores,
// Pinecone and Supabase `core`, whatever ACTION_STORE says. topK defaults to
// the query path's own. Per case: the same bills, in the same order, with
// scores equal to three decimals, comparing each bill's best rank. For bills
// both return, it also names the result fields that differ, which is where a
// G3 difference would come from (the corrected votes, for instance).
// Retrieval only; it needs DATABASE_URL for the Supabase side.
// ===========================================================================

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const { config } = await import('../packages/server/src/config.ts');
const { actionStore } = await import('../packages/server/src/services.ts');
type EvalCase = import('../packages/server/src/accuracy/checks.ts').EvalCase;
type MatchedAction = import('@receipts/shared').MatchedAction;

if (config.fixtureMode) throw new Error('rank-check needs live Pinecone; fixture mode is on');

const root = fileURLToPath(new URL('../', import.meta.url));

if (process.argv[2] === '--compare') {
  await compareStores(process.argv[3], process.argv[4]);
  process.exit(0);
}

const [reportPath, k] = process.argv.slice(2);
if (!reportPath) {
  console.error('usage: npx tsx tools/rank-check.mts [--compare] .data/eval/<run>.json [topK]');
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

// ---- G2: both stores, same vectors ----------------------------------------

/** Fields compared for a bill both stores return. Score is compared separately. */
const FIELDS = [
  'vote', 'cloture_vote', 'passage_vote', 'action_type', 'is_sponsor', 'is_cosponsor',
  'title', 'summary', 'intended_effects', 'mechanisms', 'affected_stakeholders',
  'primary_issue', 'sub_issue', 'bill_keywords', 'congress', 'source_url', 'action_uid',
] as const;

/** Every returned action, best first, one entry per bill at its best rank. */
function byBill(res: { matches: MatchedAction[]; nearMisses: Array<{ action_uid: string; bill_id: string; score: number }> }) {
  const all = [
    ...res.matches.map((m) => ({ bill: m.bill_id.trim().toLowerCase(), score: m.score, action: m as MatchedAction | null })),
    ...res.nearMisses.map((m) => ({ bill: m.bill_id.trim().toLowerCase(), score: m.score, action: null as MatchedAction | null })),
  ].sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  return all.filter((r) => (seen.has(r.bill) ? false : (seen.add(r.bill), true)));
}

async function compareStores(path: string | undefined, k: string | undefined): Promise<void> {
  if (!path) {
    console.error('usage: npx tsx tools/rank-check.mts --compare .data/eval/<run>.json [topK]');
    process.exit(2);
  }
  if (!config.database.url) throw new Error('--compare needs DATABASE_URL for the Supabase store');
  const { PineconeActionStore } = await import('../packages/server/src/data/PineconeActionStore.ts');
  const { SupabaseActionStore } = await import('../packages/server/src/data/SupabaseActionStore.ts');
  const pinecone = new PineconeActionStore();
  const supabase = new SupabaseActionStore();
  const topK = Number(k ?? config.retrieval.topK);

  const report = JSON.parse(await readFile(path, 'utf8')) as {
    cases: EvalCase[];
    rows: Array<{ id: string; vector?: number[] | null }>;
  };
  const cases = new Map(report.cases.map((c) => [c.id, c]));
  let same = 0;
  let compared = 0;

  console.log(`G2 · top ${topK} per case · bills compared at their best rank\n`);
  console.log('| case | senator | bills | same bills | same order | scores equal (3 dp) | differences |');
  console.log('|---|---|---|---|---|---|---|');
  for (const row of report.rows) {
    const c = cases.get(row.id);
    if (!c) continue;
    if (!row.vector) {
      console.log(`| ${row.id} | ${c.senator} | — | — | — | — | no saved vector |`);
      continue;
    }
    const q = { politicianId: c.senator, vector: row.vector, queryText: '', topK };
    const [p, s] = await Promise.all([pinecone.search(q), supabase.search(q)]);
    if (!p.ok || !s.ok) {
      console.log(`| ${row.id} | ${c.senator} | — | — | — | — | search failed: ${!p.ok ? `pinecone ${p.error.message}` : ''} ${!s.ok ? `supabase ${s.error.message}` : ''} |`);
      continue;
    }
    compared += 1;
    const pb = byBill(p.data);
    const sb = byBill(s.data);
    const pSet = new Set(pb.map((r) => r.bill));
    const sSet = new Set(sb.map((r) => r.bill));
    const onlyP = pb.filter((r) => !sSet.has(r.bill)).map((r) => `${r.bill} (${r.score.toFixed(3)})`);
    const onlyS = sb.filter((r) => !pSet.has(r.bill)).map((r) => `${r.bill} (${r.score.toFixed(3)})`);
    const sameBills = onlyP.length === 0 && onlyS.length === 0;
    const sameOrder = sameBills && pb.every((r, i) => r.bill === sb[i]!.bill);
    const sMap = new Map(sb.map((r) => [r.bill, r]));
    const scoreDiffs: string[] = [];
    const fieldDiffs: string[] = [];
    for (const r of pb) {
      const t = sMap.get(r.bill);
      if (!t) continue;
      if (r.score.toFixed(3) !== t.score.toFixed(3)) scoreDiffs.push(`${r.bill} ${r.score.toFixed(4)}→${t.score.toFixed(4)}`);
      if (r.action && t.action) {
        const changed = FIELDS.filter((f) => JSON.stringify(r.action![f]) !== JSON.stringify(t.action![f]));
        if (changed.length) fieldDiffs.push(`${r.bill}: ${changed.map((f) => (f.endsWith('vote') ? `${f} ${r.action![f]}→${t.action![f]}` : f)).join(', ')}`);
      }
    }
    if (sameBills && sameOrder && !scoreDiffs.length) same += 1;
    const notes = [
      onlyP.length ? `only Pinecone: ${onlyP.join(', ')}` : '',
      onlyS.length ? `only Supabase: ${onlyS.join(', ')}` : '',
      sameBills && !sameOrder ? `order: P ${pb.map((r) => r.bill).join(' ')} / S ${sb.map((r) => r.bill).join(' ')}` : '',
      scoreDiffs.length ? `scores: ${scoreDiffs.join('; ')}` : '',
      fieldDiffs.length ? `fields: ${fieldDiffs.join('; ')}` : '',
    ].filter(Boolean);
    console.log(
      `| ${row.id} | ${c.senator} | ${pb.length}/${sb.length} | ${sameBills ? 'yes' : 'NO'} | ${sameOrder ? 'yes' : 'NO'} | ${scoreDiffs.length ? 'NO' : 'yes'} | ${notes.join(' · ') || '—'} |`,
    );
  }
  console.log(`\nIdentical search results: ${same} of ${compared} cases compared.`);
  await supabase.close();
}
