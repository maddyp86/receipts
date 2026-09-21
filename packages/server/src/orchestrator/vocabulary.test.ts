import { describe, expect, it } from 'vitest';
import { outcomeHeadline, verdictWord } from '@receipts/shared';
import { explanationProblems } from './dispatch.js';
import { EXPLANATION_CONSTRAINTS } from './prompts.js';
import { stubExplanation } from '../llm/stub.js';
import type { ScoredResult, Senator } from '@receipts/shared';

// ===========================================================================
// The vocabulary rule, end to end.
//
// Internally a consistent policy position and a kept campaign promise are the
// same bucket: KEPT. The words a reader sees must not be. A free-typed
// statement is a Policy Position by default, because there is no evidence a
// promise was made — and a headline that says "Kept" over it asserts a
// commitment nobody made. That headline shipped: Verdict.tsx printed the
// bucket's phrase while every evidence card beneath it said CONSISTENT.
//
// Three layers have to agree for the fix to hold: the headline copy, the
// explanation the model writes, and the guard that rejects the wrong words.
// ===========================================================================

describe('outcomeHeadline — the label follows the statement type', () => {
  it('a Policy Position is consistent or counter, never kept or broke', () => {
    expect(outcomeHeadline('KEPT', 'Policy Position', 'default')).toMatch(/consistent with this position/);
    expect(outcomeHeadline('BROKE', 'Policy Position', 'default')).toMatch(/runs counter to this position/);
    for (const o of ['KEPT', 'BROKE'] as const) {
      expect(outcomeHeadline(o, 'Policy Position', 'default')).not.toMatch(/\b(kept|broke)\b/i);
    }
  });

  it('a corpus-verified Campaign Promise earns the promise words', () => {
    expect(outcomeHeadline('KEPT', 'Campaign Promise', 'corpus')).toBe('Kept');
    expect(outcomeHeadline('BROKE', 'Campaign Promise', 'corpus')).toBe('Broke');
  });

  it('an asserted premise is attributed to the reader', () => {
    expect(outcomeHeadline('KEPT', 'Campaign Promise', 'asserted')).toMatch(/^You indicated/);
  });

  it('never assumes a pronoun for the senator', () => {
    for (const o of ['KEPT', 'BROKE'] as const) {
      expect(outcomeHeadline(o, 'Policy Position', 'default')).not.toMatch(/\b(his|her)\b/i);
      expect(outcomeHeadline(o, 'Campaign Promise', 'asserted')).not.toMatch(/\b(his|her)\b/i);
    }
  });
});

describe('verdictWord — the short label for section headings', () => {
  it('speaks position vocabulary for a Policy Position', () => {
    expect(verdictWord('KEPT', 'Policy Position')).toBe('Consistent');
    expect(verdictWord('BROKE', 'Policy Position')).toBe('Runs counter');
  });
  it('speaks promise vocabulary for a Campaign Promise', () => {
    expect(verdictWord('KEPT', 'Campaign Promise')).toBe('Kept');
    expect(verdictWord('BROKE', 'Campaign Promise')).toBe('Broke');
  });
});

describe('explanationProblems — the guard rejects the wrong vocabulary', () => {
  it('rejects kept/broke/broken on a Policy Position', () => {
    for (const why of [
      'The senator kept this promise by co-sponsoring the bill.',
      'This produced a "Kept" outcome with medium confidence.',
      'The record shows the promise was broken.',
      'On this pledge, the senator broke faith with what was said.',
      'The verdict here is kept.',
    ]) {
      const problems = explanationProblems(why, 'KEPT', 'Policy Position');
      expect(problems.some((p) => /stated position/.test(p)), why).toBe(true);
    }
  });

  it('does NOT reject kept/broke used as ordinary verbs about the bill', () => {
    // Both of these are real model outputs the first version of the guard
    // bounced. "kept ... in place" is about the rule, not the promise.
    for (const why of [
      'Because a NAY vote defeated the disapproval resolution and kept the underlying EPA rule in place, this vote is consistent with the position.',
      'The senator voted NAY, which defeated the resolution and kept the clean air rule in effect. The record is consistent with the position.',
    ]) {
      expect(explanationProblems(why, 'KEPT', 'Policy Position'), why).toEqual([]);
    }
  });

  it('accepts consistent/counter wording on a Policy Position', () => {
    const why =
      'Senator Schumer co-sponsored two bills requiring background checks on every sale. ' +
      'That record is consistent with the position you asked about.';
    expect(explanationProblems(why, 'KEPT', 'Policy Position')).toEqual([]);
  });

  it('still allows kept/broke on a Campaign Promise', () => {
    expect(explanationProblems('They kept the promise by voting yes.', 'KEPT', 'Campaign Promise')).toEqual([]);
  });

  it('defaults to the promise vocabulary when no type is given (existing callers)', () => {
    expect(explanationProblems('They kept the promise.', 'KEPT')).toEqual([]);
  });
});

describe('the demo stub obeys the same rule', () => {
  const senator: Senator = { politician_id: 'S000148', name: 'Chuck Schumer', cached: true };
  const ranked = {
    verdict: 'KEPT',
    band: 'Medium',
    mode: 'ranked',
    nd_reason: null,
    ranked: [],
    receipt: {} as never,
    evidence: [],
  } as unknown as ScoredResult;

  it('never says Kept in ranked mode — the guard would reject it live', () => {
    const { why } = stubExplanation(ranked, senator);
    expect(explanationProblems(why, 'KEPT', 'Policy Position')).toEqual([]);
    expect(why).toMatch(/consistent with it/);
  });
});

describe('the explanation constraints ask for a reply, not a report', () => {
  // The shape lives in prose the model reads, so the only way to pin it is to
  // assert the prose. Each of these is a clause the 2026-09-20 review asked for.
  it('opens from the reader\'s question and addresses the reader', () => {
    expect(EXPLANATION_CONSTRAINTS).toMatch(/Open by naming what they asked/);
    expect(EXPLANATION_CONSTRAINTS).toMatch(/Address the reader; never address the senator/);
  });

  it('REQUIRES a sentence for what was seen and set aside', () => {
    expect(EXPLANATION_CONSTRAINTS).toMatch(/REQUIRED whenever anything was found but not counted/);
    expect(EXPLANATION_CONSTRAINTS).toMatch(/INCLUDING the neutral ones/);
  });

  it('keeps every hard constraint from the port', () => {
    for (const rule of [
      'NEVER compute, adjust, second-guess, or comment on any number',
      'NEVER contradict the verdict you are given',
      'NEVER speculate about motive',
      'Do not use the words score, modifier, points, similarity, threshold, or confidence band',
      'never write kept, broke or broken',
      'a NAY DEFEATS the resolution and PRESERVES the underlying policy',
      'Name cloture and passage separately',
    ]) {
      expect(EXPLANATION_CONSTRAINTS, rule).toContain(rule);
    }
  });
});
