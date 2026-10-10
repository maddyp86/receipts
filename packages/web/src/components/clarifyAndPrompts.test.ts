import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  FEEDBACK_CONTROL_LABEL,
  FEEDBACK_PROMPT_BILL,
  FEEDBACK_PROMPT_RESULT,
  clarifyFor,
  type QueryResult,
} from '@receipts/shared';
import { scoreMatches, type ScorableMatch } from '../../../server/src/scoring/score.js';
import { ClarifyState } from './States.js';
import { Waiting } from './Waiting.js';
import { Verdict } from './Verdict.js';

// The test runner compiles JSX with the classic transform.
(globalThis as { React?: unknown }).React = React;

const text = (html: string) =>
  html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

// ===========================================================================
// "WHICH DO YOU WANT TO CHECK?" — a question that named no side.
// ===========================================================================

describe('the which-way screen', () => {
  const page = renderToStaticMarkup(
    React.createElement(ClarifyState, {
      clarify: clarifyFor('legal access to abortion'),
      onPick: () => {},
      onReset: () => {},
    }),
  );

  it('offers both sides, supports first, and a way to write your own', () => {
    const t = text(page);
    const supports = t.indexOf('Supports legal access to abortion');
    const opposes = t.indexOf('Opposes legal access to abortion');
    expect(supports).toBeGreaterThan(-1);
    expect(opposes).toBeGreaterThan(supports);
    expect(t).toContain('Write my own instead');
  });

  it('says it won’t guess, and is not dressed as an error', () => {
    expect(text(page)).toMatch(/We won’t guess/);
    expect(page).not.toMatch(/border-broken/);
    expect(text(page)).not.toMatch(/went wrong|couldn’t finish|try again/i);
  });
});

// ===========================================================================
// THE REWRITE is shown while the check runs, beside what was typed.
// ===========================================================================

describe('the waiting screen and a rewritten question', () => {
  const member = { politician_id: 'X000001', name: 'Jane Example', cached: true, chamber: 'senate' as const };
  const render = (rewritten: { original: string; statement: string } | null) =>
    text(
      renderToStaticMarkup(
        React.createElement(Waiting, {
          member, promise: rewritten?.statement ?? 'supports the widget tax', steps: [], interpretation: null,
          rewritten, onCancel: () => {},
        }),
      ),
    );

  it('shows both, the typed text first', () => {
    const page = render({ original: 'Did she vote to repeal the widget tax?', statement: 'supports repealing the widget tax' });
    const typed = page.indexOf('Did she vote to repeal the widget tax?');
    const checked = page.indexOf('supports repealing the widget tax');
    expect(typed).toBeGreaterThan(-1);
    expect(checked).toBeGreaterThan(typed);
    expect(page).toContain('We’re checking it as');
  });

  it('says nothing about a rewrite when there was none', () => {
    const page = render(null);
    expect(page).not.toContain('We’re checking it as');
    expect(page).toContain('You asked about: “supports the widget tax”');
  });
});

// ===========================================================================
// THE TWO PROMPTS show only when the server can store their answers.
// ===========================================================================

describe('the feedback prompts', () => {
  const scored = scoreMatches({
    promise_type: 'policy',
    statement_type: 'Policy Position',
    matches: [{
      action_uid: 'ACT-1', bill_id: 's1-119', title: 'A bill', summary: 'S.', intended_effects: 'E.',
      mechanisms: 'M.', action_type: 'voted', is_sponsor: false, is_cosponsor: false, vote: 'Yea',
      cloture_vote: 'NA', passage_vote: 'Yea', bill_keywords: [], primary_issue: 'x', sub_issue: 'y', source_url: '',
      score: 0.7, strength: 'STRONG', missing_fields: [], bill_effect: 'ADVANCE', bill_effect_reasoning: 'r',
      alignment_confidence: 0.9,
    } as ScorableMatch],
  });
  const result = {
    senator: { politician_id: 'X000001', name: 'Jane Example' },
    interpretation: {
      raw: 'x', restated: 'x', primary_issue: 'Health', sub_issue: '', stance: 'In Favor',
      statement_type: 'Policy Position', provenance: 'default', promise_type: 'policy',
    },
    scored,
    explanation: { why: 'Because.', connectors: {} },
    search: { returned: null, below_floor: null, evaluated: 1, admitted: 1, relevance_applied: true, exclusions: [] },
  } as unknown as QueryResult;

  const card = (feedbackAvailable: boolean, feedbackPrompts: boolean) =>
    text(renderToStaticMarkup(React.createElement(Verdict, { result, traceId: 'run-1', feedbackAvailable, feedbackPrompts })));

  it('on: one question under the answer and one under the bill', () => {
    const page = card(true, true);
    expect(page.split(FEEDBACK_PROMPT_RESULT)).toHaveLength(2);
    expect(page.split(FEEDBACK_PROMPT_BILL)).toHaveLength(2);
    expect(page).toMatch(/Did this answer what you asked\? Yes Partly No/);
    expect(page).toMatch(/Is this bill about what you asked\? Yes No/);
  });

  it('on: "Something look wrong?" is still there, for what a yes or no cannot say', () => {
    expect(card(true, true).split(FEEDBACK_CONTROL_LABEL).length).toBeGreaterThanOrEqual(3);
  });

  it('off: only "Something look wrong?", exactly as before', () => {
    const page = card(true, false);
    expect(page).not.toContain(FEEDBACK_PROMPT_RESULT);
    expect(page).not.toContain(FEEDBACK_PROMPT_BILL);
    expect(page).toContain(FEEDBACK_CONTROL_LABEL);
  });

  it('never without somewhere to send the answer', () => {
    const page = card(false, true);
    expect(page).not.toContain(FEEDBACK_PROMPT_RESULT);
    expect(page).not.toContain(FEEDBACK_PROMPT_BILL);
  });
});
