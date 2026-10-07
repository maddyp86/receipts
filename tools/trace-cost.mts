// ===========================================================================
// trace-cost — price the model calls of recorded runs, per stage, and show the
// orchestrator's input per turn: uncached, written to cache, read from cache.
//
//   npx tsx tools/trace-cost.mts <label> [<label> …]
//
// Reads the run ids from .data/query-runs/<label>.json (tools/run-queries.mts)
// and their steps from the local trace files (.data/traces). Prices come from
// packages/server/src/trace/pricing.ts — one formula for every run, so a
// before and an after are priced the same way.
// ===========================================================================

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { costOf } from '../packages/server/src/trace/pricing.ts';
import type { TraceUsage } from '../packages/server/src/trace/Trace.ts';

const root = fileURLToPath(new URL('../.data/', import.meta.url));

interface Step { type: string; kind?: string; stage?: string; model?: string | null; usage?: TraceUsage | null; label?: string }

async function stepsOf(runId: string): Promise<Step[]> {
  const file = (await readdir(`${root}traces`)).find((f) => f.includes(runId));
  if (!file) throw new Error(`no local trace for ${runId}`);
  return (await readFile(`${root}traces/${file}`, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Step)
    .filter((s) => s.type === 'step' && s.kind === 'model');
}

const usd = (n: number) => `$${n.toFixed(4)}`;
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

for (const label of process.argv.slice(2)) {
  const runs = JSON.parse(await readFile(`${root}query-runs/${label}.json`, 'utf8')) as Array<{ id: string; run_id: string }>;
  const stage = new Map<string, { calls: number; usd: number; uncached: number; write: number; read: number; out: number }>();
  let total = 0;
  console.log(`\n=== ${label} — ${runs.length} queries ===`);
  for (const r of runs) {
    let runTotal = 0;
    const turns: string[] = [];
    for (const s of await stepsOf(r.run_id)) {
      const c = costOf(s.model, s.usage);
      if (!c) continue;
      const key = `${s.stage} (${s.model})`;
      const a = stage.get(key) ?? { calls: 0, usd: 0, uncached: 0, write: 0, read: 0, out: 0 };
      a.calls += 1; a.usd += c.usd; a.uncached += c.uncached_input_tokens; a.write += c.cache_write_tokens; a.read += c.cache_read_tokens; a.out += c.output_tokens;
      stage.set(key, a);
      runTotal += c.usd;
      if (s.stage === 'ORCHESTRATOR_TURN') {
        turns.push(`    turn ${turns.length + 1}: uncached ${k(c.uncached_input_tokens)} · cache write ${k(c.cache_write_tokens)} · cache read ${k(c.cache_read_tokens)} · out ${k(c.output_tokens)} · ${usd(c.usd)}`);
      }
    }
    total += runTotal;
    console.log(`  ${r.id} (${r.run_id.slice(0, 8)}): ${usd(runTotal)}`);
    for (const t of turns) console.log(t);
  }
  const n = runs.length;
  console.log(`\n  per query (average of ${n}):`);
  console.log(`  ${'stage'.padEnd(40)} ${'calls'.padStart(5)} ${'uncached in'.padStart(11)} ${'cache write'.padStart(11)} ${'cache read'.padStart(10)} ${'out'.padStart(7)} ${'cost'.padStart(9)}`);
  for (const [key, a] of [...stage.entries()].sort((x, y) => y[1].usd - x[1].usd)) {
    console.log(`  ${key.padEnd(40)} ${(a.calls / n).toFixed(1).padStart(5)} ${k(Math.round(a.uncached / n)).padStart(11)} ${k(Math.round(a.write / n)).padStart(11)} ${k(Math.round(a.read / n)).padStart(10)} ${k(Math.round(a.out / n)).padStart(7)} ${usd(a.usd / n).padStart(9)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(40)} ${''.padStart(5)} ${''.padStart(11)} ${''.padStart(11)} ${''.padStart(10)} ${''.padStart(7)} ${usd(total / n).padStart(9)}`);
}
