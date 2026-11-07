import { describe, expect, it } from 'vitest';
import { PICKER_SQL, SenatorCache, parseDay, toSenator, type PoliticianRow } from './SenatorCache.js';

// ===========================================================================
// Tenure rides on the senator from the compat view's four keys (migration
// 026): Left At, First Term Start, Last Term End, Served Congresses. A blank
// is "not known", never "serving" or "day one". A covered senator who has
// left office stays listed (decision 1, 2026-11-04).
// ===========================================================================

const row = (over: Partial<PoliticianRow> = {}): PoliticianRow => ({
  politician_id: 'C001035',
  name: 'Susan M. Collins',
  party: 'Republican',
  state: 'ME',
  covered: true,
  actions: 1003,
  coverage_congresses: '118, 119',
  ...over,
});

describe('the picker reads the tenure keys', () => {
  it('names each one', () => {
    for (const key of ['Left At', 'First Term Start', 'Last Term End', 'Served Congresses']) {
      expect(PICKER_SQL).toContain(`p.row->>'${key}'`);
    }
  });

  it('a date is kept as written, and anything else is not a date', () => {
    expect(parseDay('2027-01-03')).toBe('2027-01-03');
    expect(parseDay(' 2027-01-03 ')).toBe('2027-01-03');
    expect(parseDay('')).toBeUndefined();
    expect(parseDay(null)).toBeUndefined();
    expect(parseDay('1/3/2027')).toBeUndefined();
  });
});

describe('tenure on the senator', () => {
  it('a former member carries the day they left and where their service ran', () => {
    const s = toSenator(row({ left_at: '2027-01-03', first_term_start: '1997-01-07', last_term_end: '2027-01-03', served_congresses: '105, 106, 118, 119' }))!;
    expect(s).toMatchObject({
      cached: true,
      left_at: '2027-01-03',
      first_term_start: '1997-01-07',
      last_term_end: '2027-01-03',
      served_congresses: [105, 106, 118, 119],
    });
  });

  it('a serving member carries no left_at; blanks are absent, not defaults', () => {
    const s = toSenator(row({ left_at: '', first_term_start: '1997-01-07', last_term_end: '2027-01-03', served_congresses: '' }))!;
    expect(s).not.toHaveProperty('left_at');
    expect(s).not.toHaveProperty('served_congresses');
    expect(s).toMatchObject({ first_term_start: '1997-01-07', last_term_end: '2027-01-03' });
  });

  it('a row from before migration 026 has none of them', () => {
    const s = toSenator(row())!;
    for (const k of ['left_at', 'first_term_start', 'last_term_end', 'served_congresses']) expect(s).not.toHaveProperty(k);
  });
});

describe('a covered former member stays listed', () => {
  it('is in the picker with left_at set, so the web can say "former"', async () => {
    const c = new SenatorCache(async () => [
      row({ politician_id: 'S000148', name: 'Charles E. Schumer', party: 'Democrat', state: 'NY', left_at: '' }),
      row({ left_at: '2027-01-03' }),
    ]);
    const listed = await c.list();
    expect(listed.map((s) => s.politician_id)).toEqual(['C001035', 'S000148']);
    expect(listed.find((s) => s.politician_id === 'C001035')).toMatchObject({ cached: true, left_at: '2027-01-03' });
    expect(listed.find((s) => s.politician_id === 'S000148')).not.toHaveProperty('left_at');
  });
});
