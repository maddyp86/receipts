import { describe, expect, it } from 'vitest';
import { recordTallySentence } from './Verdict.js';

// ===========================================================================
// THE RECORD BAR (Matt, 31 Oct, Ossoff / ACA tax credits, trace 9b534012):
// "3 for · 1 against" under the bar left readers asking: for or against
// what? The bar now opens with a sentence that says.
// ===========================================================================

type Rows = Parameters<typeof recordTallySentence>[0];
const row = (reading: 'for' | 'against' | 'not', stage: Rows[number]['stage']) =>
  ({ action_uid: `A-${Math.random()}`, bill_id: 'b', stage, vote: null, reading, bill_effect: 'ADVANCE', broad: false }) as unknown as Rows[number];

describe('the record bar sentence', () => {
  it('the Ossoff case: one vote and two co-sponsorships toward, one co-sponsorship against', () => {
    const rows = [row('for', 'cloture'), row('for', 'cosponsor'), row('for', 'cosponsor'), row('against', 'cosponsor')];
    expect(recordTallySentence(rows)).toBe(
      'Of the 4 actions about your question, 3 push toward what you asked about and 1 works against it.',
    );
  });

  it('says "none" rather than "0", and gets the singular right', () => {
    expect(recordTallySentence([row('for', 'passage')])).toBe(
      'The one action about your question pushes toward what you asked about.',
    );
    expect(recordTallySentence([row('against', 'vote'), row('against', 'vote')])).toBe(
      'Of the 2 actions about your question, none push toward what you asked about and 2 work against it.',
    );
  });

  it('has nothing to say when nothing was counted either way', () => {
    expect(recordTallySentence([row('not', 'vote')])).toBeNull();
  });
});
