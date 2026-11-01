import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { QueryResult } from '@receipts/shared';
import { VerdictCard, recordSteps, recordStepsTally } from './Verdict.js';

(globalThis as { React?: unknown }).React = React;

// ===========================================================================
// THE RECORD CARD (Matt, 1 Nov, Thune / Laken Riley Act). Chips, a bar of one
// block per action and "Of the 10 actions about your question, 6 push toward"
// mixed bills and actions, and nothing visibly added up. The card is a
// snapshot, so it walks the numbers in order, each with its unit:
//   8 bills on your question → 10 actions Thune took on them
//   ✓ 6 count toward what you asked about · 4 don't count either way
//   Searched all 555 of Thune's recorded actions since January 2023 and read the 10 bills that came closest.
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

  it('the tally line names actions, and leaves out what is zero', () => {
    expect(recordStepsTally(recordSteps(result(THUNE))!)).toEqual({
      toward: '6 count toward what you asked about',
      against: null,
      not: "4 don't count either way",
    });
    const one = recordStepsTally({ read: 10, about: 2, actions: 2, actionBills: 2, toward: 1, against: 1, notCounted: 0 });
    expect(one).toEqual({ toward: '1 counts toward what you asked about', against: '1 counts against it', not: null });
  });

  it('nothing to step through when no bill was about the question', () => {
    expect(recordSteps(result([], 'John Thune', { evaluated: 2, admitted: 0 }))).toBeNull();
  });
});

describe('the record card on the page', () => {
  const html = renderToStaticMarkup(React.createElement(VerdictCard, { result: result(THUNE) }));
  const text = textOf(html);

  it('shows two steps, each with its unit, and no "read closely" box', () => {
    expect(text).toMatch(/8 bills on your question .*10 actions Thune took on them/);
    expect(text).not.toMatch(/bills read closely/);
    expect(text).toContain("✓ 6 count toward what you asked about · 4 don't count either way");
  });

  it('says one bill can carry several actions when it does, and what the search covered', () => {
    expect(text).toContain('One bill can carry several actions');
    expect(text).toContain('Searched all 555 of Thune’s recorded actions since January 2023 and read the 10 bills that came closest.');
  });

  it('keeps the description, after the steps; no chips, no bar, no bill list', () => {
    expect(text.indexOf('Thune voted for the Laken Riley Act.')).toBeGreaterThan(text.indexOf('Searched all 555'));
    expect(html).not.toContain('search-funnel');
    expect(html).not.toContain('role="img"');
    expect(html).not.toContain('record-list');
  });

  it('drops the several-actions note when every bill has one action, and says "of them" when not every bill has one', () => {
    const ossoff = [row('s3385', 'cloture', 'for', 'YEA'), row('s46', 'cosponsor', 'for'), row('s4684', 'cosponsor', 'for'), row('s2556', 'cosponsor', 'against')];
    const t = textOf(renderToStaticMarkup(React.createElement(VerdictCard, { result: result(ossoff, 'Jon Ossoff', { evaluated: 10, admitted: 5 }, 705) })));
    expect(t).not.toContain('One bill can carry several actions');
    expect(t).toContain('4 actions Ossoff took on 4 of them');
    expect(t).toContain('✕ 1 counts against it');
  });
});
