import { describe, expect, it } from 'vitest';
import type { DirectedAction } from '@receipts/shared';
import { figuresNotGiven } from './dispatch.js';

// ===========================================================================
// The card summary may quote only figures the result handed over. A draft
// written from memory said S.3385 "failed 51-49"; the record says 51-48 under
// the 60-vote rule. A figure the reader cannot tell apart from a checked one
// must be one we checked.
// ===========================================================================

const s3385 = {
  bill_id: 's3385-119',
  bill_number: '3385',
  cloture_vote_date: '2025-12-11',
  vote_context: [
    {
      vote_id: 's644-119.2025', stage: 'cloture', yea: 51, nay: 48, not_voting: 1,
      result_text: 'Cloture Motion Rejected (51-48, 3/5 majority required)', passed: false, threshold: '3/5',
      by_party: { D: { yea: 45, nay: 0, not_voting: 0 }, I: { yea: 2, nay: 0, not_voting: 0 }, R: { yea: 4, nay: 48, not_voting: 1 } },
      senator_vote: 'Yea', senator_party: 'R', party_majority: 'Nay', with_party: false,
    },
  ],
} as unknown as DirectedAction;

describe('figuresNotGiven', () => {
  it('accepts the counts, the 60 it needed, the bill number and the year', () => {
    const text =
      'Collins voted Yea to end debate on S.3385 in 2025. It failed 51 to 48, short of the 60 it needed. ' +
      'Four Republicans, 45 Democrats and 2 independents voted Yea, and 48 Republicans voted Nay.';
    expect(figuresNotGiven(text, [s3385], 1)).toEqual([]);
  });

  it('rejects a tally the record does not hold', () => {
    expect(figuresNotGiven('It failed 51-49.', [s3385])).toEqual(['49']);
  });

  it('rejects a percentage or margin the model worked out itself', () => {
    expect(figuresNotGiven('About 52% voted Yea, a 3-vote margin.', [s3385])).toEqual(['52']);
  });

  it('allows small counts of bills', () => {
    expect(figuresNotGiven('We found 2 bills and set 1 aside.', [s3385], 1)).toEqual([]);
  });
});
