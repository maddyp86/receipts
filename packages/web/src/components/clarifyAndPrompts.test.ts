import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  FEEDBACK_CONTROL_LABEL,
  FEEDBACK_PROMPT_BILL,
  FEEDBACK_PROMPT_RESULT,
  clarifyFor,
  type Interpretation,
  type QueryResult,
} from '@receipts/shared';
import { scoreMatches, type ScorableMatch } from '../../../server/src/scoring/score.js';
import { ClarifyState } from './States.js';
import { QuestionCard, Waiting, checkingLine } from './Waiting.js';
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
  const interpretation = {
    raw: 'x', restated: 'Support passage of the widget tax repeal', primary_issue: 'Taxes', sub_issue: 'Excise Taxes',
    stance: 'In Favor', statement_type: 'Policy Position', provenance: 'default', promise_type: 'policy',
  } as unknown as Interpretation;
  const render = (rewritten: { original: string; statement: string } | null, interp: Interpretation | null = null) =>
    renderToStaticMarkup(
      React.createElement(Waiting, {
        member, promise: rewritten?.statement ?? 'supports the widget tax', steps: [], interpretation: interp,
        rewritten, onCancel: () => {}, onChange: () => {},
      }),
    );

  it('says what they asked, then what we are checking to answer it', () => {
    const page = text(render({ original: 'Did she vote to repeal the widget tax?', statement: 'supports repealing the widget tax' }));
    const typed = page.indexOf('You asked “Did she vote to repeal the widget tax?”');
    const checked = page.indexOf('We’re checking whether Example’s votes and bills back repealing the widget tax.');
    expect(typed).toBeGreaterThan(-1);
    expect(checked).toBeGreaterThan(typed);
    expect(page).toContain('Not quite right? Change it');
  });

  it('never tells the reader their question was the wrong kind of thing', () => {
    const page = text(render({ original: 'Did she vote to repeal the widget tax?', statement: 'supports repealing the widget tax' }, interpretation));
    expect(page).not.toMatch(/has no side|A question has/);
  });

  it('is one card: no second "How we read it", no paraphrase repeating it, no stance chip', () => {
    const page = text(render({ original: 'Did she vote to repeal the widget tax?', statement: 'supports repealing the widget tax' }, interpretation));
    expect(page).not.toContain('How we read it');
    expect(page).not.toContain('Support passage of the widget tax repeal');
    expect(page).not.toMatch(/Wants this to happen|Wants to stop this/);
    expect(page).toContain('Taxes');
    expect(page).toContain('Excise Taxes');
    expect(page.match(/Not quite right\? Change it/g)).toHaveLength(1);
  });

  it('puts the progress straight under the card', () => {
    const html = render({ original: 'Did she vote to repeal the widget tax?', statement: 'supports repealing the widget tax' }, interpretation);
    expect(html.indexOf('Reading what you wrote')).toBeGreaterThan(html.indexOf('Not quite right? Change it'));
    expect(html.indexOf('Reading what you wrote')).toBeLessThan(html.indexOf('Good to know'));
  });

  it('with no rewrite, shows what they typed, and how we read it once that is known', () => {
    expect(text(render(null))).toContain('You asked “supports the widget tax”');
    expect(text(render(null))).not.toContain('Change it');
    expect(text(render(null, interpretation))).toContain('We’re checking Example’s votes and bills against “Support passage of the widget tax repeal”.');
  });
});

describe('checkingLine', () => {
  it.each([
    ['supports the Laken Riley Act', 'We’re checking whether Schumer’s votes and bills back the Laken Riley Act.'],
    ['opposes federal funding for abortion.', 'We’re checking whether Schumer’s votes and bills work against federal funding for abortion.'],
    ['promised to lower drug prices', 'We’re checking whether Schumer’s votes and bills follow through on a promise to lower drug prices.'],
    ['Protect clean air standards', 'We’re checking Schumer’s votes and bills against “Protect clean air standards”.'],
  ])('%s', (statement, line) => {
    expect(checkingLine(statement, 'Charles E. Schumer')).toBe(line);
  });

  it('never says we are checking whether they made the promise (2026-10-10)', () => {
    expect(checkingLine('promised to lower drug prices', 'Charles E. Schumer', true)).toBe(
      'We checked whether Schumer’s votes and bills followed through on a promise to lower drug prices.',
    );
    for (const st of ['promised to lower drug prices', 'supports the Laken Riley Act', 'opposes new tariffs']) {
      expect(checkingLine(st, 'Charles E. Schumer')).not.toMatch(/whether Schumer (promised|supports|opposes)/);
    }
  });

  it('says it in the past once the answer is in', () => {
    expect(checkingLine('supports the Laken Riley Act', 'Charles E. Schumer', true)).toBe(
      'We checked whether Schumer’s votes and bills back the Laken Riley Act.',
    );
  });

  it('the card says what we filed it under', () => {
    const html = renderToStaticMarkup(
      React.createElement(QuestionCard, {
        asked: 'He promised to lower drug prices. What did he do to follow through on that?',
        statement: 'promised to lower drug prices', memberName: 'Charles E. Schumer', done: true, onChange: () => {},
        interpretation: { primary_issue: 'Health Care', sub_issue: 'Prescription Drugs' } as unknown as Interpretation,
      }),
    );
    expect(text(html)).toContain('Filed under Health Care Prescription Drugs');
    expect(text(html)).toContain('Not quite right? Change it');
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
