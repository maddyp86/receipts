import { describe, expect, it } from 'vitest';
import { answerFollowup, buildFollowupContext } from './followup.js';
import { MemoryTraceSink, type TraceRecord } from '../trace/TraceStore.js';
import type { TraceStep } from '../trace/Trace.js';

// ===========================================================================
// Explain-only follow-ups.
//
// What is pinned: the context is built from the parsed findings, not the raw
// prompts; the answer passes the same wording guard as the explanation and is
// retried once with the problems; a second failure is refused, never
// rendered; and every question leaves a trace run pointing at the original.
// ===========================================================================

const step = (over: Partial<TraceStep>): TraceStep => ({
  run_id: 'r', seq: 0, at: '2026-09-20T00:00:00Z', duration_ms: null, stage: 'REQUEST', kind: 'control',
  status: 'ok', subject: null, label: '', model: null, prompt_version: null, prompt_sha256: null,
  usage: null, input: null, output: null, error: null, ...over,
});

const record: TraceRecord = {
  run: {
    run_id: '11111111-1111-1111-1111-111111111111', started_at: '2026-09-20T00:00:00Z', ended_at: '2026-09-20T00:01:00Z',
    status: 'result', politician_id: 'S000148', promise_text: 'Protect clean air standards.', query_id: null, meta: {},
  },
  steps: [
    step({ seq: 1, stage: 'CLASSIFY', output: { interpretation: { statement_type: 'Policy Position', stance: 'In Favor', primary_issue: 'Environment', sub_issue: 'Pollution & Clean Air/Water', promise_type: 'policy', is_evaluable: true, restated: 'Keep clean air rules.', key_policy_terms: ['clean air'] }, disagreements: [] } }),
    step({ seq: 2, stage: 'RETRIEVE', output: { returned: 2, above_floor: 2, below_floor: 0, candidates: [{ bill_id: 'sjres31-119', bill_number: 'S.J.Res.31', title: 'Disapproval of an EPA rule', is_sponsor: false, is_cosponsor: false, vote: 'NAY', cloture_vote: 'NA', passage_vote: 'NAY', primary_issue: 'Environment', sub_issue: 'Pollution & Clean Air/Water' }], near_misses: [] } }),
    step({ seq: 3, stage: 'RELEVANCE', label: 'sjres31-119 → TRUE_POSITIVE @ 0.98', input: { user_message: 'RAW PROMPT TEXT THAT MUST NOT LEAK' }, output: { raw_text: '{}', parsed: { verdict: 'TRUE_POSITIVE', action_type: 'VOTE', topic_relevant: 'Yes', action_relevant: 'Yes', effort_relevant: 'NA', specificity_match: 'NA', reasoning: 'The resolution targets the clean air rule.' } } }),
    step({ seq: 4, stage: 'EVIDENCE_GATE', label: 'admitted 1 of 1', output: { admitted: ['ACT-sjres31-119-S000148'], dropped: {} } }),
    step({ seq: 5, stage: 'FULFILLMENT', label: 'sjres31-119 → HINDER · model says CONSISTENT @ 0.9', input: { user_message: 'RAW PROMPT TEXT THAT MUST NOT LEAK' }, output: { raw_text: '{}', parsed: { bill_effect: 'HINDER', alignment: 'CONSISTENT', same_object: true, reasoning: 'Passing the resolution would void the rule.' } } }),
    step({ seq: 6, stage: 'SCORE', label: 'KEPT · Low · single', input: { effect_disagreements: [] }, output: { receipt: { trace: ['G1 passed.'] }, evidence: [{ bill_id: 'sjres31-119', bill_effect: 'HINDER', outcome: 'CONSISTENT', direction: 'keeps', evidence_type: 'vote', action_tier: 'VOTED', vote_pattern: 'PASSAGE_ONLY', vote_governing: 'PASSAGE', vote_flags: [] }] } }),
    step({ seq: 7, stage: 'JUDGE', status: 'skipped', label: 'verdict KEPT is not an accusation — judge not consulted (this is NOT a pass)' }),
    step({ seq: 8, stage: 'EXPLAIN_CHECK', output: { why: 'Schumer voted no on the resolution, which kept the rule in place.', connectors: { 'ACT-sjres31-119-S000148': 'The resolution would have undone the rule.' } } }),
    step({ seq: 9, stage: 'RESULT', output: { scored: { verdict: 'KEPT', band: 'Low', mode: 'single', nd_reason: null }, interpretation: { statement_type: 'Policy Position' }, coverage: { congresses: [118, 119] }, gated: [] } }),
  ],
};

describe('buildFollowupContext', () => {
  const ctx = buildFollowupContext(record);

  it('carries the findings the answer can turn on', () => {
    expect(ctx).toContain('Policy Position');
    expect(ctx).toContain('consistent with / runs counter to');
    expect(ctx).toContain('sjres31-119');
    expect(ctx).toContain('The resolution targets the clean air rule.');
    expect(ctx).toContain('Passing the resolution would void the rule.');
    expect(ctx).toContain('judge not consulted');
    expect(ctx).toContain('Verdict bucket: KEPT');
  });

  it('never includes the raw evaluator prompts', () => {
    // They are the bulk of the trace and they are inputs, not findings.
    expect(ctx).not.toContain('RAW PROMPT TEXT THAT MUST NOT LEAK');
  });
});

describe('answerFollowup', () => {
  it('returns an answer that passes the guard, and traces the exchange', async () => {
    const sink = new MemoryTraceSink();
    const seen: string[] = [];
    const out = await answerFollowup(
      { record, question: 'Why did a NAY vote count as consistent?' },
      {
        sinks: [sink],
        fetch: async (system, messages) => {
          seen.push(system);
          expect(messages.at(-1)?.content).toBe('Why did a NAY vote count as consistent?');
          return { text: 'Because the resolution would have voided the clean air rule, voting no kept it in place — that is consistent with the position.' };
        },
      },
    );
    expect(out.refused).toBe(false);
    expect(out.answer).toMatch(/consistent with the position/);
    // The system prompt carries the record.
    expect(seen[0]).toContain('sjres31-119');
    // Its own trace run, pointing at the original.
    const rec = sink.runs.get(out.followup_run_id)!;
    expect(rec.run.meta.followup_of).toBe(record.run.run_id);
    expect(rec.steps.map((s) => s.stage)).toEqual(['REQUEST', 'FOLLOWUP', 'DONE']);
    expect(rec.steps[1]!.status).toBe('ok');
  });

  it('sends a draft that breaks the rules back once, with the problems', async () => {
    const drafts = [
      'The similarity score was high, so it counted.',
      'It counted because the resolution would have voided the rule and Schumer voted against it.',
    ];
    let calls = 0;
    const out = await answerFollowup(
      { record, question: 'Why did it count?' },
      {
        sinks: [],
        fetch: async (_system, messages) => {
          calls += 1;
          if (calls === 2) {
            // The retry carries the rejected draft and the reasons.
            expect(String(messages.at(-2)?.content)).toContain('similarity score');
            expect(String(messages.at(-1)?.content)).toMatch(/breaks these rules/);
          }
          return { text: drafts[calls - 1]! };
        },
      },
    );
    expect(calls).toBe(2);
    expect(out.refused).toBe(false);
    expect(out.answer).not.toMatch(/score/);
  });

  it('refuses rather than rendering a second bad draft', async () => {
    const sink = new MemoryTraceSink();
    const out = await answerFollowup(
      { record, question: 'Did he keep the promise?' },
      { sinks: [sink], fetch: async () => ({ text: 'Yes, he kept the promise.' }) },
    );
    expect(out.refused).toBe(true);
    expect(out.answer).toMatch(/could not phrase an answer/);
    const rec = sink.runs.get(out.followup_run_id)!;
    expect(rec.steps.filter((s) => s.stage === 'FOLLOWUP').map((s) => s.status)).toEqual(['rejected', 'rejected']);
  });

  it('passes prior turns through, capped at ten', async () => {
    const history = Array.from({ length: 14 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: `t${i}` }));
    let count = 0;
    await answerFollowup(
      { record, question: 'again?', history },
      { sinks: [], fetch: async (_s, messages) => { count = messages.length; return { text: 'The record is consistent with the position.' }; } },
    );
    expect(count).toBe(11);
  });
});
