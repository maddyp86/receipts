import { describe, expect, it } from 'vitest';
import type { Senator } from '@receipts/shared';
import { MIDTERM_ROSTER, buildRoster } from './roster.js';

// ===========================================================================
// THE PICKER'S LIST.
//
// Coverage is the server's. This file may add what a member IS (chamber,
// district) and who is planned; it may never make someone checkable.
// ===========================================================================

const SCHUMER: Senator = { politician_id: 'S000148', name: 'Chuck Schumer', cached: true, party: 'D', state: 'NY' };
const THUNE: Senator = { politician_id: 'T000250', name: 'John Thune', cached: true, party: 'R', state: 'SD' };

describe('buildRoster', () => {
  it('only the members the server covers are checkable', () => {
    const roster = buildRoster([SCHUMER, THUNE]);
    expect(roster.filter((m) => m.cached).map((m) => m.politician_id)).toEqual(['S000148', 'T000250']);
    expect(roster.filter((m) => !m.cached)).toHaveLength(MIDTERM_ROSTER.length - 2);
  });

  it('with nothing from the server, nobody is checkable', () => {
    const roster = buildRoster([]);
    expect(roster).toHaveLength(MIDTERM_ROSTER.length);
    expect(roster.some((m) => m.cached)).toBe(false);
  });

  it('a planned member lights up the moment the server covers them, keeping chamber and district', () => {
    const lawler: Senator = { politician_id: 'L000599', name: 'Mike Lawler', cached: true, party: 'R', state: 'NY' };
    const m = buildRoster([SCHUMER, lawler]).find((x) => x.politician_id === 'L000599')!;
    expect(m).toMatchObject({ cached: true, chamber: 'house', district: 17, name: 'Mike Lawler' });
  });

  it('the server row wins on the name', () => {
    expect(buildRoster([SCHUMER]).find((m) => m.politician_id === 'S000148')!.name).toBe('Chuck Schumer');
  });

  it('a covered member the roster has never heard of is shown, as a senator', () => {
    const other: Senator = { politician_id: 'W000817', name: 'Elizabeth Warren', cached: true, party: 'D', state: 'MA' };
    const m = buildRoster([other]).find((x) => x.politician_id === 'W000817')!;
    expect(m).toMatchObject({ cached: true, chamber: 'senate', state: 'MA' });
  });

  it('a server row marked uncovered stays uncovered', () => {
    const m = buildRoster([{ ...THUNE, cached: false }]).find((x) => x.politician_id === 'T000250')!;
    expect(m.cached).toBe(false);
  });

  it('lists nobody twice', () => {
    const ids = buildRoster([SCHUMER, THUNE]).map((m) => m.politician_id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the midterm list', () => {
  it('is eight senators and six House members, every House member with a district', () => {
    expect(MIDTERM_ROSTER.filter((m) => m.chamber === 'senate')).toHaveLength(8);
    const house = MIDTERM_ROSTER.filter((m) => m.chamber === 'house');
    expect(house).toHaveLength(6);
    expect(house.every((m) => typeof m.district === 'number' && m.district > 0)).toBe(true);
  });

  it('is balanced by party', () => {
    const count = (p: string) => MIDTERM_ROSTER.filter((m) => m.party === p).length;
    expect(count('D')).toBe(count('R'));
  });
});
