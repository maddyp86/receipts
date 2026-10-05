import { describe, expect, it } from 'vitest';
import { BANNED_MOTIVE_TERMS, ND_REASON_COPY, type StatementType, type StreamEvent } from '@receipts/shared';
import { scoreMatches, type ScorableMatch } from './score.js';
import { isCacheable } from '../data/ResultCache.js';

// ===========================================================================
// AN ABSTENTION IS NOT "NO EFFECT".
//
// Reproduced 2026-10-04: one row, bill_effect ADVANCE, every vote "Not
// Voting", no sponsorship, scored NOT_DETERMINABLE · ALL_NEUTRAL — whose
// reader copy says the bills "don't move the goal in this promise in either
// direction". The evaluator had read the bill as moving it. What the record
// shows is that the senator cast no yes or no vote on it.
//
// G1b counted the abstention as an action, so NO_ACTION was skipped and the
// reason fell through to ALL_NEUTRAL. It now reports ABSTAINED when an
// abstention sits on a bill that was not read as having no effect.
//
// Decided and pinned: an abstention on a bill read as NEUTRAL or CONTESTED
// stays ALL_NEUTRAL. A yes or no vote would not have decided it either, so the
// reading is the reason — and that sentence is true of it.
// ===========================================================================

let uid = 0;
function row(over: Partial<ScorableMatch> = {}): ScorableMatch {
  uid += 1;
  return {
    action_uid: `ACT-${uid}`, bill_id: `s${uid}-119`, title: 'A bill', summary: 'S.', intended_effects: 'E.',
    mechanisms: 'M.', action_type: 'voted', is_sponsor: false, is_cosponsor: false, vote: 'Not Voting',
    cloture_vote: 'Not Voting', passage_vote: 'Not Voting', bill_keywords: [], primary_issue: 'x', sub_issue: 'y',
    source_url: '', score: 0.7, strength: 'STRONG', missing_fields: [], bill_effect: 'ADVANCE',
    bill_effect_reasoning: 'r', alignment_confidence: 0.8,
    ...over,
  } as ScorableMatch;
}

const VOTED = { vote: 'Yea', cloture_vote: 'Yea', passage_vote: 'Yea' } as const;

const run = (matches: ScorableMatch[], statement_type: StatementType = 'Policy Position') =>
  scoreMatches({ promise_type: 'policy', statement_type, matches });

describe('the reproduction', () => {
  it('an abstention on a bill read as ADVANCE is ABSTAINED, not ALL_NEUTRAL', () => {
    const r = run([row()]);
    expect(r.verdict).toBe('NOT_DETERMINABLE');
    expect(r.nd_reason).toBe('ABSTAINED');
    expect(r.band).toBeNull();
    // The record stays on screen, and the row still says what it was.
    expect(r.evidence).toHaveLength(1);
    expect(r.evidence[0]!.action_tier).toBe('ABSTAIN');
    expect(r.evidence[0]!.vote_governing).toBe('NO_ACTION');
    expect(r.receipt.trace.join(' ')).toMatch(/ABSTAINED/);
  });

  it.each(['ADVANCE', 'HINDER'] as const)('%s, under either statement type', (bill_effect) => {
    expect(run([row({ bill_effect })], 'Campaign Promise').nd_reason).toBe('ABSTAINED');
    expect(run([row({ bill_effect })], 'Policy Position').nd_reason).toBe('ABSTAINED');
  });

  // The other way an action is tiered ABSTAIN: the vote field is empty but the
  // party-alignment record says the senator did not vote.
  it('an abstention recorded on party alignment rather than the vote field', () => {
    const r = run([row({ vote: 'NA', cloture_vote: 'NA', passage_vote: 'NA', party_alignment: 'NOT_VOTED' })]);
    expect(r.nd_reason).toBe('ABSTAINED');
  });

  // An abstention whose bill was never read. #28 left it out of
  // EVALUATION_FAILED on purpose — no reading could have directed it — and
  // ALL_NEUTRAL would claim a reading nobody made. What is true is the vote.
  it('an abstention on a bill the evaluator failed to read', () => {
    const r = run([row({ bill_effect: 'ERROR' })]);
    expect(r.nd_reason).toBe('ABSTAINED');
    expect(r.evidence[0]!.scoring_flags).toContain('BILL_EFFECT_ERROR');
  });

  // Mixed: a yes vote on a bill read as no effect, and an abstention on one
  // read as moving the goal. "All neutral" is false of the second bill.
  it('an abstention on a moving bill beside a vote on a no-effect bill', () => {
    expect(run([row({ bill_effect: 'NEUTRAL', ...VOTED }), row()]).nd_reason).toBe('ABSTAINED');
  });
});

describe('where ALL_NEUTRAL is still the honest reason', () => {
  it('directional votes on bills read as having no effect', () => {
    expect(run([row({ bill_effect: 'NEUTRAL', ...VOTED }), row({ bill_effect: 'CONTESTED', ...VOTED })]).nd_reason)
      .toBe('ALL_NEUTRAL');
  });

  // The decision this change makes: the bill's reading, not the missed vote,
  // is why nothing could be judged.
  it.each(['NEUTRAL', 'CONTESTED'] as const)('an abstention on a bill read as %s', (bill_effect) => {
    expect(run([row({ bill_effect })]).nd_reason).toBe('ALL_NEUTRAL');
  });
});

describe('what does not change', () => {
  it('no vote and no sponsorship at all is still NO_ACTION', () => {
    expect(run([row({ vote: 'NA', cloture_vote: 'NA', passage_vote: 'NA' })]).nd_reason).toBe('NO_ACTION');
  });

  // Sponsorship directs the row when no vote overrides it; ADR-011's tiering
  // of the abstention does not move the verdict.
  it('an abstaining sponsor of a bill read as ADVANCE is still directed by the sponsorship', () => {
    const r = run([row({ is_sponsor: true })]);
    expect(r.verdict).toBe('KEPT');
    expect(r.nd_reason).toBeNull();
  });

  it('a directed vote elsewhere still decides it, with the same weight', () => {
    const alone = run([row({ ...VOTED })]);
    const withAbstention = run([row({ ...VOTED }), row()]);
    expect(withAbstention.verdict).toBe(alone.verdict);
    expect(withAbstention.receipt.weight_split).toEqual(alone.receipt.weight_split);
  });

  it('an abstention carries no weight and keeps its flag', () => {
    const r = run([row(), row({ bill_effect: 'HINDER' })]);
    expect(r.evidence.map((e) => e.weight)).toEqual([0, 0]);
    expect(r.receipt.weight_split).toEqual({ keeps: 0, breaks: 0 });
    expect(r.receipt.scoring_flags).toContain('SILENT_AVOIDANCE');
  });

  it('an errored sponsorship beside an abstention is still EVALUATION_FAILED', () => {
    expect(run([row(), row({ bill_effect: 'ERROR', vote: 'NA', cloture_vote: 'NA', passage_vote: 'NA', is_cosponsor: true })]).nd_reason)
      .toBe('EVALUATION_FAILED');
  });
});

describe('the reader\'s words', () => {
  const copy = ND_REASON_COPY.ABSTAINED;

  it('states the record: no yes or no vote', () => {
    expect(copy).toMatch(/recorded as not voting/);
    expect(copy).toMatch(/no yes or no/);
    expect(copy).not.toBe(ND_REASON_COPY.ALL_NEUTRAL);
    expect(copy).not.toMatch(/don't move the goal|either direction/);
  });

  it('attributes no motive', () => {
    for (const term of BANNED_MOTIVE_TERMS) expect(copy.toLowerCase()).not.toContain(term);
    expect(copy).not.toMatch(/\bchose\b|\brefused\b|\bskipp|\bduck|\bhid/i);
  });

  it('neither clears nor accuses', () => {
    expect(copy).not.toMatch(/\bkept\b|\bbroke\b|\bconsistent\b|\binconsistent\b|cleared/i);
  });
});

describe('the session cache', () => {
  // The record will not change on a retry, so the result is kept.
  it('keeps an ABSTAINED result', () => {
    const result = { type: 'result', result: { scored: { verdict: 'NOT_DETERMINABLE', nd_reason: 'ABSTAINED' } } } as unknown as StreamEvent;
    expect(isCacheable([result])).toBe(true);
  });
});
