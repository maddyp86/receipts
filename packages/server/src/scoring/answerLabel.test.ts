import { describe, expect, it } from 'vitest';
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
