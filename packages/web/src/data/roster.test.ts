import { describe, expect, it } from 'vitest';
import type { DirectoryMember, Senator } from '@receipts/shared';
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

describe('buildRoster with the server directory', () => {
  const dir: DirectoryMember[] = [
    { politician_id: 'S000148', name: 'Charles E. Schumer', chamber: 'senate', party: 'D', state: 'NY', cached: true },
    { politician_id: 'P000145', name: 'Alex Padilla', chamber: 'senate', party: 'D', state: 'CA', cached: false },
    { politician_id: 'L000578', name: 'Doug LaMalfa', chamber: 'house', party: 'R', state: 'CA', district: 1, cached: false },
    { politician_id: 'V000129', name: 'David G. Valadao', chamber: 'house', party: 'R', state: 'CA', district: 22, cached: false },
    // The directory saying "cached" is not enough: only /api/senators makes a member checkable.
    { politician_id: 'K000394', name: 'Andy Kim', chamber: 'senate', party: 'D', state: 'NJ', cached: true },
  ];

  it('lists everyone serving, so any member can be found by state or name', () => {
    const ids = buildRoster([SCHUMER], dir).map((m) => m.politician_id);
    expect(ids).toEqual(expect.arrayContaining(['S000148', 'P000145', 'L000578', 'V000129', 'K000394']));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('drops the planned list when the directory is there: the directory is the whole of Congress', () => {
    const ids = buildRoster([SCHUMER], dir).map((m) => m.politician_id);
    expect(ids).not.toContain('L000599'); // Lawler: planned, absent from this test directory
  });

  it('only members /api/senators covers are checkable', () => {
    const roster = buildRoster([SCHUMER], dir);
    expect(roster.filter((m) => m.cached).map((m) => m.politician_id)).toEqual(['S000148']);
  });

  it('the covered row wins on the name; the directory adds chamber and district; the roster adds the area', () => {
    const roster = buildRoster([SCHUMER], dir);
    expect(roster.find((m) => m.politician_id === 'S000148')!.name).toBe('Chuck Schumer');
    expect(roster.find((m) => m.politician_id === 'L000578')).toMatchObject({ chamber: 'house', district: 1, state: 'CA' });
    expect(roster.find((m) => m.politician_id === 'V000129')).toMatchObject({ area: 'the southern Central Valley' });
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
