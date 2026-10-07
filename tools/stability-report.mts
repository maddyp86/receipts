// ===========================================================================
// stability-report — summarise tools/stability.mts runs (and, if present, the
// retrieval-only variants from tools/retrieval-variants.mts).
//
//   npx tsx tools/stability-report.mts <label> [--signoff]
//
// Per promise: verdict and band of every run; overlap of the retrieved top-10
// and of the admitted set across runs; every pair of runs classified
//   HARD       opposite verdicts (KEPT vs BROKE)
//   SOFT       a verdict vs NOT_DETERMINABLE
//   BAND-ONLY  same verdict, different band
// --signoff adds the most common verdict with its evidence rows and record
// sentences, for marking right or wrong.
// ===========================================================================

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { QUERIES, traceSteps } from './query-lib.mts';

const [label, ...rest] = process.argv.slice(2);
const signoff = rest.includes('--signoff');
const dir = fileURLToPath(new URL('../.data/query-runs/', import.meta.url));
const runs = JSON.parse(await readFile(`${dir}${label}.json`, 'utf8')) as Array<any>;

const jaccard = (a: string[], b: string[]) => {
  const A = new Set(a), B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const union = new Set([...A, ...B]).size;
  return union ? inter / union : 1;
};
/** Mean pairwise Jaccard, how many members are in every run, and in any. */
function overlap(sets: string[][]) {
  let sum = 0, n = 0;
  for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) { sum += jaccard(sets[i]!, sets[j]!); n++; }
  const all = sets.length ? sets.reduce((acc, s) => acc.filter((x) => s.includes(x)), [...new Set(sets[0])]) : [];
  const any = [...new Set(sets.flat())];
  return { mean: n ? sum / n : 1, inAll: all.length, inAny: any.length, any };
}
const pct = (x: number) => `${Math.round(x * 100)}%`;
const verdictOf = (r: any) => (r.decisions ? `${r.decisions.verdict}${r.decisions.band ? ` · ${r.decisions.band}` : ''}${r.decisions.nd_reason ? ` · ${r.decisions.nd_reason}` : ''}` : 'NO RESULT');

function classify(a: any, b: any): 'HARD' | 'SOFT' | 'BAND-ONLY' | null {
  const va = a.decisions?.verdict, vb = b.decisions?.verdict;
  if (!va || !vb) return 'SOFT';
  if (va === vb) return a.decisions.band === b.decisions.band ? null : 'BAND-ONLY';
  if (va === 'NOT_DETERMINABLE' || vb === 'NOT_DETERMINABLE') return 'SOFT';
  return 'HARD';
}

const totals = { HARD: 0, SOFT: 0, 'BAND-ONLY': 0 };
for (const q of QUERIES) {
  const rs = runs.filter((r) => r.id === q.id).sort((a, b) => a.rep - b.rep);
  if (!rs.length) continue;
  const pairs = { HARD: 0, SOFT: 0, 'BAND-ONLY': 0 } as Record<string, number>;
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
    const c = classify(rs[i], rs[j]);
    if (c) { pairs[c]!++; (totals as any)[c]++; }
  }
  const t = overlap(rs.map((r) => r.top10));
  const a = overlap(rs.map((r) => r.admitted));
  const texts = new Set(rs.map((r) => r.embedded_text)).size;
  const worst = pairs.HARD ? 'HARD' : pairs.SOFT ? 'SOFT' : pairs['BAND-ONLY'] ? 'BAND-ONLY' : 'STABLE';
  console.log(`\n## ${q.id} (${q.senator}) — ${worst}`);
  console.log(`  runs:      ${rs.map(verdictOf).join(' | ')}`);
  console.log(`  pairs:     HARD ${pairs.HARD} · SOFT ${pairs.SOFT} · BAND-ONLY ${pairs['BAND-ONLY']} (of ${(rs.length * (rs.length - 1)) / 2})`);
  console.log(`  embedded text: ${texts} distinct across ${rs.length} runs`);
  console.log(`  top-10:    mean pairwise overlap ${pct(t.mean)} · ${t.inAll} bills in every run · ${t.inAny} in any`);
  console.log(`  admitted:  mean pairwise overlap ${pct(a.mean)} · ${a.inAll} in every run · ${a.inAny} in any · sizes ${rs.map((r) => r.admitted.length).join('/')}`);

  if (signoff) {
    const counts = new Map<string, any[]>();
    for (const r of rs) counts.set(verdictOf(r), [...(counts.get(verdictOf(r)) ?? []), r]);
    const [modal, members] = [...counts.entries()].sort((x, y) => y[1].length - x[1].length)[0]!;
    // Among the modal runs, the one whose evidence set recurs most.
    const key = (r: any) => (r.decisions?.evidence ?? []).map((e: any) => e.action_uid).join(',');
    const byEv = new Map<string, any[]>();
    for (const r of members) byEv.set(key(r), [...(byEv.get(key(r)) ?? []), r]);
    const rep = [...byEv.values()].sort((x, y) => y.length - x.length)[0]![0];
    const titles = new Map<string, string>();
    for (const s of await traceSteps(rep.run_id)) if (s.stage === 'RETRIEVE') for (const c of s.output?.candidates ?? []) titles.set(c.action_uid, c.title);
    console.log(`  MOST COMMON: ${modal} (${members.length} of ${rs.length}); shown: run #${rep.rep} (${rep.run_id.slice(0, 8)}), whose evidence set recurs in ${byEv.get(key(rep))!.length}`);
    for (const e of rep.decisions?.evidence ?? []) {
      console.log(`    - ${e.action_uid} · ${titles.get(e.action_uid)?.slice(0, 90) ?? ''}`);
      console.log(`      effect ${e.bill_effect} · outcome ${e.outcome} · ${e.direction}${e.text_version ? ` · text ${e.text_version}` : ''}`);
      if (e.record) console.log(`      record: ${e.record}`);
    }
    for (const g of rep.decisions?.gated ?? []) console.log(`    - gated ${g.action_uid} · ${g.gate}`);
  }
}
console.log(`\nALL PROMISES: HARD ${totals.HARD} · SOFT ${totals.SOFT} · BAND-ONLY ${totals['BAND-ONLY']} disagreeing pairs`);

const variantsFile = `${dir}${label}-variants.json`;
if (existsSync(variantsFile)) {
  const vs = JSON.parse(await readFile(variantsFile, 'utf8')) as Array<any>;
  console.log(`\n# Retrieval only — current text vs deterministic variants`);
  const mismatched = vs.filter((v) => v.variant === 'current' && v.text_matches_stored === false).length;
  console.log(`(sanity: rebuilt current text differs from the stored text in ${mismatched} run(s))`);
  for (const q of QUERIES) {
    const by = (v: string) => vs.filter((x) => x.id === q.id && x.variant === v).map((x) => x.top10 as string[]);
    if (!by('current').length) continue;
    const cur = overlap(by('current'));
    console.log(`\n## ${q.id}`);
    for (const v of ['current', 'D1', 'D2']) {
      const o = overlap(by(v));
      const texts = new Set(vs.filter((x) => x.id === q.id && x.variant === v).map((x) => x.text)).size;
      const gained = o.any.filter((b) => !cur.any.includes(b));
      const lost = cur.any.filter((b) => !o.any.includes(b));
      console.log(
        `  ${v.padEnd(7)} texts ${texts} · top-10 overlap ${pct(o.mean)} · ${o.inAll} in every run · ${o.inAny} in any` +
          (v === 'current' ? '' : ` · vs current: +${gained.length} [${gained.join(' ')}] −${lost.length} [${lost.join(' ')}]`),
      );
    }
  }
}
