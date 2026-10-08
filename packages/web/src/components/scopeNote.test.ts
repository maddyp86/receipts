import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import * as shared from '@receipts/shared';
import { FEEDBACK_CONTROL_LABEL, RESULT_SCOPE_LINE, SCOPE_NOTE, type QueryResult } from '@receipts/shared';
import { scoreMatches, type ScorableMatch } from '../../../server/src/scoring/score.js';
import { Entry } from './Entry.js';
import { Verdict } from './Verdict.js';

// The test runner compiles JSX with the classic transform.
(globalThis as { React?: unknown }).React = React;

// ===========================================================================
// THE BETA SCOPE NOTE.
//
// Approved wording, on the entry page and under every verdict. It names no
// senator — the picker is the list, and it grows — and it points at the
// feedback control, so it shows only where that control does.
// ===========================================================================

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

const entry = (showScopeNote: boolean) =>
  text(
    renderToStaticMarkup(
      React.createElement(Entry, {
        senators: [{ politician_id: 'X000001', name: 'Jane Example', cached: true, party: 'D', state: 'XX' }],
        selected: 'X000001', promise: '', busy: false, showScopeNote,
        onSelect: () => {}, onPromiseChange: () => {}, onSubmit: () => {}, onExample: () => {},
      }),
    ),
  );

function verdict(feedbackAvailable: boolean, traceId: string | null = 'run-1'): string {
  const scored = scoreMatches({
    promise_type: 'policy',
    statement_type: 'Campaign Promise',
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
      statement_type: 'Campaign Promise', provenance: 'asserted', promise_type: 'policy',
    },
    scored,
    explanation: { why: 'Because.', connectors: {} },
    search: { returned: null, below_floor: null, evaluated: 1, admitted: 1, relevance_applied: true, exclusions: [] },
  } as unknown as QueryResult;
  return text(renderToStaticMarkup(React.createElement(Verdict, { result, traceId, feedbackAvailable })));
}

// The same whitespace folding the rendered page gets.
const plain = (s: string) => text(s);

describe('the wording', () => {
  it('says what was approved: the window, the example, the limits, the control', () => {
    const all = SCOPE_NOTE.join(' ');
    expect(all).toMatch(/^This is a beta\./);
    expect(all).toMatch(/the Senate record from January 2023 onward/);
    expect(all).toMatch(/the 2022 drug-pricing law, aren’t included/);
    expect(all).toMatch(/The senators covered so far are the ones you can pick below, and more are being added\./);
    expect(all).toMatch(/They can miss relevant bills, and they can be wrong\./);
    expect(all).toMatch(/Reports go to a person for review; they don’t change the answer on screen\.$/);
    expect(RESULT_SCOPE_LINE).toMatch(/^Beta · Senate record from January 2023 on\. Answers can miss bills or be wrong\./);
  });

  it('names the control by its own label', () => {
    expect(SCOPE_NOTE.join(' ')).toContain(`“${FEEDBACK_CONTROL_LABEL}”`);
    expect(RESULT_SCOPE_LINE).toContain(`“${FEEDBACK_CONTROL_LABEL}”`);
  });

  // More senators are coming. Any shared reader copy that names one of today's
  // two would read as the full list the day a third is added.
  it('no shared reader copy names a senator', () => {
    const strings: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'string') strings.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    for (const v of Object.values(shared)) walk(v);
    expect(strings.length).toBeGreaterThan(50);
    expect(strings.filter((s) => /schumer|thune/i.test(s))).toEqual([]);
  });
});

describe('where it shows', () => {
  it('the entry page, above the picker, when feedback is on', () => {
    const page = entry(true);
    expect(page).toContain(plain(SCOPE_NOTE[0]!));
    expect(page.indexOf('This is a beta')).toBeLessThan(page.indexOf('Jane Example'));
  });

  it('not on the entry page without feedback: it would point at a control that is not there', () => {
    expect(entry(false)).not.toContain('This is a beta');
  });

  it('under every verdict, when feedback is on', () => {
    expect(verdict(true)).toContain(plain(RESULT_SCOPE_LINE));
  });

  it('not without feedback, nor without a run to tie it to', () => {
    expect(verdict(false)).not.toContain('Beta ·');
    expect(verdict(true, null)).not.toContain('Beta ·');
  });
});
