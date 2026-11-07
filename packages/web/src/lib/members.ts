import { longDate } from '@receipts/shared';
import { usStates } from '../data/states.js';
import type { Member, Party } from '../data/roster.js';

export function stateName(code: string | undefined): string {
  if (!code) return '';
  return usStates.find((s) => s.code === code)?.name ?? code;
}

export function districtCount(code: string | undefined): number {
  return usStates.find((s) => s.code === code)?.districts ?? 0;
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]!);
}

export function partyName(party: Party | undefined): string {
  if (party === 'D') return 'Democrat';
  if (party === 'R') return 'Republican';
  if (party === 'I') return 'Independent';
  return '';
}

/**
 * “U.S. Senator for New York” / “U.S. Representative for New York’s 17th
 * District”. A member who has left office is “Former U.S. Senator for Maine”:
 * their record is still here to check, and the title must not say they hold
 * the seat.
 */
export function memberTitle(m: Member): string {
  const former = isFormer(m) ? 'Former ' : '';
  const state = stateName(m.state);
  if (m.chamber === 'senate') return state ? `${former}U.S. Senator for ${state}` : `${former}U.S. Senator`;
  if (!state) return `${former}U.S. Representative`;
  if (!m.district || districtCount(m.state) === 1) return `${former}U.S. Representative for ${state}`;
  return `${former}U.S. Representative for ${state}’s ${ordinal(m.district)} District`;
}

/** True when the server says the member has left office. */
export function isFormer(m: Pick<Member, 'left_at'>): boolean {
  return Boolean(m.left_at);
}

/**
 * “Served until January 3, 2027”, for a former member's card. Says when the
 * seat was left, not why: the record does not say, and neither do we.
 */
export function tenureLine(m: Pick<Member, 'left_at'>): string | null {
  const day = longDate(m.left_at);
  return day ? `Served until ${day}` : null;
}

export function memberArea(m: Member): string | null {
  if (m.chamber !== 'house') return null;
  if (!m.district || districtCount(m.state) === 1) return 'Represents the whole state';
  return m.area ? `Covers ${m.area}` : null;
}

/** “senator” / “representative”, for copy that names the office. */
export function officeNoun(m: Pick<Member, 'chamber'>): string {
  return m.chamber === 'house' ? 'representative' : 'senator';
}

/** Public-domain official portraits, by Bioguide id. Falls back to initials. */
export function portraitUrl(politicianId: string): string {
  return `https://unitedstates.github.io/images/congress/225x275/${politicianId}.jpg`;
}

export function initials(name: string): string {
  const parts = name
    .replace(/,.*$/, '')
    .split(' ')
    .filter((p) => p && !p.endsWith('.'));
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase();
}
