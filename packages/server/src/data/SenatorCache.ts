import type { Senator } from '@receipts/shared';

// ===========================================================================
// The two-speed model (ADR-004, docs/adr/README.md): a few senators are analysed and answer
// instantly; everyone else is honestly uncached and becomes a demand signal.
//
// Deliberately a map rather than a lookup against a roster API — the point of
// MVP coverage is that it is small, known, and truthfully labelled in the UI.
// ===========================================================================

const CACHED: Senator[] = [
  {
    politician_id: 'S000148',
    name: 'Chuck Schumer',
    cached: true,
    party: 'D',
    state: 'NY',
  },
  {
    politician_id: 'T000250',
    name: 'John Thune',
    cached: true,
    party: 'R',
    state: 'SD',
  },
];

/**
 * A short uncached roster so the picker can show honest coverage rather than
 * pretending the two analysed senators are the whole Senate. Selecting one of
 * these reaches the uncached state and captures the request.
 */
const UNCACHED: Senator[] = [
  { politician_id: 'W000817', name: 'Elizabeth Warren', cached: false, party: 'D', state: 'MA' },
  { politician_id: 'C001098', name: 'Ted Cruz', cached: false, party: 'R', state: 'TX' },
  { politician_id: 'S000033', name: 'Bernie Sanders', cached: false, party: 'I', state: 'VT' },
  { politician_id: 'M000355', name: 'Mitch McConnell', cached: false, party: 'R', state: 'KY' },
  { politician_id: 'K000377', name: 'Mark Kelly', cached: false, party: 'D', state: 'AZ' },
];

const ALL = [...CACHED, ...UNCACHED];

export class SenatorCache {
  list(): Senator[] {
    // Cached first — the picker is how a user learns what they can ask.
    return ALL;
  }

  resolve(politicianId: string): Senator | undefined {
    return ALL.find((s) => s.politician_id === politicianId);
  }

  isCached(politicianId: string): boolean {
    return CACHED.some((s) => s.politician_id === politicianId);
  }
}

export const senatorCache = new SenatorCache();
