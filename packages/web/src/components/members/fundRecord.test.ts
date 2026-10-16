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
    expect(html).not.toContain('Fund this record');
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
