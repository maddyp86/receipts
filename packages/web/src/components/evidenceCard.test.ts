import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DirectedAction } from '@receipts/shared';
import { EvidenceCard } from './EvidenceCard.js';

// The test runner compiles JSX with the classic transform.
(globalThis as { React?: unknown }).React = React;

// ===========================================================================
// THE EVIDENCE CARD (2026-10-11). How the bill counts sits in the corner as a
// green / red / yellow chip that opens a plain explanation; the vote and the
// bill's effect are two boxes with no "+" between them; the bill's path is a
// section of its own; and nothing on the card is internal grading language.
// The case is hconres89-119, Thune's NO on the War Powers resolution.
// ===========================================================================

const base = {
  action_uid: 'ACT-hconres89-119-T000250', bill_id: 'hconres89-119', congress: 119,
  title: 'Directing the President, pursuant to section 5(c) of the War Powers Resolution, to remove United States Armed Forces from hostilities with Iran.',
  summary: 'S.', intended_effects: 'E.', mechanisms: 'M.', action_type: 'voted', is_sponsor: false, is_cosponsor: false,
  vote: 'Nay', cloture_vote: 'NA', passage_vote: 'NAY', passage_vote_date: '2026-09-24', bill_keywords: [],
  primary_issue: 'Foreign Policy & Defense', sub_issue: 'War & Peace / Military Action', source_url: 'https://www.congress.gov/x',
  score: 0.52, strength: 'WEAK', missing_fields: [], bill_effect: 'ADVANCE', bill_effect_reasoning: 'r', outcome: 'INCONSISTENT',
  direction: 'breaks', evidence_type: 'vote', action_tier: 'VOTE', vote_pattern: 'x', weight: 1, scoring_flags: [],
  vote_governing: 'PASSAGE (no cloture vote)', vote_flags: ['FLOOR_LEADER'], alignment_confidence: 0.8,
  path: [
    { label: 'Introduced', date: null },
    { label: 'Passed the House', date: '2026-07-23', note: 'the text we read' },
    { label: 'Final vote', date: '2026-09-24', senator: { act: 'No' } },
    { label: 'Failed in a floor vote', date: null, outcome: true },
  ],
} as unknown as DirectedAction;

const render = (over: Partial<DirectedAction> = {}, showDirection = true) =>
  renderToStaticMarkup(
    React.createElement(EvidenceCard, {
      action: { ...base, ...over } as DirectedAction,
      connector: 'This resolution would have forced a withdrawal from hostilities with Iran. Thune voted no, and it failed.',
      senatorName: 'John Thune',
      showDirection,
    }),
  );
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

describe('the chip in the corner', () => {
  it('a NO on a bill that moves the goal forward: red "Counts against", explained in words', () => {
    const html = render();
    expect(html).toMatch(/data-count="against"[^>]*>|class="[^"]*bg-broken-wash[^"]*"[^>]*data-count="against"/);
    expect(text(html)).toContain('Counts against');
    expect(text(html)).toContain('What “counts against” means here. Thune voted no on a bill that, as we read it, would move the goal in your question forward, so this goes against the statement.');
  });

  it('green for counts toward, and yellow for not counted, each with its reason', () => {
    expect(render({ direction: 'keeps', bill_effect: 'HINDER' } as Partial<DirectedAction>)).toContain('bg-kept-wash');
    const neutral = render({ direction: 'neutral', bill_effect: 'NEUTRAL' } as Partial<DirectedAction>);
    expect(neutral).toContain('bg-pending-wash');
    expect(text(neutral)).toContain('Not counted');
    expect(text(neutral)).toContain('not moving the goal in your question either way');
  });

  it('on an answer with no verdict, every bill is "Not counted", saying why', () => {
    const t = text(render({}, false));
    expect(t).toContain('Not counted');
    expect(t).toContain('The answer as a whole doesn’t settle your question');
    expect(t).not.toContain('Counts against');
  });
});

describe('the rest of the card', () => {
  const t = text(render());

  it('keeps the description, the topic line, and the vote with its date', () => {
    expect(t).toContain('Thune voted no, and it failed.');
    expect(t).toContain('Foreign Policy & Defense / War & Peace / Military Action');
    expect(t).toContain('Voted NO');
    expect(t).toMatch(/on final passage · September 24, 2026/);
  });

  it('has no "+" between the boxes and none of the old grading language', () => {
    expect(render()).not.toContain('lucide-plus');
    expect(t).not.toContain('Shown for you to read');
    expect(t).not.toMatch(/Loosely related|Closely related/);
  });

  it('draws the bill\'s path, with the senator\'s own act on it', () => {
    expect(t).toContain('The bill’s path');
    expect(t).toMatch(/Passed the House Jul 23, 2026 the text we read/);
    expect(t).toMatch(/Final vote Sep 24, 2026 Thune: No/);
    expect(t).toContain('Failed in a floor vote');
    // The path marks the text we read, so the sentence saying it again is gone.
    expect(t).not.toContain('Judged against the text in effect');
  });

  it('the leadership note only where it changes the reading: a NO on ending debate', () => {
    expect(t).not.toMatch(/floor leader/i);
    const t2 = text(render({ cloture_vote: 'NAY', cloture_vote_date: '2026-09-20' } as Partial<DirectedAction>));
    expect(t2).toContain('Thune was a floor leader at the time. Leaders sometimes vote no on ending debate');
  });

  it('"What this bill does" is a full-width bar with no preview line', () => {
    expect(t).toContain('What this bill does');
    expect(t).not.toMatch(/Summary · How it works/);
  });
});
