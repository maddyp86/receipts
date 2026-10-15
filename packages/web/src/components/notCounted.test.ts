import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { NotCountedAction, QueryResult } from '@receipts/shared';
import { NotCounted } from './NotCounted.js';
import { HowWeGotHere } from './HowWeGotHere.js';

// The test runner compiles JSX with the classic transform.
(globalThis as { React?: unknown }).React = React;

// ===========================================================================
// The bills we read and did not count: shown with their reasons, related ones
// open, unrelated ones folded, and named in "How we got here".
// ===========================================================================

const row = (over: Partial<NotCountedAction>): NotCountedAction => ({
  action_uid: over.bill_id ?? 'x',
  bill_id: 's173-118',
  title: 'A bill to require safe storage of firearms',
  action: 'Cosponsored',
  tier: 'related',
  reason: 'The bill focuses on safe storage of firearms, not universal background checks.',
  source_url: 'https://www.congress.gov/bill/118th-congress/senate-bill/173',
  ...over,
});

const rows = [
  row({ bill_id: 's173-118' }),
  row({ bill_id: 's1531-119', title: 'An assault weapons bill' }),
  row({ bill_id: 's25-118', tier: 'unrelated', title: 'An assault weapons ban', reason: 'The bill is about assault weapons bans.' }),
];

const html = (r?: NotCountedAction[]) => renderToStaticMarkup(React.createElement(NotCounted, { rows: r }));

describe('NotCounted', () => {
  it('renders nothing for a result that never carried the field', () => {
    expect(html(undefined)).toBe('');
    expect(html([])).toBe('');
  });

  it('shows related bills open and unrelated ones folded, each with its reason and link', () => {
    const out = html(rows);
    expect(out).toMatch(/<details open=""[^>]*data-not-counted="related"/);
    expect(out).toMatch(/<details[^>]*data-not-counted="unrelated"/);
    expect(out).not.toMatch(/<details open=""[^>]*data-not-counted="unrelated"/);
    expect(out).toMatch(/Related bills we didn’t count <span[^>]*>\(2\)/);
    expect(out).toMatch(/Also looked at, not about this <span[^>]*>\(1\)/);
    expect(out).toContain('Why it’s not counted: </span>The bill focuses on safe storage');
    expect(out).toContain('Cosponsored');
    expect(out).toContain('https://www.congress.gov/bill/118th-congress/senate-bill/173');
  });

  it('says they do not affect the answer', () => {
    expect(html(rows)).toMatch(/don’t affect the answer/);
  });
});

describe('"How we got here" names the three groups', () => {
  const result = (notCounted?: NotCountedAction[]) =>
    ({
      senator: { name: 'Chuck Schumer' },
      interpretation: { raw: 'x', restated: 'x', primary_issue: 'Crime', sub_issue: '', stance: 'In Favor' },
      scored: { verdict: 'KEPT', receipt: { trace: [], direction_split: {}, evidence_mix: {} }, evidence: [] },
      search: {
        returned: 10, below_floor: 0, evaluated: 10, admitted: 2, relevance_applied: true,
        exclusions: ['8 bills we found were read as being about a different subject.'],
      },
      not_counted: notCounted,
    }) as unknown as QueryResult;
  const text = (r: QueryResult) =>
    renderToStaticMarkup(React.createElement(HowWeGotHere, { result: r })).replace(/<[^>]+>/g, ' ');

  it('counts direct, related and other-subject bills when the result carries them', () => {
    const t = text(result(rows));
    expect(t).toMatch(/We looked at 10 bills and votes: 2 are directly about this statement, 2 are related, and 1 is about something else\./);
    expect(t).toMatch(/listed under Receipts, each with the reason/);
  });

  it('falls back to the gate’s own sentences for an older stored result', () => {
    expect(text(result(undefined))).toMatch(/2 of 10 were close enough to count\. 8 bills we found/);
  });
});
