import { describe, expect, it } from 'vitest';
import { parseJudgeResponse } from './judge.js';
import { applyJudgeVerdict } from './dispositions.js';
import { config } from '../config.js';

// ===========================================================================
// THE JUDGE ALWAYS RETURNS A VERDICT OR AN EXPLICIT FAILURE.
//
// Clean-air traces, 2026-10-07: at max_tokens 8000 the judge ran out on 3 of
// 7 calls. Two responses were thinking only; one had begun its answer and was
// cut off. Sonnet 5 has no separate thinking budget, so the ceiling is the
// lever (config.judge.maxTokens, now 32,000). Whatever the ceiling, a
// response that runs out is an explicit JUDGE_ERROR — never a content verdict,
// never a silent pass — and its critique says the ceiling was the cause.
// ===========================================================================

const ok = '{"grade":"FAIL","failed_test":"T4","failure_class":"BILL_EFFECT_INVERTED","corrected_verdict":"CONSISTENT","corrected_confidence":0.65,"senator_counterargument":"x","critique":"y"}';

describe('the ceiling', () => {
  it('defaults well clear of what the judge uses (3.7k-6.5k on the clean-air calls that finished)', () => {
    expect(config.judge.maxTokens).toBe(32_000);
  });
});

describe('running out is an explicit failure', () => {
  // Two of the three clean-air failures.
  it('thinking only, no text', () => {
    const v = parseJudgeResponse({ content: [{ type: 'thinking' }], stop_reason: 'max_tokens' });
    expect(v.grade).toBe('ERROR');
    expect(v.failure_class).toBe('JUDGE_NO_OUTPUT');
    expect(v.critique).toMatch(/thinking-only response.*raise max_tokens/);
  });

  // The third: the answer had started and was cut off mid-JSON. It used to be
  // reported as "not valid JSON", which reads as a prose problem.
  it('an answer cut off mid-JSON says the ceiling was the cause', () => {
    const v = parseJudgeResponse({
      content: [{ type: 'thinking' }, { type: 'text', text: ok.slice(0, 60) }],
      stop_reason: 'max_tokens',
    });
    expect(v.grade).toBe('ERROR');
    expect(v.critique).toMatch(/output ceiling mid-answer/);
  });

  it('prose that is not JSON is still reported as such', () => {
    const v = parseJudgeResponse({ content: [{ type: 'text', text: 'I think it is fine.' }], stop_reason: 'end_turn' });
    expect(v.grade).toBe('ERROR');
    expect(v.critique).toMatch(/not valid JSON/);
  });

  // And downstream, an explicit failure withholds an accusation.
  it('withholds the accusation it was reviewing', () => {
    const v = parseJudgeResponse({ content: [{ type: 'thinking' }], stop_reason: 'max_tokens' });
    const d = applyJudgeVerdict({ verdict: 'INCONSISTENT', confidence: 0.89, reasoning: 'r' }, v);
    expect(d.disposition).toBe('JUDGE_ERROR');
    expect(d.withheld).toBe(true);
  });
});

describe('a finished answer is unaffected', () => {
  it('parses as before', () => {
    const v = parseJudgeResponse({ content: [{ type: 'thinking' }, { type: 'text', text: ok }], stop_reason: 'end_turn' });
    expect(v.grade).toBe('FAIL');
    expect(v.corrected_verdict).toBe('CONSISTENT');
  });
});
