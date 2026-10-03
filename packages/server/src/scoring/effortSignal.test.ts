import { describe, expect, it } from 'vitest';
import { BANNED_MOTIVE_TERMS } from '@receipts/shared';
import {
  EFFORT_DISPLAY_ORDER,
  EFFORT_EXPLAINER,
  EFFORT_LABEL,
  effortSignals,
  type EffortInput,
  type EffortSignal,
} from './effortSignal.js';

// ===========================================================================
// AUTHORED / CO_SIGNED, split by WF2c's sponsorship tier.
//
// The tier picks which FORM of the signal is shown. It never decides whether a
// sponsorship signal fires, and nothing here is numeric. The words describe
// the record — what happened to the bill, when the name went on — and never
// who moved the bill or why.
// ===========================================================================

const base: EffortInput = { alignment: 'KEPT', bill_effect: 'ADVANCE' };

describe('the tier chooses the form of the sponsorship signal', () => {
  it.each([
    ['SPONSOR_ADVANCED', 'AUTHORED_ADVANCED'],
    ['SPONSOR_STALLED', 'AUTHORED_STALLED'],
    [null, 'AUTHORED'],
    ['UNRESOLVED', 'AUTHORED'],
  ])('a sponsor tiered %s is %s', (tier, signal) => {
    expect(effortSignals({ ...base, is_sponsor: true, sponsor_tier: tier })).toEqual([signal]);
  });

  it.each([
    ['ORIGINAL_COSPONSOR', 'CO_SIGNED_ORIGINAL'],
    ['LATE_COSPONSOR', 'CO_SIGNED_LATE'],
    [null, 'CO_SIGNED'],
    [undefined, 'CO_SIGNED'],
  ])('a co-sponsor tiered %s is %s', (tier, signal) => {
    expect(effortSignals({ ...base, is_cosponsor: 'TRUE', sponsor_tier: tier })).toEqual([signal]);
  });

  // The flag says sponsor, the tier says co-sponsor. One of them is wrong and
  // the record cannot say which, so neither form is claimed.
  it('ignores a tier that contradicts the sponsor flags', () => {
    expect(effortSignals({ ...base, is_sponsor: true, sponsor_tier: 'LATE_COSPONSOR' })).toEqual(['AUTHORED']);
    expect(effortSignals({ ...base, is_cosponsor: true, sponsor_tier: 'SPONSOR_ADVANCED' })).toEqual(['CO_SIGNED']);
  });

  it('reads the tier case-insensitively', () => {
    expect(effortSignals({ ...base, is_cosponsor: true, sponsor_tier: 'late_cosponsor' })).toEqual(['CO_SIGNED_LATE']);
  });

  // A vote-only row is tiered NA_VOTE_ONLY. The tier must not conjure a
  // sponsorship signal for a senator who never put a name on the bill.
  it('never creates a sponsorship signal from the tier alone', () => {
    expect(effortSignals({ ...base, passage_vote: 'YEA', sponsor_tier: 'SPONSOR_ADVANCED' })).toEqual(['VOTED_TO_ADVANCE']);
    expect(effortSignals({ ...base, sponsor_tier: 'ORIGINAL_COSPONSOR' })).toEqual(['NO_ACTION']);
  });

  it('fires the same number of signals with and without tier data', () => {
    const inputs: EffortInput[] = [
      { ...base, is_sponsor: true, passage_vote: 'YEA' },
      { ...base, is_cosponsor: true, cloture_vote: 'NAY', bill_effect: 'HINDER' },
    ];
    for (const i of inputs) {
      const tiers = ['SPONSOR_ADVANCED', 'LATE_COSPONSOR'];
      for (const t of tiers) expect(effortSignals({ ...i, sponsor_tier: t })).toHaveLength(effortSignals(i).length);
    }
  });
});

describe('the words describe the record, not effort or motive', () => {
  const NEW: EffortSignal[] = ['AUTHORED_ADVANCED', 'AUTHORED_STALLED', 'CO_SIGNED_ORIGINAL', 'CO_SIGNED_LATE'];
  const words = (s: EffortSignal) => `${EFFORT_LABEL[s]} ${EFFORT_EXPLAINER[s]}`;

  it.each(NEW)('%s never names the tier', (s) => {
    expect(words(s)).not.toMatch(/SPONSOR_|COSPONSOR|tier|advanced\b|stalled/i);
  });

  // The claims the record cannot support. "Moved past referral" is a fact
  // about the bill; "pushed it" is a claim about the senator.
  it.each(NEW)('%s claims no effort the record cannot show', (s) => {
    expect(words(s)).not.toMatch(/push|fought|champion|abandon|gave up|drove|led\b|worked to|hard/i);
    for (const term of BANNED_MOTIVE_TERMS) expect(words(s).toLowerCase()).not.toContain(term);
  });

  it('says outright that the record does not show who moved the bill', () => {
    expect(EFFORT_EXPLAINER.AUTHORED_ADVANCED).toMatch(/does not show who moved it/);
  });

  // The old CO_SIGNED explainer said a co-sponsorship is "weighted lower than a
  // recorded vote". EVIDENCE_TYPE_FACTOR weights both at 1.0.
  it('makes no claim about weighting', () => {
    for (const s of Object.keys(EFFORT_EXPLAINER) as EffortSignal[]) {
      expect(EFFORT_EXPLAINER[s]).not.toMatch(/weighted/i);
    }
  });

  it('places every signal in the display order exactly once', () => {
    const all = Object.keys(EFFORT_LABEL) as EffortSignal[];
    expect([...EFFORT_DISPLAY_ORDER].sort()).toEqual([...all].sort());
  });
});
