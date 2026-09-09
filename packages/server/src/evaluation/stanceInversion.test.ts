import { describe, expect, it } from 'vitest';
import type { StatementType } from '@receipts/shared';
import { deriveAlignment } from '../scoring/deriveAlignment.js';
import { EVALUATOR_SYSTEM_PROMPT } from './evaluatorPromptV7.js';

// ===========================================================================
// The v7 stance inversion — measured, not hypothesised.
//
// Evaluator v7 asks the model for a bill's direction of travel on the goal a
// statement states. When the statement is OPPOSE-framed — its goal is the
// ABSENCE of something — v7 has been observed to invert: a bill that restricts
// the opposed thing comes back HINDER when it plainly ADVANCES the stated goal.
//
// Source: WF13 execution 13776 (2026-09-08, Thune, 52 rows, dry run). Statement
// `7Z0J7FUX`, stance Opposed, Policy Position, evaluated against three bills
// that RESTRICT federal abortion funding. v7 said HINDER on all three; the
// retry pass corrected all three to ADVANCE.
//
// WHY THESE TESTS LOOK THE WAY THEY DO.
//
// The defect lives in a PROMPT, so no unit test can reproduce it without
// calling the model — and this suite is pinned offline (see vitest.config.ts).
// What can be pinned deterministically is the blast radius, and that turns out
// to be the more useful thing to record:
//
//   1. the alignment table propagates whichever effect it is handed, faithfully
//      and symmetrically, so a wrong effect becomes a wrong verdict silently;
//   2. the table has NO stance term, so it cannot detect or correct this;
//   3. the measured cases are held as data, so the prompt fix has a corpus to
//      be judged against rather than a story.
//
// The prompt change itself is deliberately NOT made here. `evaluatorPromptV7.ts`
// is a verbatim port, and `bill_effect` is the axis where divergence between
// this tool and the corpus scorer does the most damage — two prompts judging
// effect is how the query tool and the trust report end up printing different
// answers for the same senator on the same bill. It lands when the matching
// n8n edit can land beside it. See RECONCILIATION 2026-09-09.
// ===========================================================================

/** One measured inversion. Exported so an eval harness can score against it. */
export interface StanceInversionCase {
  statement_uid: string;
  statement_text: string;
  stance: 'Opposed';
  statement_type: StatementType;
  bill_id: string;
  bill_title: string;
  /** What evaluator v7 actually returned. */
  v7_effect: 'HINDER';
  /** What the retry pass corrected it to, and what a reader would call correct. */
  correct_effect: 'ADVANCE';
  /** The verdict v7's effect produced downstream. */
  v7_verdict: 'INCONSISTENT';
  /** The verdict the correct effect produces downstream. */
  correct_verdict: 'CONSISTENT';
  v7_confidence: number;
}

const STATEMENT_TEXT =
  'The legislation would open the door to federal funding of abortion, forcing Americans who ' +
  'oppose abortion to subsidize it with their tax dollars';

export const STANCE_INVERSION_CASES: readonly StanceInversionCase[] = [
  {
    statement_uid: '7Z0J7FUX',
    statement_text: STATEMENT_TEXT,
    stance: 'Opposed',
    statement_type: 'Policy Position',
    bill_id: 's13-118',
    bill_title: 'A bill to prohibit Federal funding of Planned Parenthood',
    v7_effect: 'HINDER',
    correct_effect: 'ADVANCE',
    v7_verdict: 'INCONSISTENT',
    correct_verdict: 'CONSISTENT',
    v7_confidence: 0.88,
  },
  {
    statement_uid: '7Z0J7FUX',
    statement_text: STATEMENT_TEXT,
    stance: 'Opposed',
    statement_type: 'Policy Position',
    bill_id: 's186-118',
    bill_title:
      'A bill to prohibit the Federal Government from promoting, supporting, or contracting with abortion entities',
    v7_effect: 'HINDER',
    correct_effect: 'ADVANCE',
    v7_verdict: 'INCONSISTENT',
    correct_verdict: 'CONSISTENT',
    v7_confidence: 0.9,
  },
  {
    statement_uid: '7Z0J7FUX',
    statement_text: STATEMENT_TEXT,
    stance: 'Opposed',
    statement_type: 'Policy Position',
    bill_id: 's186-119',
    bill_title: 'A bill to prohibit taxpayer funded abortions',
    v7_effect: 'HINDER',
    correct_effect: 'ADVANCE',
    v7_verdict: 'INCONSISTENT',
    correct_verdict: 'CONSISTENT',
    v7_confidence: 0.9,
  },
] as const;

// The senator voted YEA on each of these restricting bills. That vote is not in
// dispute anywhere — only the direction assigned to the bill is.
const VOTED_YEA = { passage_vote: 'YEA' } as const;

describe('the measured v7 stance inversions', () => {
  it('records three cases, all the same shape', () => {
    expect(STANCE_INVERSION_CASES).toHaveLength(3);
    for (const c of STANCE_INVERSION_CASES) {
      expect(c.stance).toBe('Opposed');
      expect(c.v7_effect).toBe('HINDER');
      expect(c.correct_effect).toBe('ADVANCE');
      // Every one was asserted with high confidence. A confidently wrong
      // direction is worse than an unsure one: it clears the accusation floor.
      expect(c.v7_confidence).toBeGreaterThanOrEqual(0.7);
    }
  });

  it('is confident enough to clear contract 3 — which is what makes it dangerous', () => {
    // Contract 3 withholds an accusation below 0.7. Every measured inversion
    // sat above it, so the guard that exists to stop false accusations would
    // have passed all three straight through to a reader.
    for (const c of STANCE_INVERSION_CASES) {
      expect(c.v7_confidence).toBeGreaterThan(0.7);
      expect(c.v7_verdict).toBe('INCONSISTENT');
    }
  });
});

describe('the alignment table propagates the effect it is given, and cannot catch this', () => {
  it('turns the WRONG effect into the wrong verdict, for every measured case', () => {
    for (const c of STANCE_INVERSION_CASES) {
      const derived = deriveAlignment(
        { bill_effect: c.v7_effect, ...VOTED_YEA },
        c.statement_type,
      );
      expect(derived.verdict, `${c.bill_id} with v7's HINDER`).toBe(c.v7_verdict);
    }
  });

  it('turns the RIGHT effect into the right verdict, for every measured case', () => {
    // The table is not broken. Hand it ADVANCE and it produces CONSISTENT on
    // exactly the same vote. The error is entirely upstream, at the effect step.
    for (const c of STANCE_INVERSION_CASES) {
      const derived = deriveAlignment(
        { bill_effect: c.correct_effect, ...VOTED_YEA },
        c.statement_type,
      );
      expect(derived.verdict, `${c.bill_id} with the corrected ADVANCE`).toBe(c.correct_verdict);
    }
  });

  it('takes nothing from the statement but the vocabulary, so it cannot see stance at all', () => {
    // The structural reason this cannot be fixed downstream. `deriveAlignment`
    // reads bill_effect, votes and sponsorship. The ONLY statement-side input
    // is statementType, and all that does is choose the label pair — the same
    // evidence yields the same reading in both vocabularies.
    //
    // So there is no stance for the table to re-apply, no place to notice that
    // an oppose-framed goal was inverted, and consequently no downstream guard
    // that could ever catch this class. It has to be right leaving step 1.
    const evidence = { bill_effect: 'ADVANCE', ...VOTED_YEA } as const;
    expect(deriveAlignment(evidence, 'Policy Position').verdict).toBe('CONSISTENT');
    expect(deriveAlignment(evidence, 'Campaign Promise').verdict).toBe('KEPT');

    const inverted = { bill_effect: 'HINDER', ...VOTED_YEA } as const;
    expect(deriveAlignment(inverted, 'Policy Position').verdict).toBe('INCONSISTENT');
    expect(deriveAlignment(inverted, 'Campaign Promise').verdict).toBe('BROKE');
  });
});

describe('where the prompt fix has to go', () => {
  // Length is already pinned in wiring.test.ts; not duplicated here.

  it('tells the model the stance is already baked in — which is why STEP 1 is the only place to fix this', () => {
    // STEP 3 forbids re-applying stance, correctly: applying it twice would
    // invert every oppose-framed row a second time. So the direction has to be
    // right when it LEAVES step 1, and no later stage may compensate.
    expect(EVALUATOR_SYSTEM_PROMPT).toContain(
      'The stance is already inside ADVANCE/HINDER. Do not apply it again.',
    );
  });

  it('carries only SUPPORT-framed worked examples today — the measured gap, stated as a test', () => {
    // Both worked examples under REVERSAL are support-framed ("protect student
    // loan relief", "limit presidential authority"). An oppose-framed statement
    // — one whose goal is the ABSENCE of something — has no worked example to
    // pattern-match against, and that is exactly the shape that inverted.
    const supportExamples = EVALUATOR_SYSTEM_PROMPT.match(/\(SUPPORT\)/g) ?? [];
    expect(supportExamples.length).toBeGreaterThanOrEqual(2);
    expect(EVALUATOR_SYSTEM_PROMPT).not.toContain('(OPPOSE)');
  });

  it.todo(
    'carries an OPPOSE-framed worked example — deferred: evaluatorPromptV7.ts is GENERATED from ' +
      'docs/fix/07, so the fix edits that source and re-runs tools/extract-fix-prompt.mjs, and it ' +
      'lands only alongside the matching n8n edit (RECONCILIATION 2026-09-09)',
  );
});
