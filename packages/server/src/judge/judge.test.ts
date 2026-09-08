import { describe, expect, it } from 'vitest';
import {
  buildJudgeUserMessage,
  judgeVerdict,
  parseJudgeResponse,
  type JudgeInput,
  type JudgeVerdict,
} from './judge.js';
import {
  applyJudgeVerdict,
  checkRetryInvariant,
  gatedDisposition,
  type RowUnderJudgement,
} from './dispositions.js';
import { JUDGE_SYSTEM_PROMPT, JUDGE_SYSTEM_PROMPT_LENGTH } from './judgePrompt.js';

const input = (over: Partial<JudgeInput> = {}): JudgeInput => ({
  statement_text: 'I will fight to lower prescription drug costs.',
  statement_type: 'Policy Position',
  bill_id: 'hr1-119',
  bill_title: 'A bill',
  bill_effect: 'ADVANCE',
  verdict: 'INCONSISTENT',
  confidence: 0.6,
  gate_results: [],
  ...over,
});

const row = (over: Partial<RowUnderJudgement> = {}): RowUnderJudgement => ({
  verdict: 'BROKE',
  confidence: 0.8,
  reasoning: 'He voted against it.',
  ...over,
});

const verdict = (over: Partial<JudgeVerdict> = {}): JudgeVerdict => ({
  grade: 'PASS',
  failed_test: '',
  failure_class: '',
  corrected_verdict: '',
  corrected_bill_effect: '',
  corrected_confidence: null,
  senator_counterargument: 'The bill was a different vehicle.',
  gate_agreement: 'NO_GATE_FIRED',
  gold_agreement: 'NO_GOLD',
  critique: 'Holds up.',
  model: 'claude-sonnet-5',
  prompt_version: 'judge-v1',
  ...over,
});

const msg = (
  content: Array<{ type: string; text?: string }>,
  stop_reason: string | null = 'end_turn',
) => ({ content, stop_reason });

const json = (o: unknown) => msg([{ type: 'text', text: JSON.stringify(o) }]);

// ===========================================================================
// The prompt
// ===========================================================================

describe('judge prompt', () => {
  it('matches its asserted length', () => {
    expect(JUDGE_SYSTEM_PROMPT).toHaveLength(JUDGE_SYSTEM_PROMPT_LENGTH);
  });

  it('carries all seven tests and the stop-at-first-FAIL rule', () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(JUDGE_SYSTEM_PROMPT).toContain(`**T${n} `);
    expect(JUDGE_SYSTEM_PROMPT).toContain('stop at first FAIL');
  });

  it('keeps the rule that a PASS requires a counterargument', () => {
    expect(JUDGE_SYSTEM_PROMPT).toContain('A PASS must include `senator_counterargument`');
  });
});

// ===========================================================================
// Parsing — the API behaviours that cost real debugging time upstream
// ===========================================================================

describe('parseJudgeResponse — infrastructure failure is never a verdict', () => {
  // The specific bug from handoff v2 §5: the first version wrote
  // FAIL / T7 / HALLUCINATED_LINK for a response that said nothing, putting a
  // fabricated accusation into the audit log.
  it('a thinking-only response is JUDGE_NO_OUTPUT, not a content failure', () => {
    const r = parseJudgeResponse(msg([{ type: 'thinking' }], 'max_tokens'));
    expect(r.grade).toBe('ERROR');
    expect(r.failure_class).toBe('JUDGE_NO_OUTPUT');
    expect(r.failed_test).toBe('');
    expect(r.critique).toContain('raise max_tokens');
  });

  it('an empty response is JUDGE_NO_OUTPUT', () => {
    const r = parseJudgeResponse(msg([], 'end_turn'));
    expect(r.grade).toBe('ERROR');
    expect(r.failure_class).toBe('JUDGE_NO_OUTPUT');
  });

  it('unparseable output is JUDGE_NO_OUTPUT and quotes what came back', () => {
    const r = parseJudgeResponse(msg([{ type: 'text', text: 'I think it looks fine.' }]));
    expect(r.grade).toBe('ERROR');
    expect(r.critique).toContain('I think it looks fine');
  });

  // Two different fixes: "raise max_tokens" vs "the model returned prose".
  it('distinguishes truncation from prose in the critique', () => {
    const truncated = parseJudgeResponse(msg([{ type: 'thinking' }], 'max_tokens'));
    const prose = parseJudgeResponse(msg([{ type: 'text', text: 'no json here' }]));
    expect(truncated.critique).not.toBe(prose.critique);
  });

  it('reads text blocks past a thinking block', () => {
    const r = parseJudgeResponse(
      msg([{ type: 'thinking' }, { type: 'text', text: JSON.stringify({ grade: 'FAIL', critique: 'x' }) }]),
    );
    expect(r.grade).toBe('FAIL');
  });

  it('tolerates a ```json fence', () => {
    const r = parseJudgeResponse(
      msg([{ type: 'text', text: '```json\n{"grade":"FAIL","critique":"x"}\n```' }]),
    );
    expect(r.grade).toBe('FAIL');
  });
});

describe('parseJudgeResponse — a PASS without a counterargument is not a PASS', () => {
  it('downgrades to FAIL / UNDISCLOSED_CAVEAT / T6', () => {
    const r = parseJudgeResponse(json({ grade: 'PASS', senator_counterargument: '', critique: 'Fine.' }));
    expect(r.grade).toBe('FAIL');
    expect(r.failure_class).toBe('UNDISCLOSED_CAVEAT');
    expect(r.failed_test).toBe('T6');
    expect(r.critique).toContain('PASS without counterargument');
  });

  it('accepts a PASS that supplies one', () => {
    const r = parseJudgeResponse(
      json({ grade: 'PASS', senator_counterargument: 'It was a procedural vote.', critique: 'Holds.' }),
    );
    expect(r.grade).toBe('PASS');
  });

  // No gold set exists for a user-typed statement.
  it('defaults gold_agreement to NO_GOLD', () => {
    expect(parseJudgeResponse(json({ grade: 'FAIL' })).gold_agreement).toBe('NO_GOLD');
  });
});

describe('judgeVerdict — a thrown request is infrastructure, not a finding', () => {
  it('turns a transport failure into JUDGE_NO_OUTPUT', async () => {
    const r = await judgeVerdict(input(), async () => {
      throw new Error('network down');
    });
    expect(r.grade).toBe('ERROR');
    expect(r.failure_class).toBe('JUDGE_NO_OUTPUT');
    expect(r.critique).toContain('network down');
  });
});

describe('buildJudgeUserMessage', () => {
  it('passes the gate results through for confirmation, not re-derivation', () => {
    const m = buildJudgeUserMessage(
      input({
        gate_results: [
          { gate: 'G3_leader_switch', class: 'LEADER_SWITCH', detail: 'MAJORITY_LEADER NAY vs whip YEA' },
        ],
      }),
    );
    expect(m).toContain('G3_leader_switch / LEADER_SWITCH');
  });

  it('says none fired rather than leaving the section blank', () => {
    expect(buildJudgeUserMessage(input())).toContain('- none fired');
  });

  // §3: the column can hold a marker, and 0 is a confidence while absence is not.
  it('renders an absent confidence as NOT_EVALUATED, never 0', () => {
    const m = buildJudgeUserMessage(input({ confidence: null }));
    expect(m).toContain('confidence: NOT_EVALUATED');
  });
});

// ===========================================================================
// Dispositions
// ===========================================================================

describe('applyJudgeVerdict', () => {
  it('PASS leaves the verdict and confidence alone', () => {
    const d = applyJudgeVerdict(row(), verdict());
    expect(d.disposition).toBe('PASS');
    expect(d.verdict).toBe('BROKE');
    expect(d.confidence).toBe(0.8);
    expect(d.withheld).toBe(false);
  });

  // The case the stale draft got wrong on sjres7-119: it forced
  // NOT_DETERMINABLE and discarded a correct judge verdict.
  it('applies the judge’s correction rather than blanket NOT_DETERMINABLE', () => {
    const d = applyJudgeVerdict(
      row({ verdict: 'BROKE', confidence: 0.9 }),
      verdict({
        grade: 'FAIL',
        failure_class: 'OVERCONFIDENT',
        corrected_verdict: 'BROKE',
        corrected_confidence: 0.7,
        senator_counterargument: 'It was a procedural vote.',
      }),
    );
    expect(d.disposition).toBe('REVIEW_REQUIRED_JUDGE_CORRECTED');
    expect(d.verdict).toBe('BROKE');
    expect(d.confidence).toBe(0.7);
    expect(d.reasoning).toContain('SENATOR RESPONSE');
  });

  it('caps a restored accusation at 0.7 however confident the judge was', () => {
    const d = applyJudgeVerdict(
      row(),
      verdict({ grade: 'FAIL', corrected_verdict: 'BROKE', corrected_confidence: 0.95 }),
    );
    expect(d.confidence).toBe(0.7);
  });

  it('does not cap a corrected non-accusation', () => {
    const d = applyJudgeVerdict(
      row(),
      verdict({ grade: 'FAIL', corrected_verdict: 'KEPT', corrected_confidence: 0.95 }),
    );
    expect(d.verdict).toBe('KEPT');
    expect(d.confidence).toBe(0.95);
  });

  it('falls back to NOT_DETERMINABLE when no correction was offered', () => {
    const d = applyJudgeVerdict(row(), verdict({ grade: 'FAIL', corrected_verdict: '' }));
    expect(d.disposition).toBe('REVIEW_REQUIRED');
    expect(d.verdict).toBe('NOT_DETERMINABLE');
    expect(d.withheld).toBe(true);
  });

  it('ignores a corrected_verdict outside the vocabulary', () => {
    const d = applyJudgeVerdict(row(), verdict({ grade: 'FAIL', corrected_verdict: 'PROBABLY_BROKE' }));
    expect(d.disposition).toBe('REVIEW_REQUIRED');
    expect(d.verdict).toBe('NOT_DETERMINABLE');
  });

  it('always preserves the evaluator’s original verdict for the record', () => {
    const d = applyJudgeVerdict(row({ verdict: 'BROKE' }), verdict({ grade: 'FAIL' }));
    expect(d.model_verdict).toBe('BROKE');
  });
});

describe('applyJudgeVerdict — JUDGE_ERROR withholds rather than publishes', () => {
  // The deviation from §5. "Leave the verdict untouched and keep PENDING" is
  // only safe because WF11 refuses to score PENDING; there is no WF11 here, so
  // untouched would mean RENDERING an unjudged accusation.
  it('withholds an accusation the judge could not review', () => {
    const d = applyJudgeVerdict(row({ verdict: 'BROKE' }), verdict({ grade: 'ERROR' }));
    expect(d.disposition).toBe('JUDGE_ERROR');
    expect(d.verdict).toBe('NOT_DETERMINABLE');
    expect(d.withheld).toBe(true);
    expect(d.model_verdict).toBe('BROKE');
    expect(d.reasoning).toContain('WITHHELD');
  });

  // Asymmetric: a KEPT nobody reviewed is not a public accusation.
  it('leaves a non-accusation as it was', () => {
    const d = applyJudgeVerdict(row({ verdict: 'KEPT', confidence: 0.8 }), verdict({ grade: 'ERROR' }));
    expect(d.verdict).toBe('KEPT');
    expect(d.confidence).toBe(0.8);
  });
});

describe('gatedDisposition', () => {
  it('carries the gate class into the disposition and the reason into the prose', () => {
    const d = gatedDisposition(
      { gate: 'G3_leader_switch', class: 'LEADER_SWITCH', detail: 'leader NAY vs whip YEA' },
      row(),
    );
    expect(d.disposition).toBe('GATED_LEADER_SWITCH');
    expect(d.verdict).toBe('NOT_DETERMINABLE');
    expect(d.reasoning).toContain('leader NAY vs whip YEA');
    expect(d.withheld).toBe(true);
  });
});

// ===========================================================================
// Contract 4 — a critique must never be able to manufacture an accusation
// ===========================================================================

describe('checkRetryInvariant', () => {
  it('discards a retry that creates an accusation', () => {
    const d = checkRetryInvariant(
      { verdict: 'NOT_DETERMINABLE', confidence: 0.5 },
      { verdict: 'BROKE', confidence: 0.6 },
    );
    expect(d.accepted).toBe(false);
    expect(d.note).toContain('INVARIANT');
  });

  it('discards a retry that strengthens an existing accusation', () => {
    expect(
      checkRetryInvariant({ verdict: 'BROKE', confidence: 0.6 }, { verdict: 'BROKE', confidence: 0.9 })
        .accepted,
    ).toBe(false);
  });

  it('accepts a retry that moves away from an accusation', () => {
    expect(
      checkRetryInvariant(
        { verdict: 'BROKE', confidence: 0.9 },
        { verdict: 'NOT_DETERMINABLE', confidence: 0.4 },
      ).accepted,
    ).toBe(true);
  });

  it('accepts a retry that lowers confidence on the same accusation', () => {
    expect(
      checkRetryInvariant({ verdict: 'BROKE', confidence: 0.9 }, { verdict: 'BROKE', confidence: 0.6 })
        .accepted,
    ).toBe(true);
  });

  // A detail the prose summary loses: the confidence check applies only to
  // accusations, so a KEPT may legitimately grow more confident on retry.
  it('allows a non-accusation to gain confidence', () => {
    expect(
      checkRetryInvariant({ verdict: 'KEPT', confidence: 0.5 }, { verdict: 'KEPT', confidence: 0.9 })
        .accepted,
    ).toBe(true);
  });
});
