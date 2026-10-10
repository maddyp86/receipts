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

/** “U.S. Senator for New York” / “U.S. Representative for New York’s 17th District”. */
export function memberTitle(m: Member): string {
  const state = stateName(m.state);
  if (m.chamber === 'senate') return state ? `U.S. Senator for ${state}` : 'U.S. Senator';
  if (!state) return 'U.S. Representative';
  if (!m.district || districtCount(m.state) === 1) return `U.S. Representative for ${state}`;
  return `U.S. Representative for ${state}’s ${ordinal(m.district)} District`;
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
