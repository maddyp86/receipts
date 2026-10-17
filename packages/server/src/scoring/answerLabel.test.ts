import { describe, expect, it } from 'vitest';
import { answerLabelLine, answerReasonLine, isVoteActionUid } from '@receipts/shared';
import { answerLabel, readVote, rowsOf, type AnswerInput } from './answerLabel.js';

// ===========================================================================
// The answer to a record question, from the bill's effect (the evaluator's
// reading of the bill) and the senator's votes, one stage at a time.
// ===========================================================================

const act = (over: Partial<AnswerInput>): AnswerInput => ({
  action_uid: over.bill_id ? `ACT-${over.bill_id}` : 'ACT-x',
  bill_id: 'x',
  bill_effect: 'ADVANCE',
  cloture_vote: 'NA',
  passage_vote: 'NA',
  vote: 'NA',
  is_sponsor: false,
  is_cosponsor: false,
  bill_class: 'TARGETED',
  ...over,
});

describe('readVote', () => {
  it('reads a vote against what the bill does', () => {
    expect(readVote('ADVANCE', 'YEA')).toBe('for');
    expect(readVote('ADVANCE', 'NAY')).toBe('against');
    expect(readVote('HINDER', 'YEA')).toBe('against');
    expect(readVote('HINDER', 'NAY')).toBe('for');
  });

  it('shows but never counts a bill not read as doing it, or an absence', () => {
    for (const e of ['NEUTRAL', 'CONTESTED', 'ERROR']) expect(readVote(e, 'YEA')).toBe('not_counted');
    expect(readVote('ADVANCE', 'NOT_VOTING')).toBe('no_vote');
  });
});

describe('answerLabel', () => {
  // Collins, "Did they vote to extend the enhanced ACA tax credits?": a Yea to
  // end debate on S.3385, which would extend them; no final vote.
  it('a Yea to end debate on a bill that does it: VOTED_FOR, named as a cloture vote', () => {
    const a = answerLabel([act({ bill_id: 's3385-119', cloture_vote: 'Yea', vote: 'Yea' })], 1);
    expect(a.label).toBe('VOTED_FOR');
    expect(a.rows).toEqual([expect.objectContaining({ stage: 'cloture', vote: 'YEA', reading: 'for' })]);
    expect(a.set_aside).toBe(1);
  });

  // A Congressional Review Act disapproval of a rule that does what was asked
  // is read by the evaluator as HINDER, so a Nay keeps the rule: a vote for.
  it('a Nay on a CRA disapproval of the rule asked about is a vote for', () => {
    const a = answerLabel([act({ bill_id: 'hjres45-118', bill_effect: 'HINDER', passage_vote: 'Nay' })]);
    expect(a.label).toBe('VOTED_FOR');
  });

  it('a Yea to end debate and a Nay on the final vote is a mixed record, with both stages kept', () => {
    const a = answerLabel([act({ cloture_vote: 'Yea', passage_vote: 'Nay', vote: 'Nay' })]);
    expect(a.label).toBe('MIXED_RECORD');
    expect(a.rows.map((r) => [r.stage, r.reading])).toEqual([['cloture', 'for'], ['passage', 'against']]);
    expect(a.counted).toEqual({ for: 1, against: 1 });
  });

  it('a broad package never decides the label when there is a targeted vote', () => {
    const a = answerLabel([
      act({ bill_id: 'targeted', passage_vote: 'Yea' }),
      act({ bill_id: 'cr', bill_class: 'BROAD_VEHICLE', passage_vote: 'Nay' }),
    ]);
    expect(a.label).toBe('VOTED_FOR');
    expect(a.rows.find((r) => r.bill_id === 'cr')).toMatchObject({ broad: true, reading: 'against' });
  });

  // Case 38: Schumer's Nay on H.R. 1 (the 2025 reconciliation law) alone
  // answered "Voted against" expanding the child tax credit. Classed
  // TARGETED by the gates; a broad package here.
  it('a reconciliation law is a broad package and never decides alone', () => {
    const hr1 = act({ bill_id: 'hr1-119', passage_vote: 'Nay', title: 'An act to provide for reconciliation pursuant to title II of H. Con. Res. 14.' });
    const both = answerLabel([hr1, act({ bill_id: 's1393-119', is_cosponsor: true })], 1, 1);
    expect(both).toMatchObject({ label: 'SPONSORSHIP_ONLY', reason: 'SPONSORSHIP_BROAD_VOTES' });
    // Never "no recorded vote" or "only vote … set aside": the H.R. 1 Nay is a recorded vote.
    expect(answerLabelLine(both)).toBe('Backed a bill on this. Their only votes on it were on larger packages.');
    expect(answerLabelLine(both, [{ action_uid: 'ACT-hr7024-118-S000148' }])).toBe('Backed a bill on this. Their votes on it were on larger packages or set aside.');
    expect(answerReasonLine(both, [{ action_uid: 'ACT-hr7024-118-S000148', reason: 'As majority leader, the senator voted no on ending debate. More.' }]))
      .toBe('Each of those packages covered much more than this, so none says on its own how they stand on this piece. Another vote was set aside. As majority leader, the senator voted no on ending debate. That vote is shown under Receipts but not counted.');
    expect(answerLabel([hr1])).toMatchObject({ label: 'ONLY_BROAD_VOTES' });
  });

  it('only votes on broad packages: ONLY_BROAD_VOTES', () => {
    const a = answerLabel([act({ bill_class: 'BROAD_VEHICLE', cloture_vote: 'Nay', passage_vote: 'Nay' })]);
    expect(a.label).toBe('ONLY_BROAD_VOTES');
    expect(a.reason).toBe('BROAD_ONLY');
  });

  it('sponsorship only: SPONSORSHIP_ONLY', () => {
    const a = answerLabel([act({ is_sponsor: true })]);
    expect(a.label).toBe('SPONSORSHIP_ONLY');
    expect(a.rows).toEqual([expect.objectContaining({ stage: 'sponsor', reading: 'for' })]);
  });

  // Cases 21, 23, 28 (Schumer): his only vote was a procedural Nay as majority
  // leader, set aside by a rule. "Backed a bill on this, but no recorded vote"
  // would be untrue, so the reason says the vote was set aside (Matt, 17 Oct).
  it('sponsorship with its only vote set aside: says so', () => {
    const a = answerLabel([act({ is_sponsor: true })], 1, 1);
    expect(a).toMatchObject({ label: 'SPONSORSHIP_ONLY', reason: 'SPONSORSHIP_VOTE_SET_ASIDE' });
    expect(answerLabelLine(a)).toBe('Backed a bill on this. Their only vote on it was set aside.');
    expect(answerReasonLine(a, [{ action_uid: 'ACT-s4554-118-S000148', reason: 'As majority leader, the senator voted no on ending debate. More.' }]))
      .toBe('As majority leader, the senator voted no on ending debate. That vote is shown under Receipts but not counted.');
  });

  it('sponsorship with nothing set aside, or only a sponsorship set aside: the usual line', () => {
    expect(answerLabelLine(answerLabel([act({ is_sponsor: true })]))).toBe('Backed a bill on this, but no recorded vote.');
    expect(answerLabel([act({ is_sponsor: true })], 1, 0).reason).toBe('SPONSORSHIP');
    expect(isVoteActionUid('ACT-S-sres950-119-C001035')).toBe(false);
    expect(isVoteActionUid('ACT-s3385-119-C001035')).toBe(true);
  });

  it('a vote outranks a sponsorship on the same question', () => {
    const a = answerLabel([act({ bill_id: 'a', is_cosponsor: true }), act({ bill_id: 'b', passage_vote: 'Nay' })]);
    expect(a.label).toBe('VOTED_AGAINST');
  });

  it('nothing found and nothing counted are told apart', () => {
    expect(answerLabel([])).toMatchObject({ label: 'NO_RECORDED_ACTION_FOUND', reason: 'NOTHING_FOUND' });
    expect(answerLabel([act({ bill_effect: 'NEUTRAL', passage_vote: 'Yea' })])).toMatchObject({
      label: 'NO_RECORDED_ACTION_FOUND', reason: 'NOTHING_COUNTED',
    });
    expect(answerLabel([], 2)).toMatchObject({ reason: 'NOTHING_COUNTED' });
  });

  it('an absence is shown, not counted', () => {
    const a = answerLabel([act({ passage_vote: 'Not Voting' })]);
    expect(a.label).toBe('NO_RECORDED_ACTION_FOUND');
    expect(a.rows[0]).toMatchObject({ vote: 'NOT_VOTING', reading: 'no_vote' });
  });
});

describe('rowsOf', () => {
  it('reads the resolved vote only when neither stage is recorded', () => {
    expect(rowsOf(act({ vote: 'Yea' }))).toEqual([expect.objectContaining({ stage: 'vote', reading: 'for' })]);
    expect(rowsOf(act({ vote: 'Yea', cloture_vote: 'Nay' }))).toEqual([expect.objectContaining({ stage: 'cloture', reading: 'against' })]);
  });
});
