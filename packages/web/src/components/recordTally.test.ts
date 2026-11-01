import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { QueryResult } from '@receipts/shared';
import { VerdictCard, recordActionPhrase, recordBills, recordCountLine } from './Verdict.js';

(globalThis as { React?: unknown }).React = React;

// ===========================================================================
// THE RECORD CARD (Matt, 1 Nov, Thune / Laken Riley Act). The card carried
// "10 read closely" and "8 about your question" chips, a bar of 10 blocks and
// "Of the 10 actions about your question, 6 push toward…". Bills and actions
// were mixed and nothing visibly added up. It now says one line and lists the
// bills, each with what the senator did on it; the search is one sentence.
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

describe('the record card, in words', () => {
  it('one line that accounts for every action, and says bills and actions apart', () => {
    expect(recordCountLine(THUNE, 'Thune')).toBe(
      'Of Thune’s 10 actions on these 8 bills, 6 count toward what you asked about and 4 don’t count either way.'.replace(/’(?=t)/, "'"),
    );
  });

  it('says what counts against, and what was set aside', () => {
    const rows = [row('a', 'cloture', 'for', 'YEA'), row('b', 'cosponsor', 'against'), row('c', 'passage', 'not_counted', 'NAY')];
    expect(recordCountLine(rows, 'Ossoff', 2)).toBe(
      "Of Ossoff’s 3 actions on these 3 bills, 1 counts toward what you asked about, 1 counts against it, and 1 doesn't count either way. 2 more were set aside by our rules.",
    );
    expect(recordCountLine([row('a', 'passage', 'for', 'YEA')], 'Thune')).toBe(
      'Thune took one action on this bill, and it counts toward what you asked about.',
    );
  });

  it('each action in plain words', () => {
    expect(recordActionPhrase(row('x', 'cloture', 'for', 'YEA'))).toBe('Voted Yes to end debate');
    expect(recordActionPhrase(row('x', 'passage', 'for', 'NAY'))).toBe('Voted No to pass');
    expect(recordActionPhrase(row('x', 'cosponsor', 'for'))).toBe('Co-sponsored');
    expect(recordActionPhrase(row('x', 'sponsor', 'for'))).toBe('Sponsored');
  });

  it('groups the actions by bill: counted first, the bill with votes first', () => {
    const bills = recordBills(THUNE);
    expect(bills.map((b) => b.bill_id)).toEqual(['s5-119', 's333-118', 's160-118', 's3933-118', 's2-119', 'sjres18-118', 's5183-118', 's733-118']);
    expect(bills[0]).toEqual({ bill_id: 's5-119', reading: 'for', actions: ['Co-sponsored', 'Voted Yes to end debate', 'Voted Yes to pass'], broad: false });
    expect(bills.find((b) => b.bill_id === 's2-119')).toMatchObject({ reading: 'not_counted', broad: true });
  });
});

describe('the record card on the page', () => {
  const result = {
    senator: { politician_id: 'T000250', name: 'John Thune', cached: true, record_actions: 555 },
    interpretation: { raw: 'Did they vote for the Laken Riley Act?', restated: 'x', primary_issue: 'x', sub_issue: 'x', stance: 'In Favor', statement_type: 'Policy Position', provenance: 'default', promise_type: 'policy' },
    scored: { verdict: 'KEPT', band: 'Medium', mode: 'ranked', nd_reason: null, ranked: [], evidence: [{ bill_id: 's5-119', title: 'A bill to require the Secretary of Homeland Security to take into custody aliens who have been charged with theft.' }], receipt: {} },
    explanation: { why: 'Because.', connectors: {}, confidence: 0.8 },
    coverage: { congresses: [118, 119], observed: null, unknown: false },
    search: { returned: 10, below_floor: 0, evaluated: 10, admitted: 8, relevance_applied: true, exclusions: [] },
    record: { label: 'VOTED_FOR', reason: 'VOTES', rows: THUNE, counted: { for: 2, against: 0 }, set_aside: 0 },
    gated: [],
  } as unknown as QueryResult;
  const html = renderToStaticMarkup(React.createElement(VerdictCard, { result }));
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

  it('has no chips and no bar', () => {
    expect(html).not.toContain('search-funnel');
    expect(html).not.toContain('role="img"');
    expect(text).not.toMatch(/read closely|about your question\b(?! and)/);
  });

  it('lists each bill with what he did, then the ones not counted and why', () => {
    expect(text).toContain('S. 5 · 119th Congress');
    expect(text).toContain('Co-sponsored · Voted Yes to end debate · Voted Yes to pass');
    expect(text).toContain('Not counted');
    expect(text).toMatch(/S\. 2 · Voted Yes to pass\. Too broad to count/);
    expect((html.match(/data-reading="for"/g) ?? []).length).toBe(4);
    expect((html.match(/data-reading="not_counted"/g) ?? []).length).toBe(4);
  });

  it('says what the search did in one sentence, in bills', () => {
    expect(text).toContain('We searched all 555 of Thune’s recorded actions since January 2023. Ten bills came close to your question, and eight were actually about it.');
  });
});
