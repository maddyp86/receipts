import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SCOPE_NOTE } from '@receipts/shared';
import { Landing } from './Landing.js';
import { SAMPLE_ANSWERS } from './content.js';

// The test runner compiles JSX with the classic transform.
(globalThis as { React?: unknown }).React = React;

const MEMBERS = [
  { politician_id: 'T000250', name: 'John Thune', cached: true, party: 'R' as const, state: 'SD', chamber: 'senate' as const },
  { politician_id: 'S000148', name: 'Chuck Schumer', cached: true, party: 'D' as const, state: 'NY', chamber: 'senate' as const },
];

function render(over: Partial<React.ComponentProps<typeof Landing>> = {}) {
  const html = renderToStaticMarkup(
    React.createElement(Landing, {
      members: MEMBERS, selected: null, onSelect: () => {}, promise: '', onPromiseChange: () => {},
      onSubmit: () => {}, onStart: () => {}, busy: false, dailyLimit: 20, showScopeNote: false,
      ...over,
    }),
  );
  return html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
}

describe('the landing page', () => {
  it('says it is a beta, and what the beta covers', () => {
    const page = render();
    expect(page).toContain('Beta · Senate record since January 2023 · Answers can miss bills or be wrong.');
    expect(page).toMatch(/\bBeta\b/);
  });

  it('shows the full approved beta note where feedback exists for it to point at', () => {
    expect(render({ showScopeNote: true })).toContain('This is a beta.');
    expect(render({ showScopeNote: false })).not.toContain('This is a beta.');
    expect(SCOPE_NOTE[0]).toContain('This is a beta.');
  });

  it('offers "Need help phrasing it?" with the topics and "How to ask"', () => {
    const page = render();
    expect(page).toContain('Need help phrasing it?');
    expect(page).toContain('Start with a topic:');
    expect(page).toContain('How to ask');
  });

  it('states the daily allowance from the server, follow-ups included, and nothing when unknown', () => {
    expect(render({ dailyLimit: 20 })).toContain('up to 20 checks a day, including follow-up questions');
    expect(render({ dailyLimit: 12 })).toContain('up to 12 checks a day');
    expect(render({ dailyLimit: null })).not.toContain('checks a day');
  });

  it('offers one-tap starters only for covered members', () => {
    const page = render();
    expect(page).toContain('Did Thune vote for the Laken Riley Act?');
    expect(page).not.toContain('Collins'); // not in this member list
  });

  it('makes no claim the product cannot back', () => {
    const page = render();
    expect(page).not.toMatch(/every current senator/i);
    expect(page).not.toMatch(/updated daily/i);
    expect(page).not.toMatch(/ten seconds/i);
    expect(page).not.toMatch(/Rand Paul|Sen\. Paul/);
  });
});

describe('sample answers', () => {
  it('carry only the verified record (eval case 35): three Yea votes on S.5, roll calls 1, 5 and 7, passed 64–35', () => {
    expect(SAMPLE_ANSWERS).toHaveLength(1);
    const a = SAMPLE_ANSWERS[0]!;
    expect(a.question).toBe('Did Thune vote for the Laken Riley Act?');
    expect(a.rows.map((r) => [r.bill, r.rollCall, r.vote])).toEqual([
      ['S.5', 'Roll call 1, 2025', 'Yea'],
      ['S.5', 'Roll call 5, 2025', 'Yea'],
      ['S.5', 'Roll call 7, 2025', 'Yea'],
    ]);
    expect(a.summary).toContain('64–35');
  });
});
