import { describe, expect, it } from 'vitest';
import { recordTallySentence } from './Verdict.js';

// ===========================================================================
// THE RECORD BAR (Matt, 31 Oct, Ossoff / ACA tax credits, trace 9b534012):
// "3 for · 1 against" under the bar left readers asking: for or against
// what? The bar now opens with a sentence that says.
//
// And (Matt, 1 Nov, Thune / Laken Riley Act): the chip above said "4 about
// your question" while the sentence said "Of the 6 actions". The 4 is bills;
// the 6 is what the senator did on them (S.5 alone: co-sponsored, voted to end
// debate, voted to pass). The sentence names both, and accounts for every
// block on the bar, the uncounted one included.
// ===========================================================================

type Rows = Parameters<typeof recordTallySentence>[0];
const row = (reading: 'for' | 'against' | 'not_counted', stage: Rows[number]['stage'], bill_id = 'b') =>
  ({ action_uid: `A-${bill_id}`, bill_id, stage, vote: null, reading, bill_effect: 'ADVANCE', broad: false }) as unknown as Rows[number];

describe('the record bar sentence', () => {
  it('the Thune case: 4 bills, 6 actions, and the one not counted is said', () => {
    const rows = [
      row('for', 'cosponsor', 's160-118'),
      row('for', 'cloture', 's5-119'),
      row('for', 'passage', 's5-119'),
      row('for', 'cosponsor', 's5-119'),
      row('for', 'cosponsor', 's3933-118'),
      row('not_counted', 'passage', 's2-119'),
    ];
    expect(recordTallySentence(rows, 'Thune')).toBe(
      'On the 4 bills about your question, Thune took 6 actions: 5 push toward what you asked about, none work against it, and 1 isn’t counted.'.replace('’', "'"),
    );
  });

  it('the Ossoff case: one vote and two co-sponsorships toward, one against, four bills', () => {
    const rows = [row('for', 'cloture', 's3385'), row('for', 'cosponsor', 's46'), row('for', 'cosponsor', 's4684'), row('against', 'cosponsor', 's2556')];
    expect(recordTallySentence(rows, 'Ossoff')).toBe(
      'On the 4 bills about your question, Ossoff took 4 actions: 3 push toward what you asked about and 1 works against it.',
    );
  });

  it('says "none" rather than "0", gets the singular right, and says what was set aside', () => {
    expect(recordTallySentence([row('for', 'passage')], 'Thune')).toBe(
      'On the one bill about your question, Thune took one action, and it pushes toward what you asked about.',
    );
    expect(recordTallySentence([row('against', 'cloture', 'x'), row('against', 'passage', 'x')], 'Thune', 1)).toBe(
      'On the one bill about your question, Thune took 2 actions: none push toward what you asked about and 2 work against it. 1 more was set aside by our rules.',
    );
  });

  it('falls back to "they" without a name, and has nothing to say when nothing was counted', () => {
    expect(recordTallySentence([row('for', 'vote', 'a'), row('for', 'vote', 'b')])).toMatch(/^On the 2 bills about your question, they took 2 actions:/);
    expect(recordTallySentence([row('not_counted', 'vote')])).toBeNull();
  });
});
