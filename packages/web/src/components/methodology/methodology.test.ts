import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ANSWER_LABEL_COPY, BAND_REASON_COPY, METHODOLOGY, ND_HEADLINE } from '@receipts/shared';
import { MethodologyPage, isMethodologyPath } from './MethodologyPage.js';
import { CANT_TELL_MEANING, REFRESH, STEPS } from './content.js';

// The test runner compiles JSX with the classic transform.
(globalThis as { React?: unknown }).React = React;

const html = renderToStaticMarkup(React.createElement(MethodologyPage));
// Text only, entities decoded, whitespace collapsed.
const page = html
  .replace(/<[^>]+>/g, ' ')
  .replace(/&quot;/g, '"')
  .replace(/&#x27;/g, "'")
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ');

describe('the methodology page', () => {
  it('is served at /methodology, with or without a trailing slash, and nowhere else', () => {
    expect(isMethodologyPath('/methodology')).toBe(true);
    expect(isMethodologyPath('/methodology/')).toBe(true);
    expect(isMethodologyPath('/')).toBe(false);
    expect(isMethodologyPath('/methodology/x')).toBe(false);
  });

  it('walks every step, each with technical details', () => {
    for (const s of STEPS) {
      expect(html).toContain(`id="${s.id}"`);
      expect(page).toContain(s.title);
    }
    expect(html.match(/<details/g)).toHaveLength(STEPS.length);
    expect(html).not.toMatch(/<details[^>]*open/); // closed by default
  });

  it('shows the product’s own labels, so the page can’t drift from what an answer says', () => {
    for (const label of Object.values(ANSWER_LABEL_COPY)) expect(page).toContain(label);
    for (const headline of new Set(Object.values(ND_HEADLINE))) {
      expect(page).toContain(headline!);
      expect(CANT_TELL_MEANING[headline!], headline).toBeTruthy();
    }
    for (const reason of Object.values(BAND_REASON_COPY)) expect(page).toContain(reason);
  });

  it('names every model and states the key numbers', () => {
    for (const model of new Set(Object.values(METHODOLOGY.models))) expect(page).toContain(model);
    expect(page).toContain(`Top ${METHODOLOGY.retrieval.topK}`);
    expect(page).toContain(METHODOLOGY.retrieval.floor.toFixed(2));
    expect(page).toContain(METHODOLOGY.accusationFloor.toFixed(2));
    expect(page).toContain(`${METHODOLOGY.taxonomy.pairs} policy topics`);
  });

  it('says what it does not cover, and claims nothing it can’t back', () => {
    expect(page).toContain('Senate record only, from January 2023');
    expect(page).toContain('can be wrong');
    expect(page).not.toMatch(/every (current )?senator/i);
    expect(page).not.toMatch(/fact[- ]check/i);
    // "Daily" only once the deployed schedule is confirmed (see content.ts).
    expect(REFRESH).toBe('updated regularly');
    expect(page).not.toMatch(/updated daily/i);
  });
});
