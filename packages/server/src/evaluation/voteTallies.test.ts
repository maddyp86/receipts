import { describe, expect, it } from 'vitest';
import { isVoteId, voteTallies } from './enrichment.js';

// ===========================================================================
// Vote tallies, counted from core.member_votes. Pinned against the real roll
// call on S.3385 (s644-119.2025): cloture on extending the enhanced ACA tax
// credits, rejected 51-48 under the 3/5 rule, Collins one of 4 Republicans
// voting Yea. A tally written from memory said "51-49"; the record says 51-48
// and that 60 were needed, which is the whole story of why it failed.
// ===========================================================================

const s3385Members = [
  { vote_id: 's644-119.2025', party: 'D', position: 'Yea', n: '45' },
  { vote_id: 's644-119.2025', party: 'I', position: 'Yea', n: '2' },
  { vote_id: 's644-119.2025', party: 'R', position: 'Nay', n: '48' },
  { vote_id: 's644-119.2025', party: 'R', position: 'Yea', n: '4' },
  { vote_id: 's644-119.2025', party: 'R', position: 'Not Voting', n: '1' },
];
const s3385Call = [{ vote_id: 's644-119.2025', result_text: 'Cloture Motion Rejected (51-48, 3/5 majority required)' }];

describe('voteTallies', () => {
  it('counts the S.3385 cloture vote and places Collins against most of her party', () => {
    const [t] = voteTallies(
      [{ stage: 'cloture', vote_id: 's644-119.2025', senator_vote: 'Yea' }],
      'Republican',
      s3385Members,
      s3385Call,
    );
    expect(t).toMatchObject({
      stage: 'cloture', yea: 51, nay: 48, not_voting: 1, passed: false, threshold: '3/5',
      senator_party: 'R', party_majority: 'Nay', with_party: false,
    });
    expect(t!.by_party.R).toEqual({ yea: 4, nay: 48, not_voting: 1 });
    expect(t!.by_party.D).toEqual({ yea: 45, nay: 0, not_voting: 0 });
  });

  it('keeps cloture and passage as separate tallies', () => {
    const tallies = voteTallies(
      [
        { stage: 'cloture', vote_id: 'c1', senator_vote: 'Nay' },
        { stage: 'passage', vote_id: 'p1', senator_vote: 'Nay' },
      ],
      'R',
      [
        { vote_id: 'c1', party: 'R', position: 'Nay', n: 50 },
        { vote_id: 'p1', party: 'R', position: 'Yea', n: 30 },
        { vote_id: 'p1', party: 'R', position: 'Nay', n: 20 },
      ],
      [
        { vote_id: 'c1', result_text: 'Cloture on the Motion to Proceed Rejected (47-50, 3/5 majority required)' },
        { vote_id: 'p1', result_text: 'Bill Passed (60-40)' },
      ],
    );
    expect(tallies.map((t) => [t.stage, t.passed, t.with_party])).toEqual([
      ['cloture', false, true],
      ['passage', true, false],
    ]);
    expect(tallies[1]!.threshold).toBeNull();
  });

  it('says nothing about party when the senator did not vote or the party split evenly', () => {
    const [absent] = voteTallies([{ stage: 'passage', vote_id: 'p', senator_vote: 'Not Voting' }], 'D',
      [{ vote_id: 'p', party: 'D', position: 'Yea', n: 40 }], []);
    expect(absent!.with_party).toBeNull();
    const [even] = voteTallies([{ stage: 'passage', vote_id: 'p', senator_vote: 'Yea' }], 'D',
      [{ vote_id: 'p', party: 'D', position: 'Yea', n: 20 }, { vote_id: 'p', party: 'D', position: 'Nay', n: 20 }], []);
    expect(even!.party_majority).toBeNull();
    expect(even!.passed).toBeNull();
  });
});

describe('isVoteId', () => {
  it('treats the record’s NA placeholders as absent', () => {
    expect(isVoteId('s644-119.2025')).toBe(true);
    expect(isVoteId('NA')).toBe(false);
    expect(isVoteId('')).toBe(false);
    expect(isVoteId(null)).toBe(false);
  });
});
