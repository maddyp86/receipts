import { describe, expect, it } from 'vitest';
import { affirmsDirection, explanationProblems } from './dispatch.js';

// ===========================================================================
// The explainer's paragraph is now shown on "doesn't settle it" answers
// (2026-10-11). On a reading held back after review, a paragraph saying the
// record "runs counter" would publish the accusation we declined to make, so
// direction words are refused there — unless negated.
// ===========================================================================

describe('affirmsDirection', () => {
  it.each([
    'His no vote runs counter to what you asked about.',
    'The record is consistent with the statement.',
    'That vote went against the goal.',
    'Our reading leans against this statement.',
    'It lines up with your question.',
    // Written on a live held-back answer (run 8c6bcba0, 2026-10-11) before this check: the withheld accusation itself.
    'So on the one vote we have evidence for, his action runs counter to the position of not raising individual income taxes.',
  ])('flags "%s"', (t) => expect(affirmsDirection(t.toLowerCase())).toBe(true));

  it.each([
    'The record doesn’t line up with the statement or run counter to it — it simply doesn’t settle it.',
    'Neither bill is consistent with or against the goal as worded.',
    'We found two bills on taxes, and Schumer voted no on one.',
    'A second check held the reading back, so we are not publishing it.',
    // Refused by the first version of this check on a live run (2026-10-11): an open question, not a finding.
    'Because that is the only matching bill, the record doesn’t give us enough to say whether it lines up with or runs counter to the stated position.',
    'The record simply doesn’t settle whether Schumer’s actions line up with or against the stated position.',
  ])('passes "%s"', (t) => expect(affirmsDirection(t.toLowerCase())).toBe(false));
});

describe('the check on a not-determinable answer', () => {
  it('sends back a paragraph that states a direction', () => {
    expect(explanationProblems('You asked about taxes. His vote runs counter to your statement.', 'NOT_DETERMINABLE', 'Policy Position').join(' '))
      .toMatch(/does not settle the question/);
  });

  it('leaves the same words alone on an answer with a verdict', () => {
    expect(explanationProblems('You asked about taxes. His vote runs counter to your statement.', 'BROKE', 'Policy Position')).toEqual([]);
  });

  it('accepts a paragraph that says it does not settle it, and why', () => {
    expect(explanationProblems(
      'You asked whether Schumer kept away from raising income taxes. We found H.R. 1, the 2025 reconciliation law, and he voted no on it. That bill covers many subjects at once, so a second check held the first reading back and we are not publishing a verdict.',
      'NOT_DETERMINABLE', 'Policy Position',
    )).toEqual([]);
  });
});
