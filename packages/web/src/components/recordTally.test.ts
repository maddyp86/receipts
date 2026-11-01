import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { QueryResult } from '@receipts/shared';
import { VerdictCard, recordSteps } from './Verdict.js';

(globalThis as { React?: unknown }).React = React;

// ===========================================================================
// THE RECORD CARD (Matt, 1 Nov, Thune / Laken Riley Act). Chips, a bar of one
// block per action and "Of the 10 actions about your question, 6 push toward"
// mixed bills and actions, and nothing visibly added up. The card is a
// snapshot, so it walks the numbers in order, each with its unit:
//   [8 bills on your question] [6 of Thune's actions count toward it] [4 of Thune's actions don't count]
//   Searched all 555 of Thune's recorded actions since January 2023.
// The rows below are that run's (8 bills, 10 actions).
// ===========================================================================

type Rows = NonNullable<QueryResult['record']>['rows'];
const row = (bill_id: string, stage: Rows[number]['stage'], reading: string, vote: string | null = null, broad = false) =>
  ({ action_uid: `ACT-${bill_id}`, bill_id, stage, vote, reading, bill_effect: reading === 'for' ? 'ADVANCE' : 'NEUTRAL', broad }) as Rows[number];

const THUNE: Rows = [
  row('s5183-118', 'cosponsor', 'not_counted'),
  row('s733-118', 'sponsor', 'not_counted'),
  row('s333-118', 'cosponsor', 'for'),
  row('s160-118', 'cosponsor', 'for'),
  row('s5-119', 'cloture', 'for', 'YEA'),
  row('s5-119', 'passage', 'for', 'YEA'),
  row('s5-119', 'cosponsor', 'for'),
  row('s3933-118', 'cosponsor', 'for'),
  row('s2-119', 'passage', 'not_counted', 'YEA', true),
  row('sjres18-118', 'passage', 'not_counted', 'YEA'),
];

const result = (rows: Rows, name = 'John Thune', search = { evaluated: 10, admitted: 8 }, record_actions = 555) =>
  ({
    senator: { politician_id: 'T000250', name, cached: true, record_actions },
    interpretation: { raw: 'Did they vote for the Laken Riley Act?', restated: 'x', primary_issue: 'x', sub_issue: 'x', stance: 'In Favor', statement_type: 'Policy Position', provenance: 'default', promise_type: 'policy' },
    scored: { verdict: 'KEPT', band: 'Medium', mode: 'ranked', nd_reason: null, ranked: [], evidence: [], receipt: {} },
    explanation: { why: 'Because.', connectors: {}, confidence: 0.8, card_summary: 'Thune voted for the Laken Riley Act.' },
    coverage: { congresses: [118, 119], observed: null, unknown: false },
    search: { returned: 10, below_floor: 0, ...search, relevance_applied: true, exclusions: [] },
    record: { label: 'VOTED_FOR', reason: 'VOTES', rows, counted: { for: 2, against: 0 }, set_aside: 0 },
    gated: [],
  }) as unknown as QueryResult;

const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

describe('the record steps', () => {
  it('the Thune case: 10 bills read, 8 about it, 10 actions on those 8, 6 counted', () => {
    expect(recordSteps(result(THUNE))).toEqual({ read: 10, about: 8, actions: 10, actionBills: 8, toward: 6, against: 0, notCounted: 4 });
  });

  it('nothing to step through when no bill was about the question', () => {
    expect(recordSteps(result([], 'John Thune', { evaluated: 2, admitted: 0 }))).toBeNull();
  });
});

describe('the record card on the page', () => {
  const html = renderToStaticMarkup(React.createElement(VerdictCard, { result: result(THUNE) }));
  const text = textOf(html);
  const boxes = (h: string) => [...h.matchAll(/data-box="(\w+)"/g)].map((m) => m[1]);

  it('three boxes: the bills, then the actions split by how they count', () => {
    expect(boxes(html)).toEqual(['bills', 'toward', 'not']);
    expect(text).toMatch(/8 bills on your question 6 of Thune’s actions count toward it 4 of Thune’s actions don’t count/);
    expect(text).not.toMatch(/read closely|actions Thune took/);
  });

  it('says what the search covered, and nothing more', () => {
    expect(text).toContain('Searched all 555 of Thune’s recorded actions since January 2023.');
    expect(text).not.toContain('One bill can carry several actions');
    expect(text).not.toContain('came closest');
  });

  it('keeps the description, after the boxes; no chips, no bar, no bill list', () => {
    expect(text.indexOf('Thune voted for the Laken Riley Act.')).toBeGreaterThan(text.indexOf('Searched all 555'));
    expect(html).not.toContain('search-funnel');
    expect(html).not.toContain('role="img"');
    expect(html).not.toContain('record-list');
  });

  it('an action against gets its own box; an empty category gets none', () => {
    const ossoff = [row('s3385', 'cloture', 'for', 'YEA'), row('s46', 'cosponsor', 'for'), row('s4684', 'cosponsor', 'for'), row('s2556', 'cosponsor', 'against')];
    const h = renderToStaticMarkup(React.createElement(VerdictCard, { result: result(ossoff, 'Jon Ossoff', { evaluated: 10, admitted: 4 }, 705) }));
    expect(boxes(h)).toEqual(['bills', 'toward', 'against']);
    expect(textOf(h)).toContain('1 of Ossoff’s actions counts against it');
  });

  it('all four when every kind is there, two columns on a phone', () => {
    const rows = [row('a', 'cloture', 'for', 'YEA'), row('b', 'cosponsor', 'against'), row('c', 'passage', 'not_counted', 'YEA')];
    const h = renderToStaticMarkup(React.createElement(VerdictCard, { result: result(rows, 'John Thune', { evaluated: 10, admitted: 3 }) }));
    expect(boxes(h)).toEqual(['bills', 'toward', 'against', 'not']);
    expect(h).toContain('grid-cols-2 sm:grid-cols-4');
  });
});
