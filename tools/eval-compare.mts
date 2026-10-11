// ===========================================================================
// eval-compare — two finished eval runs, case by case.
//
//   npx tsx tools/eval-compare.mts .data/eval/<A>.json .data/eval/<B>.json
//
// Gate G3 (docs/v2/plan.md): the same cases run once per store. Free: it only
// reads the two reports `npm run eval` wrote. For each case it prints pass,
// verdict and band from both runs and, where they differ, what differed:
// the classification, the count line, and how each listed bill was read.
// ===========================================================================

import { readFile } from 'node:fs/promises';

interface Row {
  id: string;
  run_id: string | null;
  verdict: string | null;
  band: string | null;
  count_line: string | null;
  classification: string | null;
  error: string | null;
  report: { pass: boolean; readings: Record<string, string> } | null;
}

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error('usage: npx tsx tools/eval-compare.mts .data/eval/<A>.json .data/eval/<B>.json');
  process.exit(2);
}
const load = async (p: string) => (JSON.parse(await readFile(p, 'utf8')) as { rows: Row[]; total_usd?: number });
const A = await load(a);
const B = await load(b);
const byId = new Map(B.rows.map((r) => [r.id, r]));

const pass = (r: Row | undefined) => (r?.error ? 'error' : r?.report?.pass ? 'pass' : 'FAIL');
let same = 0;
let samePass = 0;

console.log(`A: ${a} ($${(A.total_usd ?? 0).toFixed(2)})\nB: ${b} ($${(B.total_usd ?? 0).toFixed(2)})\n`);
console.log('| case | A | B | verdict A | verdict B | band A → B | what differed |');
console.log('|---|---|---|---|---|---|---|');
for (const ra of A.rows) {
  const rb = byId.get(ra.id);
  const diffs: string[] = [];
  if (!rb) diffs.push('missing from B');
  else {
    if (ra.classification !== rb.classification) diffs.push(`classification: ${ra.classification} → ${rb.classification}`);
    if (ra.count_line !== rb.count_line) diffs.push(`count: "${ra.count_line ?? '—'}" → "${rb.count_line ?? '—'}"`);
    const ka = ra.report?.readings ?? {};
    const kb = rb.report?.readings ?? {};
    for (const bill of new Set([...Object.keys(ka), ...Object.keys(kb)])) {
      if (ka[bill] !== kb[bill]) diffs.push(`${bill}: ${ka[bill] ?? '—'} → ${kb[bill] ?? '—'}`);
    }
    if (ra.error !== rb.error) diffs.push(`error: ${ra.error ?? '—'} → ${rb.error ?? '—'}`);
  }
  const identical = rb && ra.verdict === rb.verdict && ra.band === rb.band && !diffs.length;
  if (identical) same += 1;
  if (pass(ra) === pass(rb)) samePass += 1;
  console.log(
    `| ${ra.id} | ${pass(ra)} | ${pass(rb)} | ${ra.verdict ?? '—'} | ${rb?.verdict ?? '—'} | ${ra.band ?? '—'} → ${rb?.band ?? '—'} | ${diffs.join(' · ') || (identical ? '—' : '')} |`,
  );
}
const passes = (x: { rows: Row[] }) => x.rows.filter((r) => pass(r) === 'pass').length;
console.log(`\nPass rate: A ${passes(A)}/${A.rows.length} · B ${passes(B)}/${B.rows.length}`);
console.log(`Same pass/fail: ${samePass}/${A.rows.length} · identical verdict, band, count and readings: ${same}/${A.rows.length}`);
