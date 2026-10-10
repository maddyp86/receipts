// ===========================================================================
// replay-floor — re-score a finished eval run at other evidence floors, from
// its saved traces. No model calls, no network, no database.
//
//   npx tsx tools/replay-floor.mts .data/eval/<run>.json [0.575 0.55 0.525 0.50]
//
// What it replays: `scoreMatches`, the whole deterministic step after the
// evaluator — the floor, the verdict table, the split-vote cap, contract 3,
// withholding and the band. Its inputs come from the run's trace: the SCORE
// step's rows (effect, votes, confidence, flags, score), with titles and
// missing fields from RETRIEVE, text-version status from TEXT_VERSION and
// record-read failures from ENRICHMENT.
//
// What it cannot replay: anything a model decides. Rows the relevance check
// dropped stay dropped (the floor never reached them), the evaluator's reading
// of each bill is what it was, and a BROKE would go to the judge, which is
// reported as "judge not replayed" rather than guessed.
//
// The floor is changed in THIS process only, on the imported constant. The
// code's floor is untouched.
// ===========================================================================

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { evidenceTallySentence, type QueryResult } from '@receipts/shared';
import { SIMILARITY } from '../packages/server/src/scoring/config.ts';
import { scoreMatches, type ScorableMatch } from '../packages/server/src/scoring/score.ts';
import { ENRICHMENT_GAP_OF } from '../packages/server/src/evaluation/enrichment.ts';
import { checkCase, verdictLabel, type EvalCase } from '../packages/server/src/accuracy/checks.ts';
import { Verdict } from '../packages/web/src/components/Verdict.tsx';

(globalThis as { React?: unknown }).React = React;

type Step = { type?: string; stage?: string; subject?: string | null; input?: any; output?: any };

const root = fileURLToPath(new URL('../', import.meta.url));
const [reportPath, ...floorArgs] = process.argv.slice(2);
if (!reportPath) {
  console.error('usage: npx tsx tools/replay-floor.mts .data/eval/<run>.json [floors…]');
  process.exit(2);
}
const floors = (floorArgs.length ? floorArgs : ['0.575', '0.55', '0.525', '0.50']).map(Number);
const BASE = SIMILARITY.STRONG;
const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
  cases: EvalCase[];
  rows: Array<{ id: string; run_id: string | null }>;
};
const casesById = new Map(report.cases.map((c) => [c.id, c]));
// The case definitions are read from the CURRENT cases file when they exist,
// so a corrected case is replayed against its corrected expectations.
try {
  const current = JSON.parse(await readFile(`${root}docs/eval/cases.json`, 'utf8')) as { cases: EvalCase[] };
  for (const c of current.cases) casesById.set(c.id, c);
} catch { /* the report's copy stands */ }

const files = await readdir(`${root}.data/traces`);
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const WORD = { keeps: 'consistent', breaks: 'runs_counter', neutral: 'not_counted' } as const;

export interface Replay {
  floor: number;
  verdict: string;
  band: string;
  count_line: string;
  checks: { verdict: string; must_have: string; direction: string; forbidden: string };
  pass: boolean | null;
  newly_admitted: string[];
  notes: string[];
}

function inputsOf(steps: Step[]) {
  const score = steps.find((s) => s.stage === 'SCORE');
  if (!score) return null;
  const cands = new Map<string, any>(
    steps.filter((s) => s.stage === 'RETRIEVE').flatMap((s) => s.output?.candidates ?? []).map((c: any) => [c.action_uid, c]),
  );
  const textStatus = new Map<string, string>(
    steps.filter((s) => s.stage === 'TEXT_VERSION' && s.subject).map((s) => [s.subject!, s.output?.status]),
  );
  const relevance = new Map<string, string>(
    steps.filter((s) => s.stage === 'RELEVANCE' && s.subject).map((s) => [s.subject!, s.output?.parsed?.verdict ?? '?']),
  );
  const failures: Array<{ part: string }> = steps.find((s) => s.stage === 'ENRICHMENT')?.output?.failures ?? [];
  const matches: ScorableMatch[] = (score.input.matches as any[]).map((m) => {
    const c = cands.get(m.action_uid) ?? {};
    const status = textStatus.get(m.action_uid);
    return {
      ...m,
      title: c.title ?? m.bill_id,
      summary: '', intended_effects: '', mechanisms: '', bill_keywords: [], primary_issue: c.primary_issue ?? '', sub_issue: c.sub_issue ?? '',
      source_url: '', action_type: '',
      missing_fields: c.missing_fields ?? [],
      bill_effect_reasoning: '',
      ...(status ? { text_version: { status } } : {}),
    } as ScorableMatch;
  });
  const cls = steps.find((s) => s.stage === 'CLASSIFY')?.output?.interpretation ?? {};
  const senator = steps.find((s) => s.stage === 'RESOLVE_SENATOR')?.output?.senator ??
    steps.find((s) => s.stage === 'RESOLVE_SENATOR')?.output?.data?.senator;
  return {
    input: {
      promise_type: score.input.promise_type,
      statement_type: score.input.statement_type,
      is_evaluable: score.input.is_evaluable,
      gated_count: score.input.gated_count,
      matches,
      enrichment_gaps: [...new Set(failures.map((f) => (ENRICHMENT_GAP_OF as any)[f.part]).filter(Boolean))],
    },
    relevance,
    interpretation: { statement_type: cls.statement_type ?? score.input.statement_type, provenance: cls.provenance ?? 'default' },
    senatorName: senator?.name as string | undefined,
  };
}

export async function replayCase(c: EvalCase, runId: string, opts: { forceEvaluable?: boolean } = {}): Promise<Replay[] | string> {
  const f = files.find((x) => x.includes(runId));
  if (!f) return 'no local trace file for this run';
  const steps = (await readFile(`${root}.data/traces/${f}`, 'utf8')).split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as Step).filter((s) => s.type === 'step');
  const got = inputsOf(steps);
  if (!got) return 'the trace has no SCORE step (the run never reached scoring)';
  const name = got.senatorName ?? (c.senator === 'S000148' ? 'Charles E. Schumer' : c.senator === 'T000250' ? 'John Thune' : c.senator);
  const out: Replay[] = [];
  for (const floor of floors) {
    (SIMILARITY as { STRONG: number }).STRONG = floor;
    try {
      const scored = scoreMatches({ ...got.input, ...(opts.forceEvaluable ? { is_evaluable: true } : {}) });
      const result = {
        senator: { politician_id: c.senator, name, cached: true },
        interpretation: { raw: c.statement, restated: c.statement, primary_issue: '', sub_issue: '', stance: '', promise_type: 'policy', ...got.interpretation },
        scored,
        explanation: { why: '', connectors: {}, confidence: 0 },
        gated: [],
      } as unknown as QueryResult;
      const card = text(renderToStaticMarkup(React.createElement(Verdict, { result, traceId: runId, feedbackAvailable: true })));
      const rep = checkCase(c, result, card);
      const notes: string[] = [];
      const needsJudge = scored.verdict === 'BROKE';
      if (needsJudge) notes.push('BROKE reached: the judge would run; not replayed');
      const fmt = (ok: boolean) => (ok ? 'pass' : '**FAIL**');
      const verdictCheck = needsJudge && c.verdict.some((v) => v === 'BROKE_JUDGED' || v === 'WITHHELD_AFTER_REVIEW')
        ? 'judge decides' : fmt(rep.verdict.pass);
      const newly = scored.evidence
        .filter((e) => e.score < BASE && e.score >= floor)
        .map((e) => `${e.bill_id} ${e.score.toFixed(3)} · relevance ${got.relevance.get(e.action_uid) ?? '—'} · effect ${e.bill_effect} · ${WORD[e.direction]} · “${(e.title ?? '').slice(0, 90)}${(e.title ?? '').length > 90 ? '…' : ''}”`);
      out.push({
        floor,
        verdict: verdictLabel(result) + (needsJudge ? ' (pre-judge)' : ''),
        band: scored.band ?? '—',
        count_line: evidenceTallySentence(result) ?? '—',
        // A pre-judge BROKE has, by construction, no judge disposition yet:
        // BROKE_WITHOUT_JUDGE is the judge's to settle, not a replay finding.
        checks: {
          verdict: verdictCheck, must_have: fmt(rep.must_have.pass), direction: fmt(rep.direction.pass),
          forbidden: needsJudge && rep.forbidden.detail.every((d) => d.startsWith('BROKE published without'))
            ? (rep.forbidden.detail.length ? 'judge decides' : 'pass')
            : fmt(rep.forbidden.pass),
        },
        pass: verdictCheck === 'judge decides' ? null : rep.pass,
        newly_admitted: newly,
        notes: [...notes, ...rep.verdict.detail.slice(1), ...rep.must_have.detail, ...rep.direction.detail,
          ...rep.forbidden.detail.filter((d) => !(needsJudge && d.startsWith('BROKE published without')))],
      });
    } finally {
      (SIMILARITY as { STRONG: number }).STRONG = BASE;
    }
  }
  return out;
}

// ---- Report ----------------------------------------------------------------
const cell = (s: string) => s.replace(/\|/g, '\\|');
console.log('| case | floor | verdict | band | count line | verdict ✓ | must-have ✓ | direction ✓ | forbidden ✓ |');
console.log('|---|---|---|---|---|---|---|---|---|');
const admitted: string[] = [];
const notesOut: string[] = [];
for (const row of report.rows) {
  const c = casesById.get(row.id);
  if (!c || !row.run_id) continue;
  const r = await replayCase(c, row.run_id);
  if (typeof r === 'string') {
    console.log(`| ${row.id} | — | not replayable: ${r} | | | | | | |`);
    continue;
  }
  for (const x of r) {
    console.log(`| ${row.id} | ${x.floor} | ${cell(x.verdict)} | ${x.band} | ${cell(x.count_line)} | ${x.checks.verdict} | ${x.checks.must_have} | ${x.checks.direction} | ${x.checks.forbidden} |`);
    for (const n of x.newly_admitted) admitted.push(`${row.id} @ ${x.floor}: ${n}`);
    if (x.notes.length && x.pass !== true) notesOut.push(`${row.id} @ ${x.floor}: ${x.notes.join('; ')}`);
  }
}
console.log('\nNewly admitted versus 0.575 (score · relevance · effect · direction · title):');
for (const a of admitted) console.log(`  ${a}`);
console.log('\nWhy checks did not pass:');
for (const n of notesOut) console.log(`  ${n}`);

// Case 1 only: what scoring would do if the statement had been judged evaluable.
const c1 = report.rows.find((r) => r.id.startsWith('1-'));
if (c1?.run_id && casesById.get(c1.id)) {
  const r = await replayCase(casesById.get(c1.id)!, c1.run_id, { forceEvaluable: true });
  if (typeof r !== 'string') {
    console.log('\nCase 1 counterfactual — the same rows with is_evaluable forced true:');
    for (const x of r) console.log(`  ${x.floor}: ${x.verdict} · ${x.band} · ${x.count_line}`);
  }
}
