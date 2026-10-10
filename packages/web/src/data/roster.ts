import type { Senator } from '@receipts/shared';

// ===========================================================================
// Who the picker shows.
//
// COVERAGE IS THE SERVER'S, NOT THIS FILE'S. `/api/senators` lists the members
// the pipeline has actually analysed, and only those can be checked. This file
// adds two things the server does not carry:
//
//   1. chamber / district / area for the members we know about, so a House
//      member is titled and found correctly;
//   2. the members planned for the 2026 midterm beta who are NOT analysed yet,
//      so a voter can see they are coming instead of finding nothing.
//
// A member listed here lights up by itself the moment the pipeline covers
// them — no web deploy. Nothing here can make an unanalysed member checkable.
//
// Ids, names, parties and districts are from the unitedstates/congress-
// legislators `legislators-current` file, read 2026-10-09.
// ===========================================================================

export type Chamber = 'senate' | 'house';
export type Party = 'D' | 'R' | 'I';

export interface Member {
  politician_id: string;
  name: string;
  party?: Party;
  state?: string;
  chamber: Chamber;
  /** House only. Omitted for senators and whole-state representatives. */
  district?: number;
  /** House only. Plain-language description of where the district is. */
  area?: string;
  /** True only when the server says the pipeline has analysed this member. */
  cached: boolean;
  /** On the November 2026 ballot. */
  on_ballot_2026?: boolean;
}

type Planned = Omit<Member, 'cached'>;

/** The midterm beta list. Order is display order among not-yet-covered members. */
export const MIDTERM_ROSTER: readonly Planned[] = [
  // Covered at launch. Neither is on the 2026 ballot.
  { politician_id: 'S000148', name: 'Charles E. Schumer', party: 'D', state: 'NY', chamber: 'senate' },
  { politician_id: 'T000250', name: 'John Thune', party: 'R', state: 'SD', chamber: 'senate' },

  // Wave 1 — senators on the November 2026 ballot.
  { politician_id: 'C001035', name: 'Susan M. Collins', party: 'R', state: 'ME', chamber: 'senate', on_ballot_2026: true },
  { politician_id: 'S001198', name: 'Dan Sullivan', party: 'R', state: 'AK', chamber: 'senate', on_ballot_2026: true },
  { politician_id: 'M001198', name: 'Roger Marshall', party: 'R', state: 'KS', chamber: 'senate', on_ballot_2026: true },
  { politician_id: 'O000174', name: 'Jon Ossoff', party: 'D', state: 'GA', chamber: 'senate', on_ballot_2026: true },
  { politician_id: 'W000805', name: 'Mark R. Warner', party: 'D', state: 'VA', chamber: 'senate', on_ballot_2026: true },
  { politician_id: 'L000570', name: 'Ben Ray Luján', party: 'D', state: 'NM', chamber: 'senate', on_ballot_2026: true },

  // Wave 2 — House pilot. Every House seat is on the ballot.
  { politician_id: 'L000599', name: 'Michael Lawler', party: 'R', state: 'NY', chamber: 'house', district: 17, area: 'the lower Hudson Valley', on_ballot_2026: true },
  { politician_id: 'V000129', name: 'David G. Valadao', party: 'R', state: 'CA', chamber: 'house', district: 22, area: 'the southern Central Valley', on_ballot_2026: true },
  { politician_id: 'P000605', name: 'Scott Perry', party: 'R', state: 'PA', chamber: 'house', district: 10, area: 'the Harrisburg and York area', on_ballot_2026: true },
  { politician_id: 'G000600', name: 'Marie Gluesenkamp Perez', party: 'D', state: 'WA', chamber: 'house', district: 3, area: 'southwest Washington', on_ballot_2026: true },
  { politician_id: 'K000009', name: 'Marcy Kaptur', party: 'D', state: 'OH', chamber: 'house', district: 9, area: 'the Toledo area and northwest Ohio', on_ballot_2026: true },
  { politician_id: 'G000581', name: 'Vicente Gonzalez', party: 'D', state: 'TX', chamber: 'house', district: 34, area: 'the lower Rio Grande Valley', on_ballot_2026: true },
];

/**
 * The picker's list: every member the server covers, plus the planned members
 * it does not cover yet.
 *
 * The server's row wins on name, party and state — the mirror is the record.
 * A covered member this file has never heard of is shown as a senator, because
 * that is all the pipeline analyses today; add them above when that changes.
 */
export function buildRoster(covered: readonly Senator[]): Member[] {
  const planned = new Map(MIDTERM_ROSTER.map((m) => [m.politician_id, m]));
  const seen = new Set<string>();
  const out: Member[] = [];

  for (const s of covered) {
    const meta = planned.get(s.politician_id);
    seen.add(s.politician_id);
    out.push({
      ...(meta ?? { chamber: 'senate' as const }),
      politician_id: s.politician_id,
      name: s.name,
      party: s.party ?? meta?.party,
      state: s.state ?? meta?.state,
      cached: Boolean(s.cached),
    });
  }
  for (const m of MIDTERM_ROSTER) {
    if (!seen.has(m.politician_id)) out.push({ ...m, cached: false });
  }
  return out;
}
