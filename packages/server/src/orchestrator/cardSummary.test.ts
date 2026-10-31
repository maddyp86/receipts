import { describe, expect, it } from 'vitest';
import type { DirectedAction } from '@receipts/shared';
import { figuresNotGiven, partyCountsWrong } from './dispatch.js';

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

  // Traces 174120ca and 7bf678bd: good drafts sent back for "through 2028"
  // (the bill summary) and "July 24" (a date given).
  it('accepts what the bill summary says and the day of a vote', () => {
    const withSummary = { ...s3385, summary: 'The bill extends the enhanced credit through 2028, for incomes above 400% of the poverty line.' } as DirectedAction;
    expect(figuresNotGiven('It would extend the credit through 2028, above 400% of the poverty line. The vote was on December 11.', [withSummary])).toEqual([]);
  });

  it('allows small counts of bills', () => {
    expect(figuresNotGiven('We found 2 bills and set 1 aside.', [s3385], 1)).toEqual([]);
  });
});

// ===========================================================================
// Ossoff, trace 9b534012 (31 Oct): "with Ossoff and 45 Democrats and 2
// Independents voting Yea, and 48 Republicans and 4 Republicans voting Yea".
// Every number is real, so figuresNotGiven passed it; 48 Republicans voted
// Nay. Each party count has to sit on the side the tally puts it.
// ===========================================================================

describe('partyCountsWrong', () => {
  it('the Ossoff draft: 48 Republicans on the Yea side', () => {
    const text =
      'The vote to end debate failed 51-48 (60 votes needed), with Ossoff and 45 Democrats and 2 Independents voting Yea, ' +
      'and 48 Republicans and 4 Republicans voting Yea.';
    expect(partyCountsWrong(text, [s3385])).toEqual(['48 republicans voting Yea']);
  });

  it('accepts the counts on the right sides', () => {
    const text =
      'Four Republicans, 45 Democrats and 2 independents voted Yea, and 48 Republicans voted Nay. ' +
      '4 Republicans joined Democrats in voting yea; 48 Republicans were opposed.';
    expect(partyCountsWrong(text, [s3385])).toEqual([]);
  });

  it('catches a count put on the Nay side that belongs on the Yea side', () => {
    expect(partyCountsWrong('45 Democrats voted Nay.', [s3385])).toEqual(['45 democrats voting Nay']);
  });

  it('leaves alone a clause with no side, both sides, or not voting', () => {
    expect(partyCountsWrong('48 Republicans were in the chamber.', [s3385])).toEqual([]);
    expect(partyCountsWrong('It drew 48 Republicans to Nay and 4 to Yea.', [s3385])).toEqual([]);
    expect(partyCountsWrong('1 Republican was not voting.', [s3385])).toEqual([]);
  });

  it('says nothing when the result has no by-party tally', () => {
    expect(partyCountsWrong('48 Republicans voted Yea.', [{ bill_id: 'x' } as unknown as DirectedAction])).toEqual([]);
  });
});
