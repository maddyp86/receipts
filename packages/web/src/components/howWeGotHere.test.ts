import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { QueryResult, ScoredResult } from '@receipts/shared';
import { scoreMatches, type ScorableMatch } from '../../../server/src/scoring/score.js';
import { HowWeGotHere } from './HowWeGotHere.js';

// The test runner compiles JSX with the classic transform.
(globalThis as { React?: unknown }).React = React;

// ===========================================================================
// HONESTY SWEEP — "How we got here" agrees with the verdict beneath it.
// Scored by the real scorer, rendered by the real component.
// ===========================================================================

let uid = 0;
function row(over: Partial<ScorableMatch> = {}): ScorableMatch {
  uid += 1;
  return {
    action_uid: `ACT-${uid}`, bill_id: `s${uid}-119`, title: 'A bill', summary: 'S.', intended_effects: 'E.',
    mechanisms: 'M.', action_type: 'voted', is_sponsor: false, is_cosponsor: false, vote: 'Yea',
    cloture_vote: 'NA', passage_vote: 'Yea', bill_keywords: [], primary_issue: 'x', sub_issue: 'y', source_url: '',
    score: 0.7, strength: 'STRONG', missing_fields: [], bill_effect: 'ADVANCE', bill_effect_reasoning: 'r',
    alignment_confidence: 0.9,
    ...over,
  } as ScorableMatch;
}
const ABSTAIN = { vote: 'Not Voting', passage_vote: 'Not Voting', cloture_vote: 'NA' };

const run = (matches: ScorableMatch[]) =>
  scoreMatches({ promise_type: 'policy', statement_type: 'Campaign Promise', matches });

function walkthrough(scored: ScoredResult): string[] {
  const result = {
    senator: { name: 'Jane Example' },
    interpretation: {
      raw: 'x', restated: 'x', primary_issue: 'Health', sub_issue: '', stance: 'In Favor',
      statement_type: 'Campaign Promise', provenance: 'asserted', promise_type: 'policy',
    },
    scored,
    search: { returned: null, below_floor: null, evaluated: scored.evidence.length, admitted: scored.evidence.length, relevance_applied: true, exclusions: [] },
  } as unknown as QueryResult;
  const html = renderToStaticMarkup(React.createElement(HowWeGotHere, { result }));
  return [...html.matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, '').replace(/&#x27;|’/g, "'"));
}
const step = (lines: string[], title: string) => lines.find((l) => l.startsWith(`${title}.`)) ?? '';

describe('"How we got here", step 5, agrees with the verdict beneath it', () => {
  const STEP5 = 'Which way each bill pushes your goal';

  // The senator voted no on a bill read as setting the goal back: KEPT. Step 5
  // counted direction_split, so it said the bill "would move your goal
  // forward" — the opposite of the evaluator's reading.
  it('a no vote on a bill that sets the goal back: the bill is said to set it back', () => {
    const r = run([row({ bill_effect: 'HINDER', vote: 'Nay', passage_vote: 'Nay' })]);
    expect(r.verdict).toBe('KEPT');
    const s5 = step(walkthrough(r), STEP5);
    expect(s5).toMatch(/1 would set it back/);
    expect(s5).not.toMatch(/would move your goal forward/);
  });

  // Every undirected row was "about something else". An unread bill was not.
  it('a failed read is not "about something else"', () => {
    const r = run([row({ bill_effect: 'ERROR', alignment_confidence: 0 })]);
    expect(r.nd_reason).toBe('EVALUATION_FAILED');
    const s5 = step(walkthrough(r), STEP5);
    expect(s5).toMatch(/1 could not be read against your statement/);
    expect(s5).not.toMatch(/something else/);
  });

  // ABSTAINED says the bill could bear on the statement; step 5 said it was
  // about something else.
  it('an abstention on a bill read as advancing the goal', () => {
    const r = run([row(ABSTAIN)]);
    expect(r.nd_reason).toBe('ABSTAINED');
    expect(step(walkthrough(r), STEP5)).toMatch(/1 would move your goal forward/);
  });

  it('a contested bill is said to cut both ways', () => {
    const s5 = step(walkthrough(run([row({ bill_effect: 'CONTESTED' })])), STEP5);
    expect(s5).toMatch(/could reasonably be read either way/);
  });

  it('a no-effect bill is said not to move it, as a reading', () => {
    const s5 = step(walkthrough(run([row({ bill_effect: 'NEUTRAL' })])), STEP5);
    expect(s5).toMatch(/As we read them: 1 does not move it either way/);
  });

  // The last step said "this reading does not accuse" of an accusation that
  // a rule withheld before review.
  it('step 8 does not deny an accusation that was withheld before review', () => {
    const r = run([row({ vote: 'Nay', passage_vote: 'Nay', alignment_confidence: 0.6 })]);
    expect(r.nd_reason).toBe('WITHHELD_LOW_CONFIDENCE');
    const s8 = step(walkthrough(r), 'A second look');
    expect(s8).toMatch(/withheld by the rule above/);
    expect(s8).not.toMatch(/This reading does not/);
  });
});

