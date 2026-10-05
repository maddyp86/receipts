import { describe, expect, it } from 'vitest';
import { ND_REASON_COPY, type StreamEvent } from '@receipts/shared';
import { scoreMatches, type ScorableMatch } from './score.js';
import { isCacheable } from '../data/ResultCache.js';

// ===========================================================================
// AN EVALUATOR FAILURE IS NOT A FINDING.
//
// Live trace 5f719ce1 (2026-10-04): a network drop failed all 8 fulfillment
// calls, each row came back bill_effect ERROR, and the scorer reported
// NOT_DETERMINABLE · ALL_NEUTRAL — whose reader copy says the bills "don't
// move the goal in this promise in either direction". Nobody read the bills.
//
// ERROR collapses to NOT_DETERMINABLE, so its direction is neutral, so G1b
// could not tell it from a genuine no-effect reading. It now reports
// EVALUATION_FAILED when an errored row carries an action the evaluator's
// judgement would have decided. That result is also kept out of the session
// cache, because its own copy tells the reader to try again.
// ===========================================================================

let uid = 0;
function row(over: Partial<ScorableMatch> = {}): ScorableMatch {
  uid += 1;
  return {
    action_uid: `ACT-${uid}`, bill_id: `s${uid}-119`, title: 'A bill', summary: 'S.', intended_effects: 'E.',
    mechanisms: 'M.', action_type: 'voted', is_sponsor: false, is_cosponsor: false, vote: 'Yea',
    cloture_vote: 'Yea', passage_vote: 'Yea', bill_keywords: [], primary_issue: 'x', sub_issue: 'y', source_url: '',
    score: 0.7, strength: 'STRONG', missing_fields: [], bill_effect: 'ERROR', bill_effect_reasoning: 'fetch failed',
    alignment_confidence: 0,
    ...over,
  } as ScorableMatch;
}

const run = (matches: ScorableMatch[]) =>
  scoreMatches({ promise_type: 'policy', statement_type: 'Policy Position', matches });

describe('the live failure', () => {
  // Eight voted actions, every evaluator call failed.
  it('is EVALUATION_FAILED, not ALL_NEUTRAL', () => {
    const r = run(Array.from({ length: 8 }, () => row()));
    expect(r.verdict).toBe('NOT_DETERMINABLE');
    expect(r.nd_reason).toBe('EVALUATION_FAILED');
    expect(r.nd_reason).not.toBe('ALL_NEUTRAL');
    // The record stays on screen; only our conclusion is absent.
    expect(r.evidence).toHaveLength(8);
    expect(r.evidence.every((e) => e.scoring_flags.includes('BILL_EFFECT_ERROR'))).toBe(true);
    expect(r.receipt.trace.join(' ')).toMatch(/EVALUATION_FAILED/);
  });
});

describe('which rows count as a failure that hid an answer', () => {
  it('a sponsorship whose effect could not be read', () => {
    expect(run([row({ vote: 'NA', cloture_vote: 'NA', passage_vote: 'NA', is_cosponsor: true })]).nd_reason).toBe('EVALUATION_FAILED');
  });

  // Mixed: one errored vote, two bills genuinely read as no effect. "All
  // neutral" is false — one bill was never read, and it might have decided it.
  it('one failed read among genuine no-effect readings', () => {
    expect(run([row(), row({ bill_effect: 'NEUTRAL' }), row({ bill_effect: 'NEUTRAL' })]).nd_reason).toBe('EVALUATION_FAILED');
  });

  // deriveAlignment returns ERROR before it looks at the action. With no vote
  // and no sponsorship, "no action to judge" is true whatever the evaluator
  // said, so that remains the finding.
  it('not a row with no deciding action at all', () => {
    const r = run([row({ vote: 'NA', cloture_vote: 'NA', passage_vote: 'NA' })]);
    expect(r.nd_reason).toBe('NO_ACTION');
  });

  // An abstention cannot be decided by the bill's effect either.
  it('not an abstention', () => {
    const r = run([row({ vote: 'Not Voting', cloture_vote: 'Not Voting', passage_vote: 'Not Voting' })]);
    expect(r.nd_reason).not.toBe('EVALUATION_FAILED');
  });
});

describe('what does not change', () => {
  it('genuine no-effect readings are still ALL_NEUTRAL', () => {
    expect(run([row({ bill_effect: 'NEUTRAL' }), row({ bill_effect: 'NEUTRAL' })]).nd_reason).toBe('ALL_NEUTRAL');
  });

  it('a procedural switch is still a procedural switch', () => {
    const r = run([row({ bill_effect: 'ADVANCE', is_sponsor: true, passage_vote: 'Nay', cloture_vote: 'NA', vote: 'Nay' })]);
    expect(r.nd_reason).toBe('PROCEDURAL_SWITCH');
  });

  // A verdict reached from the rows that WERE read stands — but at Low, with
  // the unread rows flagged for the reader (decided after #28; see
  // partlyUnread.test.ts for the band and the withheld accusation).
  it('a verdict from the rows that were read stands, at Low; failed rows are flagged', () => {
    const r = run([row({ bill_effect: 'ADVANCE' }), row(), row()]);
    expect(r.verdict).toBe('KEPT');
    expect(r.band).toBe('Low');
    expect(r.evidence.filter((e) => e.scoring_flags.includes('BILL_EFFECT_ERROR'))).toHaveLength(2);
  });

  it('no weight moves', () => {
    const a = run([row({ bill_effect: 'NEUTRAL' }), row({ bill_effect: 'NEUTRAL' })]);
    const b = run([row({ bill_effect: 'NEUTRAL' }), row()]);
    expect(b.evidence.map((e) => e.weight)).toEqual(a.evidence.map((e) => e.weight));
  });
});

describe('the reader\'s words', () => {
  const copy = ND_REASON_COPY.EVALUATION_FAILED;

  it('says the check did not finish, and nothing about the bills\' effect', () => {
    expect(copy).toMatch(/couldn't finish checking/);
    expect(copy).not.toMatch(/don't move the goal|either direction\.$/);
    expect(copy).not.toBe(ND_REASON_COPY.ALL_NEUTRAL);
  });

  it('neither clears nor accuses', () => {
    expect(copy).not.toMatch(/\bkept\b|\bbroke\b|\bconsistent\b|\binconsistent\b|cleared|did nothing wrong/i);
    expect(copy).toMatch(/says nothing about the senator/);
  });
});

describe('the session cache', () => {
  const result = (nd_reason: string | null) =>
    ({ type: 'result', result: { scored: { verdict: 'NOT_DETERMINABLE', nd_reason } } }) as unknown as StreamEvent;

  // The copy says trying again may complete the check. Cached, it couldn't.
  it('does not keep a failed evaluation', () => {
    expect(isCacheable([result('EVALUATION_FAILED')])).toBe(false);
  });

  it('still keeps every other completed result', () => {
    expect(isCacheable([result('ALL_NEUTRAL')])).toBe(true);
    expect(isCacheable([result(null)])).toBe(true);
  });
});
