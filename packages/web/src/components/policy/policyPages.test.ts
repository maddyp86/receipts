import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PolicyPage, SiteFooter, policyForPath } from './PolicyPages.js';

// ===========================================================================
// The policy pages are read by payment reviewers and by readers deciding
// whether to pay. The promises they make must match the Fund button's.
// ===========================================================================

const page = (kind: 'terms' | 'privacy' | 'refunds') =>
  renderToStaticMarkup(React.createElement(PolicyPage, { kind })).replace(/&#x27;|’/g, "'");

describe('routing', () => {
  it('maps the three paths, with or without a trailing slash, and nothing else', () => {
    expect(policyForPath('/terms')).toBe('terms');
    expect(policyForPath('/privacy/')).toBe('privacy');
    expect(policyForPath('/refunds')).toBe('refunds');
    expect(policyForPath('/')).toBeNull();
    expect(policyForPath('/api/terms')).toBeNull();
  });

  it('the footer links all three', () => {
    const html = renderToStaticMarkup(React.createElement(SiteFooter));
    for (const p of ['/terms', '/privacy', '/refunds']) expect(html).toContain(`href="${p}"`);
  });
});

describe('the promises match the Fund button', () => {
  it('refunds: full refund if not live in 14 days, at the default $20, and none once live', () => {
    const html = page('refunds');
    expect(html).toContain('($20)');
    expect(html).toContain("isn't live within 14 days");
    expect(html).toContain("Once the record is live");
    expect(html).toContain('not tax-deductible');
  });

  it('terms: payment never changes a finding and is not a donation', () => {
    const html = page('terms');
    expect(html).toContain("doesn't change what we find");
    expect(html).toContain('not a donation');
  });

  it('privacy: names what is stored and that card numbers never reach us', () => {
    const html = page('privacy');
    expect(html).toContain('user-agent');
    expect(html).toContain('never see or store your card number');
    expect(html).toContain('Anthropic and OpenAI');
  });
});
