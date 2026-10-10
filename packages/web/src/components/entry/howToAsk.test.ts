import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PromiseInput } from './PromiseInput.js';

// The test runner compiles JSX with the classic transform.
(globalThis as { React?: unknown }).React = React;

// ===========================================================================
// "How to ask": weak examples, then better ones to try. Copy approved as
// written, so the exact strings are pinned.
// ===========================================================================

const html = renderToStaticMarkup(
  React.createElement(PromiseInput, {
    memberName: null, value: '', onChange: () => {}, kindEnabled: false, kind: 'position', onKindChange: () => {},
  }),
);
const section = html.slice(html.indexOf('id="promise-tips"'));
const text = section.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

describe('the help toggle', () => {
  it('topics and "How to ask" sit inside one toggle, closed by default', () => {
    const details = html.slice(html.indexOf('<details'), html.indexOf('</details>'));
    expect(html).toMatch(/<details class="group mt-6">/); // no "open" attribute
    expect(details).toContain('Need help phrasing it?');
    expect(details).toContain('Start with a topic:');
    expect(details).toContain('id="promise-tips"');
    // The question box itself stays outside.
    expect(html.indexOf('id="promise"')).toBeLessThan(html.indexOf('<details'));
  });
});

describe('How to ask', () => {
  it('has the new heading and labels, and none of the old explanations', () => {
    expect(text).toContain('How to ask');
    expect(text).not.toContain('What we can’t check');
    expect(text.match(/Instead of/g)).toHaveLength(2);
    expect(text.match(/\bTry\b/g)).toHaveLength(2);
    expect(text).toContain("Can't check");
    for (const old of ['a question has no side to check', 'too broad. Name the policy, program or bill', 'can’t be checked against bills']) {
      expect(text).not.toContain(old);
    }
  });

  it('keeps every example exactly as written, in quotation marks', () => {
    for (const s of [
      '"What is their stance on abortion?"',
      '"Did they vote to protect abortion access?"',
      '"Did they vote to limit abortion after 15 weeks?"',
      '"Do they support our veterans?"',
      '"Have they backed expanding VA health care?"',
      `"Did they vote to raise veterans' disability pay?"`,
      `"Are they a good leader?" — a voting record can't answer that.`,
    ]) {
      expect(text).toContain(s);
    }
  });

  it('each "Try" example is a button that cannot submit the form', () => {
    const buttons = [...section.matchAll(/<button type="button"[^>]*>([\s\S]*?)<\/button>/g)].map((m) =>
      m[1]!.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, "'"),
    );
    expect(buttons).toEqual([
      '"Did they vote to protect abortion access?"',
      '"Did they vote to limit abortion after 15 weeks?"',
      '"Have they backed expanding VA health care?"',
      `"Did they vote to raise veterans' disability pay?"`,
    ]);
  });
});
