import { afterEach, describe, expect, it, vi } from 'vitest';
import { surnameOf } from '@receipts/shared';
import { SEED, SenatorCache, type PoliticianRow } from './SenatorCache.js';

// ===========================================================================
// THE PICKER IS THE PIPELINE'S LIST.
//
// Covered = `In Scope` in mirror_politicians AND actions in
// mirror_politician_bill_actions (the SQL computes `covered`; these tests feed
// rows as the query returns them). A senator the pipeline adds appears with no
// code change; one it removes disappears. Only covered senators are listed;
// everyone else still resolves, as uncached.
// ===========================================================================

const row = (politician_id: string, name: string, covered: boolean, party = 'Democrat', state = 'XX'): PoliticianRow =>
  ({ politician_id, name, party, state, covered });

const MIRROR = [
  row('T000250', 'John Thune', true, 'Republican', 'SD'),
  row('S000148', 'Charles E. Schumer', true, 'Democrat', 'NY'),
  row('W000817', 'Elizabeth Warren', false, 'Democrat', 'MA'),
];

afterEach(() => vi.restoreAllMocks());

describe('who is listed', () => {
  it('covered senators only, from the mirror, in surname order', async () => {
    const c = new SenatorCache(async () => MIRROR);
    expect(await c.list()).toEqual([
      { politician_id: 'S000148', name: 'Charles E. Schumer', cached: true, party: 'D', state: 'NY' },
      { politician_id: 'T000250', name: 'John Thune', cached: true, party: 'R', state: 'SD' },
    ]);
  });

  it('a senator the pipeline adds appears, with no code change', async () => {
    let rows = MIRROR;
    let t = 0;
    const c = new SenatorCache(async () => rows, 60_000, () => t);
    expect((await c.list()).map((s) => s.politician_id)).toEqual(['S000148', 'T000250']);

    rows = [...MIRROR.slice(0, 2), row('W000817', 'Elizabeth Warren', true)];
    t = 60_000;
    await c.list(); // serves the old list while it re-reads
    await new Promise((r) => setTimeout(r, 0));
    expect((await c.list()).map((s) => s.politician_id)).toEqual(['S000148', 'T000250', 'W000817']);
  });

  it('not before the TTL', async () => {
    const load = vi.fn(async () => MIRROR);
    let t = 0;
    const c = new SenatorCache(load, 60_000, () => t);
    await c.list();
    t = 59_999;
    await c.list();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('rows with no id or name are skipped; an unknown party is left off, not guessed', async () => {
    const c = new SenatorCache(async () => [
      ...MIRROR,
      row('', 'No Id', true),
      row('X000001', '', true),
      row('X000002', 'Party Unknown', true, 'Whig'),
    ]);
    const listed = await c.list();
    expect(listed.map((s) => s.politician_id)).toEqual(['S000148', 'T000250', 'X000002']);
    expect(listed.find((s) => s.politician_id === 'X000002')).not.toHaveProperty('party');
  });
});

describe('who resolves', () => {
  it('a senator in the table but not covered resolves as uncached, so the honest stop still runs', async () => {
    const c = new SenatorCache(async () => MIRROR);
    expect(await c.resolve('W000817')).toMatchObject({ name: 'Elizabeth Warren', cached: false });
    expect(await c.resolve(' S000148 ')).toMatchObject({ cached: true });
    expect(await c.resolve('Z999999')).toBeUndefined();
  });
});

describe('when the mirror cannot be read', () => {
  it('with no last good list: the seed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = new SenatorCache(async () => {
      throw new Error('down');
    });
    expect((await c.list()).map((s) => s.politician_id)).toEqual(['S000148', 'T000250']);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('using the seed list'), 'down');
  });

  it('with one: keeps it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail = false;
    let t = 0;
    const c = new SenatorCache(async () => {
      if (fail) throw new Error('down');
      return [...MIRROR, row('W000817', 'Elizabeth Warren', true)];
    }, 1, () => t);
    await c.list();
    fail = true;
    t = 10;
    await c.list();
    await new Promise((r) => setTimeout(r, 0));
    expect((await c.list()).map((s) => s.politician_id)).toContain('W000817');
    expect(err).toHaveBeenCalledWith(expect.stringContaining('keeping the last good list'), 'down');
  });

  it('a read with no covered senator is treated as a failure, never an empty picker', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = new SenatorCache(async () => MIRROR.map((r) => ({ ...r, covered: false })));
    expect((await c.list()).length).toBeGreaterThan(0);
  });
});

describe('with no database (demo, fixtures, tests)', () => {
  it('lists the seed senators and resolves the uncached five', async () => {
    const c = new SenatorCache(null);
    expect((await c.list()).map((s) => s.politician_id)).toEqual(['S000148', 'T000250']);
    expect(await c.resolve('W000817')).toMatchObject({ cached: false });
    expect(SEED.filter((s) => s.cached)).toHaveLength(2);
  });
});

describe('surnames', () => {
  it.each([
    ['Charles E. Schumer', 'Schumer'],
    ['John Thune', 'Thune'],
    ['Angus S. King, Jr.', 'King'],
    ['Randy K. Weber, Sr.', 'Weber'],
    ['William R. Timmons IV', 'Timmons'],
    ['Rudy Yakym III', 'Yakym'],
    ['Cher', 'Cher'],
  ])('%s → %s', (name, surname) => {
    expect(surnameOf(name)).toBe(surname);
  });
});
