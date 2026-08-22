import type { ActionTier, VotePattern } from '@receipts/shared';
import {
  castVotesOf,
  isCosponsor,
  isSponsor,
  voteOf,
  type AlignmentInput,
} from './deriveAlignment.js';

// ===========================================================================
// PORT of WF11 `Compute Decision Score` -> votePattern / action tier.
// Workflow: Decision Scoring (WF11) — toxQrXxgx8QNvXoc
//
// Receipts does not display the decision score, so the multipliers here are not
// used to compute anything a voter sees. They are ported anyway for two
// reasons: the patterns themselves carry real narrative value (a decisive block
// is a different act from joining a foregone conclusion), and keeping the
// multiplier table alongside them means that if Receipts ever surfaces the
// score, it reproduces WF11 rather than approximating it.
// ===========================================================================

/**
 * Magnitude multipliers. A multiplier can never flip a sign — divergence
 * between the two stages means the verdict rests on the any-NAY tiebreak, so it
 * shrinks confidence in the magnitude rather than changing direction.
 *
 * Level-2 only. Never render these numbers to a voter.
 */
export const PATTERN_MULTIPLIER: Record<VotePattern, number> = {
  DECISIVE_BLOCK: 1.15, // cloture NAY, bill never reached passage
  CONSISTENT_OPPOSE: 1.05, // NAY at both stages
  CONSISTENT_SUPPORT: 1.05, // YEA at both stages
  PASSAGE_ONLY: 1.0, // uncontested; the common low-salience case
  NO_FLOOR_ACTION: 1.0, // sponsorship / abstention paths
  BLOCKED_THEN_JOINED: 0.9, // cloture NAY then passage YEA
  ENABLED_THEN_OPPOSED: 0.9, // cloture YEA then passage NAY
  CLOTURE_ONLY_YEA: 0.9, // procedural assent is not endorsement
};

/**
 * Plain-language narrative per pattern, for the evidence card. This is the
 * voter-facing half of the pattern — it names cloture and passage separately
 * and never mentions the multiplier.
 */
export const PATTERN_NARRATIVE: Record<VotePattern, string> = {
  DECISIVE_BLOCK:
    'voted against ending debate, and the bill never reached a final vote — that block is what stopped it',
  CONSISTENT_OPPOSE: 'voted against it at both stages — ending debate and final passage',
  CONSISTENT_SUPPORT: 'voted for it at both stages — ending debate and final passage',
  PASSAGE_ONLY: 'cast a single recorded vote on final passage',
  NO_FLOOR_ACTION: 'put their name to the bill without a recorded floor vote',
  BLOCKED_THEN_JOINED:
    'voted against ending debate, then voted for the bill once it was going to pass anyway',
  ENABLED_THEN_OPPOSED:
    'voted to let the bill reach the floor, then voted against enacting it',
  CLOTURE_ONLY_YEA:
    'voted only to let debate end — a procedural step, not a vote on the bill itself',
};

/**
 * Derive the pattern from the typed cloture and passage fields.
 *
 * The flat `vote` field is only consulted as a last resort. It is a collapsed
 * rollup that takes the PASSAGE value when the two diverge, which erases the
 * block on exactly the rows where it matters most.
 */
export function votePattern(
  cloture: string | null | undefined,
  passage: string | null | undefined,
  flatVote: string | null | undefined,
): VotePattern {
  const c = voteOf(cloture);
  const p = voteOf(passage);

  if (c && p) {
    if (c === 'NAY' && p === 'NAY') return 'CONSISTENT_OPPOSE';
    if (c === 'YEA' && p === 'YEA') return 'CONSISTENT_SUPPORT';
    if (c === 'NAY' && p === 'YEA') return 'BLOCKED_THEN_JOINED';
    return 'ENABLED_THEN_OPPOSED'; // c YEA, p NAY
  }
  if (c && !p) return c === 'NAY' ? 'DECISIVE_BLOCK' : 'CLOTURE_ONLY_YEA';
  if (!c && p) return 'PASSAGE_ONLY';

  // Neither typed vote present. A flat vote with no type attribution is still a
  // floor vote; it just carries no parliamentary detail.
  return voteOf(flatVote) ? 'PASSAGE_ONLY' : 'NO_FLOOR_ACTION';
}

/** WF11's abstention detector: a recorded "Not Voting" on a roll call. */
export function isAbstention(v: string | null | undefined): boolean {
  return String(v ?? '')
    .trim()
    .toUpperCase()
    .includes('NOT');
}

/**
 * Which tier of action this is. Order matters and mirrors WF11:
 * a recorded directional vote outranks everything; a recorded abstention
 * outranks sponsorship; sponsorship outranks co-sponsorship.
 */
export function actionTier(input: AlignmentInput, partyAlignment?: string): ActionTier {
  if (castVotesOf(input).length) return 'VOTED';

  // A recorded "Not Voting" is an abstention and outranks sponsorship: showing
  // up to sponsor a bill and then not casting the recorded vote on it is not
  // evidence of effort. (ADR-011, docs/adr/README.md — scored as behaviour,
  // described as behaviour.)
  const party = String(partyAlignment ?? '').trim().toUpperCase();
  if (party === 'NOT_VOTED' || isAbstention(input.vote)) return 'ABSTAIN';

  if (isSponsor(input)) return 'SPONSOR';
  if (isCosponsor(input)) return 'CO_SPONSOR';
  return 'NONE';
}
