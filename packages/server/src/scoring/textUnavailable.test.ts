import { describe, expect, it } from 'vitest';
import {
  ND_REASON_COPY,
  TEXT_AT_ACTION_UNAVAILABLE,
  VOTE_FLAG_COPY,
  type TextVersionDisclosure,
} from '@receipts/shared';
import { scoreMatches, type ScorableMatch } from './score.js';
import { applyWithholding } from './withholding.js';

// ===========================================================================
// WHEN THE TEXT IN EFFECT AT THE TIME IS NOT AVAILABLE.
//
// Not substituting an older version was the first half. The mirror image is
// the problem this pins: with the version in effect unusable, the evaluator
// read the bill's LATEST text. On hr5334-119 that judges an educator-deduction
// cosponsorship against a Russia sanctions act. Recording the intended version
// on the row is not enough, because the voter never sees the row's internals.
//
// So, in the scorer, on the established patterns:
//   - the row carries a reader-facing disclosure flag;
//   - the band drops to Low when any action behind the verdict is affected;
//   - an accusation resting ENTIRELY on such actions is withheld, as contract
//     3 withholds a low-confidence one — asymmetric for the same reason.
// The direction of the verdict is never touched, and an action whose text was
// available counts exactly as before.
// ===========================================================================

const disclosure = (status: TextVersionDisclosure['status']): TextVersionDisclosure => ({
  status,
  governed_by: 'SPONSORSHIP',
  action_date: '2025-09-20',
  dated_by: 'SPONSORSHIP',
  dating_reason: null,
  code: 'ih',
  type: 'Introduced in House',
  date: '2025-09-11',
  title: 'To amend the Internal Revenue Code of 1986 to allow early childhood educators to take the educator expense deduction',
  title_source: 'TEXT',
  flagged_for_review: status === 'TEXT_UNAVAILABLE',
  latest: { code: 'enr', type: 'Enrolled Bill', date: null, title: 'To impose sanctions … Russian Federation', title_source: 'TEXT' },
  rewritten: true,
  taxonomy_divergent: true,
  taxonomy_divergence_detail: null,
  version_count: 6,
});

let uid = 0;
function match(over: Partial<ScorableMatch> = {}): ScorableMatch {
  uid += 1;
  return {
    action_uid: `ACT-${uid}`,
    bill_id: `hr${uid}-119`,
    title: 'A bill',
    summary: 'Summary.',
    intended_effects: 'Effects.',
    mechanisms: 'Mechanisms.',
    action_type: 'voted',
    is_sponsor: false,
    is_cosponsor: false,
    vote: 'NA',
    cloture_vote: 'NA',
    passage_vote: 'Yea',
    bill_keywords: ['k'],
    primary_issue: 'Budget & Economy',
    sub_issue: 'Taxes',
    source_url: '',
    score: 0.8,
    strength: 'STRONG',
    missing_fields: [],
    bill_effect: 'ADVANCE',
    bill_effect_reasoning: 'Advances it.',
    alignment_confidence: 0.9,
    ...over,
  };
}

const run = (matches: ScorableMatch[]) =>
  scoreMatches({ promise_type: 'policy', statement_type: 'Campaign Promise', matches });

describe('a favourable reading on unavailable text', () => {
  it('is still KEPT, but at Low, and says why on the row', () => {
    const r = run([match({ text_version: disclosure('TEXT_UNAVAILABLE') })]);
    expect(r.verdict).toBe('KEPT');
    expect(r.band).toBe('Low');
    expect(r.evidence[0]!.vote_flags).toContain(TEXT_AT_ACTION_UNAVAILABLE);
    expect(r.receipt.trace.join(' ')).toMatch(/without the bill text in effect/);
  });

  // Two strong hard actions would be High. One affected action is enough to
  // drop it: a reader cannot tell from "High" which action carried the doubt.
  it('lowers what would have been High', () => {
    const sound = [match(), match()];
    expect(run(sound).band).toBe('High');
    const r = run([match(), match({ text_version: disclosure('TEXT_UNAVAILABLE') })]);
    expect(r.verdict).toBe('KEPT');
    expect(r.band).toBe('Low');
  });
});

describe('an accusation on unavailable text', () => {
  const breaking = (over: Partial<ScorableMatch> = {}) => match({ passage_vote: 'Nay', ...over });

  // Confidence 0.95 — far above contract 3's floor. It does not matter: the
  // reading was of a different version of the bill.
  it('is withheld when every breaking action is affected, however confident', () => {
    const r = run([breaking({ alignment_confidence: 0.95, text_version: disclosure('TEXT_UNAVAILABLE') })]);
    expect(r.verdict).toBe('NOT_DETERMINABLE');
    expect(r.nd_reason).toBe('WITHHELD_TEXT_UNAVAILABLE');
    // Withholding the verdict is not hiding the record.
    expect(r.evidence).toHaveLength(1);
  });

  // A counterargument repairs a weak reading; it cannot repair a reading of
  // the wrong text. Checked ahead of it.
  it('is withheld even with the counterargument on the record', () => {
    const scored = run([breaking({ text_version: disclosure('TEXT_UNAVAILABLE') })]);
    // Re-run the step on the BROKE the dials produced, with a counterargument.
    const asBroke = { ...scored, verdict: 'BROKE' as const, nd_reason: null, mode: 'single' as const, band: 'Low' as const };
    const out = applyWithholding(asBroke, { counterargumentPresent: true });
    expect(out.withheld).toBe(true);
    expect(out.result.nd_reason).toBe('WITHHELD_TEXT_UNAVAILABLE');
  });

  it('stands, at Low, when one breaking action has its text', () => {
    const r = run([
      breaking({ alignment_confidence: 0.85 }),
      breaking({ alignment_confidence: 0.85, text_version: disclosure('TEXT_UNAVAILABLE') }),
    ]);
    expect(r.verdict).toBe('BROKE');
    expect(r.band).toBe('Low');
  });

  it('is recorded in the trace, so a withheld reading is never silent', () => {
    const r = run([breaking({ text_version: disclosure('TEXT_UNAVAILABLE') })]);
    expect(r.receipt.trace.join(' ')).toMatch(/Withheld: .*later version of the bill/);
  });
});

describe('everything else is unchanged', () => {
  it('a SELECTED version — the text was available — changes nothing', () => {
    const plain = run([match(), match()]);
    const selected = run([match({ text_version: disclosure('SELECTED') }), match({ text_version: disclosure('SELECTED') })]);
    expect(selected.verdict).toBe(plain.verdict);
    expect(selected.band).toBe(plain.band);
    expect(selected.evidence.every((e) => !e.vote_flags.includes(TEXT_AT_ACTION_UNAVAILABLE))).toBe(true);
  });

  // NO_ACTION_DATE / BEFORE_FIRST_VERSION are a different gap — the act could
  // not be placed — and are disclosed in Task 5, not scored down here.
  it.each(['NO_ACTION_DATE', 'BEFORE_FIRST_VERSION'] as const)('%s does not lower the band', (status) => {
    expect(run([match(), match({ text_version: disclosure(status) })]).band).toBe('High');
  });

  it('weights are identical with and without the flag — only the band moves', () => {
    const a = run([match({ action_uid: 'A' }), match({ action_uid: 'B' })]);
    const b = run([match({ action_uid: 'A' }), match({ action_uid: 'B', text_version: disclosure('TEXT_UNAVAILABLE') })]);
    expect(b.evidence.map((e) => e.weight)).toEqual(a.evidence.map((e) => e.weight));
    expect(b.receipt.weight_split).toEqual(a.receipt.weight_split);
  });
});

describe('the reader-facing words', () => {
  it('exist for the flag and for the withholding reason', () => {
    // "No reliable summary" since 2026-10-07: true whether the version's text
    // is missing or its summary is flagged as wrong (textUnavailableCopy.test).
    expect(VOTE_FLAG_COPY[TEXT_AT_ACTION_UNAVAILABLE]).toMatch(/reliable summary/);
    expect(ND_REASON_COPY.WITHHELD_TEXT_UNAVAILABLE).toMatch(/reliable summary/);
  });

  // Withholding is not exoneration — the same rule as the other withholdings.
  it('never reads as clearing the senator', () => {
    for (const copy of [ND_REASON_COPY.WITHHELD_TEXT_UNAVAILABLE, VOTE_FLAG_COPY[TEXT_AT_ACTION_UNAVAILABLE]!]) {
      expect(copy).not.toMatch(/\bkept\b|\bcleared\b|\bconsistent\b|did nothing wrong/i);
    }
  });
});
