import type { VoteTally } from '@receipts/shared';

// ===========================================================================
// SHOW VOTES (Matt, 15 Nov). "We can say he took action but those actions
// could be passive or misleading as Congress plays games." A vote whose
// outcome was never in doubt, cast along party lines, is a different act from
// a vote that decided something. These flags say which it was, from the
// roll-call tallies the record already holds.
//
// FACTS, NOT MOTIVE. The product does not attribute intent, so the flags say
// what the tally shows ("party-line", "not close") and never why anyone voted.
// Disclosure only: they move no weight and no direction.
//
// Conservative by construction: a flag is raised only when it holds for every
// recorded roll call on the bill, so a close vote to end debate followed by a
// lopsided final vote (the Laken Riley Act: 61-35 with 60 needed, then 64-35)
// raises no NOT_CLOSE.
// ===========================================================================

/** Votes beyond (or short of) what was needed for a result to count as not close. */
export const NOT_CLOSE_MARGIN = 5;

/** Share of a party's Yea and Nay votes on one side for it to count as voting as a bloc. */
export const PARTY_LINE_SHARE = 0.9;

/** A party needs at least this many Yea and Nay votes to count toward a party-line reading. */
const PARTY_LINE_MIN_VOTES = 10;

export const PARTY_LINE = 'PARTY_LINE';
export const NOT_CLOSE = 'NOT_CLOSE';

/** Yea votes needed: 60 for a 3/5 vote, 67 for 2/3, else a majority of those voting. */
export function votesNeeded(t: VoteTally): number {
  if (t.threshold === '3/5') return 60;
  if (t.threshold === '2/3') return 67;
  return Math.floor((t.yea + t.nay) / 2) + 1;
}

/** Yeas over (positive) or under (negative) what the vote needed. */
export function voteMargin(t: VoteTally): number {
  return t.yea - votesNeeded(t);
}

/** Democrats and Republicans each voted as a bloc, on opposite sides. */
export function isPartyLine(t: VoteTally): boolean {
  const side = (p: { yea: number; nay: number } | undefined): 'Yea' | 'Nay' | null => {
    if (!p) return null;
    const cast = p.yea + p.nay;
    if (cast < PARTY_LINE_MIN_VOTES) return null;
    if (p.yea / cast >= PARTY_LINE_SHARE) return 'Yea';
    if (p.nay / cast >= PARTY_LINE_SHARE) return 'Nay';
    return null;
  };
  const d = side(t.by_party?.D);
  const r = side(t.by_party?.R);
  return d !== null && r !== null && d !== r;
}

/** Not close: cleared or missed what it needed by NOT_CLOSE_MARGIN votes or more. */
export function isNotClose(t: VoteTally): boolean {
  return Math.abs(voteMargin(t)) >= NOT_CLOSE_MARGIN;
}

/** The flags a bill's roll calls earn: each only when every roll call on the bill shows it. */
export function voteMarginFlags(tallies: VoteTally[] | null | undefined): string[] {
  const ts = (tallies ?? []).filter((t) => Number.isFinite(t.yea) && Number.isFinite(t.nay));
  if (!ts.length) return [];
  const out: string[] = [];
  if (ts.every(isPartyLine)) out.push(PARTY_LINE);
  if (ts.every(isNotClose)) out.push(NOT_CLOSE);
  return out;
}
