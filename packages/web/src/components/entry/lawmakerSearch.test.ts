import { describe, expect, it } from 'vitest';
import type { Member } from '../../data/roster.js';
import { rankMatches, SEARCH_LIMIT, shortLabel } from './LawmakerSearch.js';

const m = (politician_id: string, name: string, state: string, cached: boolean, party: 'D' | 'R' = 'D'): Member => ({
  politician_id,
  name,
  state,
  party,
  chamber: 'senate',
  cached,
});

const DIR: Member[] = [
  m('S000148', 'Chuck Schumer', 'NY', true),
  m('T000250', 'John Thune', 'SD', true, 'R'),
  m('G000555', 'Kirsten Gillibrand', 'NY', false),
  m('J000001', 'Thomas Johnson', 'TX', false, 'R'),
  m('A000001', 'Alex Thunberg', 'OR', false),
];

describe('lawmaker search', () => {
  it('empty: lists only the members that can be checked now', () => {
    expect(rankMatches(DIR, '').map((x) => x.name)).toEqual(['Chuck Schumer', 'John Thune']);
  });

  it('covered members come first, then names that start with the query, then the rest', () => {
    expect(rankMatches(DIR, 'thu').map((x) => x.name)).toEqual(['John Thune', 'Alex Thunberg']);
    expect(rankMatches(DIR, 'th').map((x) => x.name)).toEqual(['John Thune', 'Alex Thunberg', 'Thomas Johnson']);
  });

  it('matches a state by name or code, still listing unchecked members', () => {
    expect(rankMatches(DIR, 'new york').map((x) => x.name)).toEqual(['Chuck Schumer', 'Kirsten Gillibrand']);
    expect(rankMatches(DIR, 'sd').map((x) => x.name)).toEqual(['John Thune']);
  });

  it('never lists more than the limit', () => {
    const many = Array.from({ length: 30 }, (_, i) => m(`X${String(i).padStart(6, '0')}`, `Member ${i}`, 'CA', true));
    expect(rankMatches(many, 'member')).toHaveLength(SEARCH_LIMIT);
  });

  it('labels with party and state', () => {
    expect(shortLabel(DIR[1]!)).toBe('John Thune (R-SD)');
  });
});
