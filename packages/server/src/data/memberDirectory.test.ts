import { describe, expect, it } from 'vitest';
import { MemberDirectory, toDirectoryMember, type MemberRow } from './MemberDirectory.js';

// ===========================================================================
// Every serving member, for finding them. Listing is not coverage: `cached`
// comes only from the ids the caller says are covered.
// ===========================================================================

const row = (r: Partial<MemberRow>): MemberRow => ({
  member_id: 'P000145', full_name: 'Alex Padilla', chamber: 'Senate', state: 'CA', district: null, party: 'Democrat', ...r,
});

describe('toDirectoryMember', () => {
  it('maps chamber, party and state', () => {
    expect(toDirectoryMember(row({}))).toEqual({ politician_id: 'P000145', name: 'Alex Padilla', chamber: 'senate', party: 'D', state: 'CA' });
  });

  it('keeps a House district and treats an at-large seat as no district', () => {
    expect(toDirectoryMember(row({ chamber: 'House', district: '22' }))!.district).toBe(22);
    expect(toDirectoryMember(row({ chamber: 'House', district: 'AL' }))!.district).toBeUndefined();
    expect(toDirectoryMember(row({ chamber: 'House', district: '0' }))!.district).toBeUndefined();
  });

  it('drops a row with no id, no name or an unknown chamber', () => {
    expect(toDirectoryMember(row({ member_id: '' }))).toBeNull();
    expect(toDirectoryMember(row({ full_name: ' ' }))).toBeNull();
    expect(toDirectoryMember(row({ chamber: 'Delegate' }))).toBeNull();
  });
});

describe('MemberDirectory', () => {
  it('marks only the covered ids as cached', async () => {
    const dir = new MemberDirectory(async () => [row({}), row({ member_id: 'S000148', full_name: 'Charles E. Schumer', state: 'NY' })]);
    const list = await dir.list(new Set(['S000148']));
    expect(list.map((m) => [m.politician_id, m.cached])).toEqual([['P000145', false], ['S000148', true]]);
  });

  it('is empty with no database, and keeps the last good list when a re-read fails', async () => {
    expect(await new MemberDirectory(null).list(new Set())).toEqual([]);
    let t = 0;
    let fail = false;
    const dir = new MemberDirectory(async () => {
      if (fail) throw new Error('down');
      return [row({})];
    }, 1000, () => t);
    expect(await dir.list(new Set())).toHaveLength(1);
    fail = true;
    t = 5000;
    await dir.list(new Set());
    await new Promise((r) => setTimeout(r, 0));
    expect(await dir.list(new Set())).toHaveLength(1);
  });
});
