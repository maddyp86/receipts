import { voteOf } from './deriveAlignment.js';

// ===========================================================================
// What became of the bill.
//
// This is what separates "he tried and the chamber didn't act" from "he didn't
// try" — the distinction the effort signal exists to make, and the one an
// averaged score erases completely.
//
// ── Freshness ────────────────────────────────────────────────────────────
// Bill status is MUTABLE. It is refreshed weekly upstream, and the verdict rows
// are append-only, so a status copied onto a verdict at evaluation time freezes
// and ages silently. Always join it live on Bill ID, and always carry the
// as-of date: "became law" is a claim about a mutable fact; "became law
// (verified 3 days ago)" is a defensible one.
// ===========================================================================

export type BillOutcome =
  | 'BECAME_LAW'
  | 'VETOED'
  | 'PASSED_SENATE'
  | 'DIED_ON_FLOOR'
  | 'REPORTED_OUT'
  | 'IN_COMMITTEE'
  | 'INTRODUCED'
  | 'DIED_AT_CLOTURE'
  | 'NEVER_SCHEDULED'
  | 'UNKNOWN';

/**
 * Raw congress.gov / unitedstates-congress scraper strings, PREFIX-matched.
 *
 * Do not normalise the stored values: the aggregation layer prefix-matches the
 * same strings, and rewriting them here would silently break its counts.
 */
const STATUS_PREFIXES: Array<[string[], BillOutcome]> = [
  [['ENACTED'], 'BECAME_LAW'],
  [['VETOED'], 'VETOED'],
  [['PASSED', 'PASS_OVER', 'PASS_BACK'], 'PASSED_SENATE'],
  [['FAIL', 'PROV_KILL'], 'DIED_ON_FLOOR'],
  // REPORTED and REFERRED are NOT the same state. The 08-16 legend groups
  // REPORTED with the advanced statuses (it cleared committee) and REFERRED
  // with the dead ones (it never left). Collapsing them loses exactly the
  // "he tried and the chamber didn't act" distinction this module exists for.
  [['REPORTED'], 'REPORTED_OUT'],
  [['REFERRED'], 'IN_COMMITTEE'],
  [['INTRODUCED'], 'INTRODUCED'],
];

export interface BillOutcomeInput {
  /** From Bills Master, joined live. Absent is fine — we fall back. */
  status?: string | null;
  vote?: string | null;
  cloture_vote?: string | null;
  passage_vote?: string | null;
}

export interface BillOutcomeResult {
  outcome: BillOutcome;
  /** True when derived from vote fields because no status was available. */
  derived_from_votes: boolean;
  display: string;
}

const DISPLAY: Record<BillOutcome, string> = {
  BECAME_LAW: 'Became law',
  VETOED: 'Passed Congress, then vetoed',
  PASSED_SENATE: 'Passed the Senate',
  DIED_ON_FLOOR: 'Failed on the floor',
  REPORTED_OUT: 'Reported out of committee, but never got a floor vote',
  IN_COMMITTEE: 'Referred to committee and never left it',
  INTRODUCED: 'Introduced only',
  DIED_AT_CLOTURE: 'Died at cloture — never reached a final vote',
  NEVER_SCHEDULED: 'Never scheduled for a vote',
  UNKNOWN: 'Status not available',
};

export function billOutcome(input: BillOutcomeInput): BillOutcomeResult {
  const status = String(input.status ?? '').trim().toUpperCase();

  if (status) {
    for (const [prefixes, outcome] of STATUS_PREFIXES) {
      if (prefixes.some((p) => status.startsWith(p))) {
        return { outcome, derived_from_votes: false, display: DISPLAY[outcome] };
      }
    }
  }

  // Graceful degradation: the first three states are derivable from the vote
  // fields alone, so the app still says something true when the Bills Master
  // join is unavailable.
  const cloture = voteOf(input.cloture_vote);
  const passage = voteOf(input.passage_vote);
  const flat = voteOf(input.vote);

  let outcome: BillOutcome;
  if (passage) {
    outcome = 'PASSED_SENATE';
  } else if (cloture) {
    // A cloture vote with no passage vote means the bill never got that far.
    outcome = 'DIED_AT_CLOTURE';
  } else if (!flat) {
    outcome = 'NEVER_SCHEDULED';
  } else {
    outcome = 'UNKNOWN';
  }

  return { outcome, derived_from_votes: true, display: DISPLAY[outcome] };
}

/**
 * Only `ENACTED*` and `VETOED*` are terminal. Everything else can still move.
 *
 * `FAIL:*` in particular is NOT terminal — a bill that failed cloture can
 * return under a motion to reconsider, which is exactly the Rule XIII case the
 * procedural switch detects. Never phrase a non-terminal status as final.
 */
const TERMINAL: ReadonlySet<BillOutcome> = new Set<BillOutcome>(['BECAME_LAW', 'VETOED']);

export function isTerminal(outcome: BillOutcome): boolean {
  return TERMINAL.has(outcome);
}

export const NON_TERMINAL_NOTE =
  'A bill that failed on the floor can still return under a motion to reconsider.';

/**
 * Literal sentinels the upstream writer uses in place of a timestamp.
 *
 * `Status Changed At` holds an ISO date from `status_at`, or `No Change` (the
 * bill was checked and had not moved), or `Unverified` (the fetch failed).
 * `Unknown` appears where the payload carried no `status_at` at all.
 *
 * None of them is a date, and they do not mean the same thing: `No Change` is a
 * successful check, `Unverified` is a failed one. Both are handled here, but a
 * caller distinguishing them should read the raw value rather than this string.
 */
const NOT_A_TIMESTAMP = new Set([
  'UNKNOWN',
  'UNVERIFIED',
  'NO CHANGE',
  'NA',
  'N/A',
  'NULL',
]);

/**
 * Render a status with its as-of date. There is no overload without the date,
 * on purpose — an undated status claim is the one this module exists to prevent.
 */
export function statusWithAsOf(display: string, statusCheckedAt?: string | null): string {
  const stamp = String(statusCheckedAt ?? '').trim();
  if (!stamp) return `${display} (as-of date unavailable)`;

  // A sentinel rendered as if it were a date produces "verified Unknown", which
  // reads as a verification that did not happen. Say so plainly instead.
  if (NOT_A_TIMESTAMP.has(stamp.toUpperCase())) {
    return `${display} (not verified — no check-date on record)`;
  }

  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) {
    return `${display} (not verified — check-date unreadable)`;
  }
  const rendered = date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  return `${display} (verified ${rendered})`;
}
