import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { recordBoundarySentence, searchFunnel, searchSummarySentence, type QueryResult } from '@receipts/shared';
import { toSenator } from '../../../server/src/data/SenatorCache.js';
import { SearchSummary, VerdictCard, WhyPanel } from './Verdict.js';
import { ResultTabs } from './ResultTabs.js';
import { FollowUp } from './FollowUp.js';
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

  it('the bar holds the headline, the three numbers and what to do next, not the explanation', () => {
    expect(at('We couldn')).toBeGreaterThanOrEqual(0);
    expect(at('We couldn')).toBeLessThan(at('609 actions in record'));
    expect(at('2 read closely')).toBeGreaterThan(0);
    expect(at('0 about your question')).toBeGreaterThan(0);
    expect(at('about your question')).toBeLessThan(at('Check something else about Schumer'));
    // The explanation is the "Why" tab; the summary sentence is "How we checked".
    expect(at('Here’s why')).toBe(-1);
    expect(at('We searched all 609')).toBe(-1);
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

describe('the tabs under the answer', () => {
  const r = result();
  const html = renderToStaticMarkup(
    React.createElement(ResultTabs, {
      initial: 'why',
      tabs: [
        { id: 'why', label: 'Why', content: React.createElement(WhyPanel, { result: r }) },
        { id: 'receipts', label: 'Receipts (0)', content: React.createElement('p', null, 'the bills') },
        { id: 'how', label: 'How we checked', content: React.createElement(SearchSummary, { result: r }) },
      ],
    }),
  );
  const panels = [...html.matchAll(/<div role="tabpanel"[^>]*>/g)].map((m) => m[0]);

  it('opens on Why, and the other two are in the page but hidden', () => {
    expect(html).toMatch(/aria-selected="true"[^>]*>Why</);
    expect(panels).toHaveLength(3);
    expect(panels[0]).not.toContain('hidden');
    expect(panels[1]).toContain('hidden');
    expect(panels[2]).toContain('hidden');
  });

  it('Why carries the explanation and the coverage boundary; How we checked carries the summary sentence', () => {
    const [why, , how] = html.split(/<div role="tabpanel"/).slice(1);
    expect(why).toContain('Here’s why');
    expect(why).toContain('coverage-note');
    expect(how).toContain('We searched all 609');
  });
});

describe('the follow-up chat', () => {
  const html = renderToStaticMarkup(React.createElement(FollowUp, { traceId: 't', available: true, senatorName: 'Charles E. Schumer' }));

  it('is a panel for wide screens and a pinned button for phones', () => {
    expect(html).toContain('aria-label="Ask about this result"');
    expect(html).toMatch(/hidden lg:block/);
    expect(html).toMatch(/fixed bottom-4[^"]*lg:hidden/);
  });

  it('is absent when the server cannot answer follow-ups', () => {
    expect(renderToStaticMarkup(React.createElement(FollowUp, { traceId: 't', available: false, senatorName: 'x' }))).toBe('');
  });
});

describe('a search that found nothing says where our records start', () => {
  const BOUNDARY = 'Our records start in January 2023. If they acted on this before then, it isn’t in what we searched.';

  it('on a no-results answer (the drug prices question, trace 5bda0373)', () => {
    expect(recordBoundarySentence(result())).toBe(BOUNDARY);
  });

  it('on the answer bar itself, before the buttons', () => {
    const html = renderToStaticMarkup(
      React.createElement(VerdictCard, {
        result: result(),
        actions: React.createElement(ResultActions, { surname: 'Schumer', onAskAnother: () => {}, others: [], onAskSameOf: () => {}, onChangeMember: () => {} }),
      }),
    );
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(text).toContain(BOUNDARY);
    expect(text.indexOf(BOUNDARY)).toBeLessThan(text.indexOf('Check something else about Schumer'));
  });

  it('not on any other answer, and not when the record’s start is unknown', () => {
    expect(recordBoundarySentence(result({ nd: null }))).toBeNull();
    expect(recordBoundarySentence(result({ nd: 'ALL_NEUTRAL' }))).toBeNull();
    const unknown = { ...result(), coverage: { congresses: [], observed: null, unknown: true } } as unknown as QueryResult;
    expect(recordBoundarySentence(unknown)).toBeNull();
  });

  it('never says the senator did nothing', () => {
    expect(BOUNDARY).not.toMatch(/did nothing|no record|never/i);
  });
});

describe('"Why" on an answer that doesn\'t settle it (2026-10-11)', () => {
  const withheld = (why: string) =>
    ({
      ...result({ nd: 'WITHHELD_PENDING_REVIEW', evaluated: 7, admitted: 2 }),
      explanation: { why, connectors: {}, confidence: 0.6 },
      judge: { disposition: 'REVIEW_REQUIRED_JUDGE_CORRECTED', withheld: true, unavailable: false, counterargument: null, failed_test: 'T3', failure_class: 'BROAD_VEHICLE' },
    }) as unknown as QueryResult;
  const why = (r: QueryResult) => renderToStaticMarkup(React.createElement(WhyPanel, { result: r })).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  it('shows the explainer\'s paragraph, then the specific reason in plain words', () => {
    const t = why(withheld('You asked about income taxes. We found H.R. 1 and Schumer voted no on it.'));
    expect(t).toContain('You asked about income taxes. We found H.R. 1 and Schumer voted no on it.');
    expect(t).toContain('Why there’s no verdict. The deciding vote was on a large bill that covers many subjects');
    expect(t).not.toMatch(/adversarial|did not sustain/);
  });

  it('without a paragraph, the reason alone is the answer', () => {
    const t = why(withheld(''));
    expect(t).toContain('The deciding vote was on a large bill that covers many subjects');
    expect(t).not.toContain('Why there’s no verdict.');
  });

  it('nothing found: the reason is the scorer\'s, and the bills are on the Receipts tab, not "below"', () => {
    const t = why(result());
    expect(t).not.toMatch(/\bbelow\b/);
  });
});
