import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FundRecord } from './FundRecord.js';
import { MemberCard } from './MemberCard.js';

// ===========================================================================
// No unchecked card is a dead end: with funding off there is still a free
// request, and House members get the same actions as senators.
// ===========================================================================

describe('an unchecked member always offers something to do', () => {
  it('with funding off, the card offers a free request and no payment', () => {
    const html = renderToStaticMarkup(React.createElement(FundRecord, { memberId: 'B001323', name: 'Nicholas J. Begich III' }));
    expect(html).toContain('Request this record');
    expect(html).not.toContain('Sponsor this record');
  });

  it('a House member’s card carries the same actions as a senator’s', () => {
    const html = renderToStaticMarkup(
      React.createElement(MemberCard, {
        member: { politician_id: 'B001323', name: 'Nicholas J. Begich III', chamber: 'house', state: 'AK', party: 'R', cached: false },
        selected: false,
        onSelect: () => {},
      }),
    );
    expect(html).toContain('Request this record');
  });
});

describe('the sponsor pitch', () => {
  it('sells what the sponsor gets, and never "free for everyone"', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./FundRecord.tsx', import.meta.url), 'utf8');
    // Only the header comment may name the phrase, to forbid it.
    const body = src.replace(/^\/\/.*$/gm, '');
    expect(body).not.toMatch(/free for everyone/i);
    expect(body).toContain('Sponsor this record');
    expect(body).toContain('as its');
  });
});
