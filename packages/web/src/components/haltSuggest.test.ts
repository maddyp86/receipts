import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { QueryHalt } from '@receipts/shared';
import { HaltState, SuggestedRewording } from './States.js';

// The test runner compiles JSX with the classic transform.
(globalThis as { React?: unknown }).React = React;

// ===========================================================================
// The halt card: the plain reason on Level 1, a rewording of the reader's own
// topic to check instead, and the classifier's wording one tap away.
// ===========================================================================

const halt: QueryHalt = {
  reason: 'NON_TESTABLE_SPEECH_ACT',
  message: 'This reads to us as a rhetorical statement, which no vote or sponsorship can settle either way.',
  recoverable_with_date: false,
  scope: {
    speech_act: 'RHETORIC', scope: 'STANDING', valid_until: '', anchor_entity: '', role_condition: 'NONE', confidence: 0.8,
    reasoning: 'without a date or named legislative vehicle, it cannot be classified as BOUNDED.',
  },
} as QueryHalt;

const render = (props: Partial<React.ComponentProps<typeof HaltState>>) =>
  renderToStaticMarkup(React.createElement(HaltState, { halt, onReset: () => {}, onRetryWithDate: () => {}, ...props }));

/** Everything outside the analyst disclosure. */
const levelOne = (html: string) => html.replace(/<details[\s\S]*?<\/details>/, '');
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');

describe('no classifier jargon on Level 1', () => {
  it('the reasoning sits only in the collapsed analyst detail', () => {
    const html = render({});
    expect(text(levelOne(html))).not.toMatch(/BOUNDED|Read as a|legislative vehicle/);
    expect(html).toMatch(/<details[^>]*>[\s\S]*Details for analysts[\s\S]*BOUNDED[\s\S]*<\/details>/);
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(text(html)).toContain('which no vote or sponsorship can settle either way');
  });
});

describe('a rewording of the reader\'s topic, not fixed examples', () => {
  it('with a suggestion: "Check this" buttons, no fixed examples', () => {
    const html = render({
      suggestions: [{ label: 'supports protecting abortion access', statement: 'supports protecting abortion access' }],
      onPick: () => {},
    });
    expect(text(html)).toContain('You could check this instead:');
    expect(text(html)).toContain('Check this “supports protecting abortion access”');
    expect(text(html)).not.toContain('background checks');
  });

  it('without one: the fixed examples stay as the fallback', () => {
    expect(text(render({}))).toContain('supports expanding background checks');
  });

  it('two sides render as two buttons that each check their own statement', () => {
    const picked: string[] = [];
    const el = SuggestedRewording({
      options: [
        { label: 'Supports stricter gun laws', statement: 'supports stricter gun laws' },
        { label: 'Opposes stricter gun laws', statement: 'opposes stricter gun laws' },
      ],
      onPick: (s) => picked.push(s),
    });
    const html = renderToStaticMarkup(el);
    expect(text(html)).toContain('You could check one of these instead:');
    // Click each button's handler, as the browser would.
    const buttons = (el.props.children[1].props.children as React.ReactElement[]);
    for (const b of buttons) (b.props as { onClick: () => void }).onClick();
    expect(picked).toEqual(['supports stricter gun laws', 'opposes stricter gun laws']);
  });
});
