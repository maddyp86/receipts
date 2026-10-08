// ===========================================================================
// replay-judge — re-send recorded judge calls through today's judge code.
//
//   npx tsx tools/replay-judge.mts <query-runs label> [<label> …] [--id <promise id>] [--repeat N]
//
// Finds every JUDGE_MODEL step in the runs recorded under the labels, takes
// its exact user message from the trace, and calls the judge again through
// callJudgeModel — the production path — reporting stop reason, output
// tokens and grade. For measuring the judge's budget without re-running
// whole queries. LIVE AND PAID: one Sonnet call per replay (~$0.05).
// ===========================================================================

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { callJudgeModel } from '../packages/server/src/judge/judge.ts';
import { QueryTrace, withTrace } from '../packages/server/src/trace/Trace.ts';
import { config } from '../packages/server/src/config.ts';
import { costOf } from '../packages/server/src/trace/pricing.ts';

const TRACES = fileURLToPath(new URL('../.data/traces/', import.meta.url));
async function traceSteps(runId: string): Promise<Array<Record<string, any>>> {
  const file = (await readdir(TRACES)).find((f) => f.includes(runId));
  if (!file) throw new Error(`no local trace for ${runId}`);
  return (await readFile(`${TRACES}${file}`, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((o) => o.type === 'step');
}

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const labels = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1]!.startsWith('--')));
const only = opt('id');
const repeat = Number(opt('repeat') ?? 1);
const dir = fileURLToPath(new URL('../.data/query-runs/', import.meta.url));

const inputs: Array<{ from: string; message: string }> = [];
for (const label of labels) {
  for (const r of JSON.parse(await readFile(`${dir}${label}.json`, 'utf8')) as Array<any>) {
    if (only && r.id !== only) continue;
    for (const s of await traceSteps(r.run_id)) {
      if (s.stage === 'JUDGE_MODEL' && s.input?.user_message) inputs.push({ from: `${label} ${r.id} #${r.rep}`, message: s.input.user_message });
    }
  }
}
console.log(`${inputs.length} recorded judge inputs · max_tokens ${config.judge.maxTokens} · ${repeat} replay(s) each`);

let failures = 0, calls = 0, usd = 0, maxOut = 0;
for (const inp of inputs) {
  for (let k = 1; k <= repeat; k++) {
    const trace = new QueryTrace([], { politicianId: 'replay', promiseText: 'judge replay', meta: {} });
    const verdict = await withTrace(trace, () => callJudgeModel(inp.message, 'replay'));
    const step = trace.steps.find((s) => s.stage === 'JUDGE_MODEL');
    const out = step?.usage?.output_tokens ?? 0;
    usd += costOf(step?.model ?? null, step?.usage ?? null)?.usd ?? 0;
    maxOut = Math.max(maxOut, out);
    calls++;
    if (verdict.grade === 'ERROR') failures++;
    console.log(`${inp.from} · replay ${k}: ${step?.label ?? '?'} · out ${out}`);
  }
}
console.log(`\n${failures} of ${calls} replays returned no verdict · largest output ${maxOut} tokens · $${usd.toFixed(2)}`);
process.exit(0);
