import { describe, expect, it } from 'vitest';
import type { VoteTally } from '@receipts/shared';
import { VOTE_FLAG_COPY } from '@receipts/shared';
import { scoreMatches, type ScorableMatch } from './score.js';
import { NOT_CLOSE, PARTY_LINE, isNotClose, isPartyLine, voteMargin, voteMarginFlags, votesNeeded } from './voteMargin.js';

// ===========================================================================
// "Does the output weight the actions differently? A vote weighs more than a
// cosponsored bill" (Matt, 15 Nov). It did not: a co-sponsorship counted
// exactly as much as a final vote. And "those actions could be passive or
// misleading as Congress plays games": nothing said when a vote was a
// party-line vote whose outcome was never in doubt.
// ===========================================================================

let uid = 0;
const match = (over: Partial<ScorableMatch> = {}): ScorableMatch => {
  uid += 1;
  return {
    action_uid: `ACT-w-${uid}`, bill_id: `b-${uid}`, title: 'A Bill', summary: 'S.', intended_effects: 'E.', mechanisms: 'M.',
    action_type: 'voted', is_sponsor: false, is_cosponsor: false, vote: 'NA', cloture_vote: 'NA', passage_vote: 'NA',
    bill_keywords: ['k'], primary_issue: 'Health Care', sub_issue: 'x', source_url: 'https://congress.gov/x',
    score: 0.6, strength: 'STRONG', missing_fields: [], bill_effect: 'ADVANCE', bill_effect_reasoning: 'r.', ...over,
  } as ScorableMatch;
};
const vote = (over: Partial<ScorableMatch> = {}) => match({ passage_vote: 'YEA', vote: 'YEA', ...over });
const cosponsored = (over: Partial<ScorableMatch> = {}) => match({ action_type: 'cosponsored', is_cosponsor: true, ...over });
const run = (matches: ScorableMatch[]) => scoreMatches({ promise_type: 'policy', statement_type: 'Campaign Promise', matches });
const weightOf = (r: ReturnType<typeof run>, uidOf: ScorableMatch) => r.evidence.find((e) => e.action_uid === uidOf.action_uid)!.weight;

describe('a vote weighs more than a sponsorship, which weighs more than a co-sponsorship', () => {
  it('weights at the same match score: final vote 1, sponsorship 0.5, co-sponsorship 0.3', () => {
    const v = vote();
    const s = match({ action_type: 'sponsored', is_sponsor: true });
    const c = cosponsored();
    const r = run([v, s, c]);
    expect(weightOf(r, v)).toBeCloseTo(0.6);
    expect(weightOf(r, s)).toBeCloseTo(0.3);
    expect(weightOf(r, c)).toBeCloseTo(0.18);
  });

  it('a vote to end debate alone counts a little less than a final vote', () => {
    const finalVote = vote();
    const clotureOnly = match({ cloture_vote: 'YEA', vote: 'YEA' });
    const r = run([finalVote, clotureOnly]);
    expect(weightOf(r, clotureOnly)).toBeLessThan(weightOf(r, finalVote));
  });

  it('when they conflict, one final vote outweighs two co-sponsorships the other way', () => {
    const r = run([vote({ bill_effect: 'ADVANCE' }), cosponsored({ bill_effect: 'HINDER' }), cosponsored({ bill_effect: 'HINDER' })]);
    // Before: 0.6 keeping against 1.2 breaking, and the co-sponsorships won.
    expect(r.ranked?.[0]?.verdict).toBe('KEPT');
  });
});

// The ACA cloture vote (S.3385, 11 Dec 2025) and the Laken Riley Act (S.5).
const tally = (over: Partial<VoteTally>): VoteTally => ({
  vote_id: 'v', stage: 'cloture', yea: 0, nay: 0, not_voting: 0, result_text: null, passed: null, threshold: null,
  by_party: {}, senator_vote: 'Yea', senator_party: 'D', party_majority: null, with_party: null, ...over,
});
const ACA = tally({ yea: 51, nay: 48, threshold: '3/5', passed: false, by_party: { D: { yea: 45, nay: 0, not_voting: 0 }, I: { yea: 2, nay: 0, not_voting: 0 }, R: { yea: 4, nay: 48, not_voting: 1 } } });
const LAKEN_CLOTURE = tally({ yea: 61, nay: 35, threshold: '3/5', passed: true, by_party: { D: { yea: 10, nay: 33, not_voting: 0 }, R: { yea: 51, nay: 0, not_voting: 2 } } });
const LAKEN_PASSAGE = tally({ stage: 'passage', yea: 64, nay: 35, passed: true, by_party: { D: { yea: 12, nay: 33, not_voting: 0 }, R: { yea: 52, nay: 0, not_voting: 1 } } });

describe('show votes: party-line and not close, from the tallies', () => {
  it('the ACA vote: party-line, and 9 short of the 60 it needed', () => {
    expect(votesNeeded(ACA)).toBe(60);
    expect(voteMargin(ACA)).toBe(-9);
    expect(isPartyLine(ACA)).toBe(true);
    expect(voteMarginFlags([ACA])).toEqual([PARTY_LINE, NOT_CLOSE]);
  });

  it('the Laken Riley Act: not party-line (a quarter of Democrats crossed), and the vote to end debate was close', () => {
    expect(isPartyLine(LAKEN_CLOTURE)).toBe(false);
    expect(voteMargin(LAKEN_CLOTURE)).toBe(1);
    expect(isNotClose(LAKEN_PASSAGE)).toBe(true);
    // A flag only when every roll call on the bill shows it.
    expect(voteMarginFlags([LAKEN_CLOTURE, LAKEN_PASSAGE])).toEqual([]);
  });

  it('a simple-majority vote needs a majority of those voting', () => {
    expect(votesNeeded(LAKEN_PASSAGE)).toBe(50);
  });

  it('no tallies, no flags; and each flag has reader copy that names no motive', () => {
    expect(voteMarginFlags(undefined)).toEqual([]);
    for (const f of [PARTY_LINE, NOT_CLOSE]) {
      expect(VOTE_FLAG_COPY[f]).toBeTruthy();
      expect(VOTE_FLAG_COPY[f]).not.toMatch(/\b(show|messag|stunt|posture|political|intend|wanted|knew)/i);
    }
  });

  it('reaches the evidence row as a disclosure, and moves no weight', () => {
    const withTally = vote({ vote_context: [ACA] } as Partial<ScorableMatch>);
    const without = vote();
    const r = run([withTally, without]);
    const row = r.evidence.find((e) => e.action_uid === withTally.action_uid)!;
    expect(row.vote_flags).toEqual(expect.arrayContaining([PARTY_LINE, NOT_CLOSE]));
    expect(row.weight).toBe(r.evidence.find((e) => e.action_uid === without.action_uid)!.weight);
  });
});
