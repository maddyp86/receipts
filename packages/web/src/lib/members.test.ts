import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Member } from '../data/roster.js';
import { MemberCard } from '../components/members/MemberCard.js';
import { MemberPicker } from '../components/members/MemberPicker.js';
import { isFormer, memberTitle, tenureLine } from './members.js';

// The test runner compiles JSX with the classic transform.
(globalThis as { React?: unknown }).React = React;

// ===========================================================================
// A member who has left office: still checkable, never shown as holding the
// seat (decision 1, 2026-11-04).
// ===========================================================================

const COLLINS: Member = { politician_id: 'C001035', name: 'Susan M. Collins', party: 'R', state: 'ME', chamber: 'senate', cached: true, left_at: '2027-01-03', first_term_start: '1997-01-07' };
const KING: Member = { politician_id: 'K000383', name: 'Angus S. King, Jr.', party: 'I', state: 'ME', chamber: 'senate', cached: true };
const JACKSON: Member = { politician_id: 'J000999', name: 'Troy Jackson', party: 'D', state: 'ME', chamber: 'senate', cached: false };

describe('the title', () => {
  it('says former for a member who has left, and nothing else changes', () => {
    expect(memberTitle(COLLINS)).toBe('Former U.S. Senator for Maine');
    expect(memberTitle(KING)).toBe('U.S. Senator for Maine');
    expect(memberTitle({ ...COLLINS, chamber: 'house', district: 2 })).toBe('Former U.S. Representative for Maine’s 2nd District');
  });

  it('says when they left, not why', () => {
    expect(isFormer(COLLINS)).toBe(true);
    expect(tenureLine(COLLINS)).toBe('Served until January 3, 2027');
    expect(isFormer(KING)).toBe(false);
    expect(tenureLine(KING)).toBeNull();
  });
});

const text = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('the card', () => {
  it('a former member is selectable and shows the day they left', () => {
    const html = renderToStaticMarkup(React.createElement(MemberCard, { member: COLLINS, selected: false, onSelect: () => {} }));
    expect(html).toContain('data-covered="true"');
    expect(html).toContain('data-former="true"');
    expect(text(React.createElement(MemberCard, { member: COLLINS, selected: false, onSelect: () => {} }))).toContain('Former U.S. Senator for Maine Served until January 3, 2027');
  });
});

describe('the picker', () => {
  it('lists former members after the serving ones, under their own heading', () => {
    const html = renderToStaticMarkup(React.createElement(MemberPicker, { members: [COLLINS, KING, JACKSON], selectedId: null, onSelect: () => {} }));
    expect(html).toContain('data-former-members="1"');
    const t = text(React.createElement(MemberPicker, { members: [COLLINS, KING, JACKSON], selectedId: null, onSelect: () => {} }));
    expect(t.indexOf('Angus S. King, Jr.')).toBeLessThan(t.indexOf('Former members'));
    expect(t.indexOf('Former members')).toBeLessThan(t.indexOf('Susan M. Collins'));
    expect(t).toContain('Their record is still here to check');
  });

  it('with no former members there is no heading', () => {
    const html = renderToStaticMarkup(React.createElement(MemberPicker, { members: [KING, JACKSON], selectedId: null, onSelect: () => {} }));
    expect(html).not.toContain('Former members');
  });
});
