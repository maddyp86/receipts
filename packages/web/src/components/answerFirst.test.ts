import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { searchFunnel, searchSummarySentence, type QueryResult } from '@receipts/shared';
import { toSenator } from '../../../server/src/data/SenatorCache.js';
import { VerdictCard } from './Verdict.js';
import { ResultActions } from './States.js';

// The test runner compiles JSX with the classic transform.
(globalThis as { React?: unknown }).React = React;

// ===========================================================================
// ANSWER FIRST: the first screen holds the answer, what the search did (with
// its numbers) and what to do next. The insulin query (trace cbe3c920…,
// 2026-10-10) is the case: 609 actions, 2 came close, 0 about the question.
// ===========================================================================

const result = (over: { evaluated?: number; admitted?: number; relevance?: boolean; record?: number | null; nd?: string | null } = {}) =>
  ({
    senator: { politician_id: 'S000148', name: 'Charles E. Schumer', cached: true, ...(over.record === null ? {} : { record_actions: over.record ?? 609 }) },
    interpretation: { raw: 'supports capping the cost of insulin at $35 a month', restated: 'x', primary_issue: 'Health Care', sub_issue: 'x', stance: 'In Favor', statement_type: 'Policy Position', provenance: 'default', promise_type: 'policy' },
    scored: {
      verdict: over.nd === undefined || over.nd ? 'NOT_DETERMINABLE' : 'KEPT', band: over.nd === null ? 'Medium' : null,
      mode: over.nd === null ? 'single' : 'not_determinable', nd_reason: over.nd === undefined ? 'NO_MATCHES' : over.nd,
      ranked: [], evidence: [],
      receipt: { match_count: 0, directed_count: 0, avg_strength: 0, strongest_score: 0, evidence_mix: { vote: 0, sponsorship: 0, procedural: 0, associative: 0 }, direction_split: { keeps: 0, breaks: 0, neutral: 0 }, weight_split: { keeps: 0, breaks: 0 }, minority_share: 0, trace: [], scoring_flags: [] },
    },
    explanation: { why: 'Because.', connectors: {}, confidence: 0.5 },
    coverage: { congresses: [118, 119], observed: null, unknown: false },
    search: { returned: 10, below_floor: 8, evaluated: over.evaluated ?? 2, admitted: over.admitted ?? 0, relevance_applied: over.relevance ?? true, exclusions: [] },
  }) as unknown as QueryResult;

describe('what the search did, in words', () => {
  it('the insulin case: searched the whole record, two came close, neither was about it', () => {
    expect(searchSummarySentence(result())).toBe(
      'We searched all 609 of Schumer’s recorded actions since January 2023. Two came close, but neither was actually about this.',
    );
  });

  it('nothing came close', () => {
    expect(searchSummarySentence(result({ evaluated: 0 }))).toMatch(/since January 2023\. None came close to your question\.$/);
  });

  it('a verdict: how many came close, and how many were about it', () => {
    expect(searchSummarySentence(result({ evaluated: 7, admitted: 3, nd: null }))).toMatch(
      /Seven came close to your question, and three were actually about it\.$/,
    );
  });

  it('without the record size it still says what it searched, not a number it does not have', () => {
    expect(searchSummarySentence(result({ record: null }))).toMatch(/^We searched Schumer’s recorded actions since January 2023\./);
    expect(searchFunnel(result({ record: null }))).toEqual({ searched: null, close: 2, about: 0 });
  });

  it('never says the senator did nothing', () => {
    for (const r of [result(), result({ evaluated: 0 })]) {
      expect(searchSummarySentence(r)).not.toMatch(/did nothing|no record|never/i);
    }
  });
});

describe('the record size comes from the mirror', () => {
  it('a covered senator carries record_actions; an uncovered one does not', () => {
    expect(toSenator({ politician_id: 'S000148', name: 'Charles E. Schumer', party: 'Democrat', state: 'NY', covered: true, actions: 609 }))
      .toMatchObject({ record_actions: 609 });
    expect(toSenator({ politician_id: 'W000817', name: 'Elizabeth Warren', party: 'Democrat', state: 'MA', covered: false, actions: 0 }))
      .not.toHaveProperty('record_actions');
  });
});

describe('the first screen of an answer', () => {
  const html = renderToStaticMarkup(
    React.createElement(VerdictCard, {
      result: result(),
      actions: React.createElement(ResultActions, {
        surname: 'Schumer', onAskAnother: () => {}, others: [{ politician_id: 'T000250', name: 'John Thune' }],
        onAskSameOf: () => {}, onChangeMember: () => {},
      }),
    }),
  );
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const at = (s: string) => text.indexOf(s);

  it('headline, then the search summary and its numbers, then what to do next, then the explanation', () => {
    expect(at('We couldn')).toBeGreaterThanOrEqual(0);
    expect(at('We couldn')).toBeLessThan(at('We searched all 609'));
    expect(at('We searched all 609')).toBeLessThan(at('609 actions searched'));
    expect(at('2 came close')).toBeGreaterThan(0);
    expect(at('0 about your question')).toBeGreaterThan(0);
    expect(at('about your question')).toBeLessThan(at('Check something else about Schumer'));
    expect(at('Check something else about Schumer')).toBeLessThan(at('Here’s why'));
  });

  it('with one other covered member, the second button asks the same question about them', () => {
    expect(text).toContain('Ask this about John Thune');
  });
});

describe('the second button', () => {
  const render = (others: Array<{ politician_id: string; name: string }>) =>
    renderToStaticMarkup(React.createElement(ResultActions, { surname: 'Schumer', onAskAnother: () => {}, others, onAskSameOf: () => {}, onChangeMember: () => {} }));
  it('goes to the picker when several others are covered, and is absent when none are', () => {
    expect(render([{ politician_id: 'a', name: 'A' }, { politician_id: 'b', name: 'B' }])).toContain('Check someone else');
    expect(render([])).not.toContain('Check someone else');
    expect(render([])).not.toContain('Ask this about');
  });
});
