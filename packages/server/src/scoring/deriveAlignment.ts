import type {
  AlignmentOutcome,
  BillEffect,
  NormalisedVote,
  StatementType,
} from '@receipts/shared';

// ===========================================================================
// PORT of WF10A `Parse LLM Response` -> deriveAlignment.
// Workflow: Promise Alignment (WF10a - Matches) — BuA0XMoRIeA8K-IziChwR
//
// This is a transcription, not a design. Read the method spec
// (docs/specs/wf10a-wf11-method-spec.md) §6 — STEP 3 Verdict — and ADR-010 in
// docs/adr/README.md before changing anything here: the written spec disagreed
// with the live node in three places and was wrong in all three.
// (SCORING_REFERENCE.md §3 was the original citation; that file does not exist —
// the table it named lives in method spec §6.)
//
// THE TABLE IS TWO-FACTOR: bill effect × support. There is deliberately NO
// stance term. Stance is already baked into ADVANCE/HINDER by the interpreting
// model; re-applying it in code inverts the verdict for every "Opposed"
// promise. Measured error when it was re-applied upstream: 0% on ADVANCE, 25%
// on HINDER. That asymmetry is why the bug survived review for so long — an
// "In Favor" stance multiplies by +1, so the wrong formula agrees with the
// right one on every example anyone happened to check.
//
// There is also NO Congressional Review Act special-casing here, and there must
// not be. CRA disapproval resolutions are handled upstream by the interpreting
// model's reversal/termination/disapproval ordering rule when it assigns
// bill_effect. Adding a code-level inversion on top would double-invert and
// reintroduce exactly the bug it looks like it prevents.
// ===========================================================================

/**
 * Normalise a raw vote field to a directional vote.
 *
 * LOAD-BEARING: everything that is not an explicit YEA or NAY returns `null` —
 * "Not Voting", "Present", "NA", and blank alike. Callers drop the nulls, which
 * is what stops an abstention from being read as support. If you make this
 * function "more permissive" you will turn recorded absences into KEPT verdicts.
 */
export function voteOf(v: string | null | undefined): NormalisedVote {
  const t = String(v ?? '').trim().toUpperCase();
  if (t === 'YEA' || t === 'AYE' || t === 'YES') return 'YEA';
  if (t === 'NAY' || t === 'NO') return 'NAY';
  return null;
}

/** WF10A's `truthy` — sheet booleans arrive as strings. */
export function truthy(v: unknown): boolean {
  const t = String(v ?? '').trim().toUpperCase();
  return t === 'TRUE' || t === 'YES' || t === 'Y' || t === '1';
}

export interface AlignmentInput {
  bill_effect: BillEffect | string;
  vote?: string | null;
  cloture_vote?: string | null;
  passage_vote?: string | null;
  is_sponsor?: boolean | string | null;
  is_cosponsor?: boolean | string | null;
}

/**
 * Every directional vote on the bill, in WF10A's field order, with
 * non-directional entries removed.
 */
export function castVotesOf(input: AlignmentInput): Array<'YEA' | 'NAY'> {
  return [voteOf(input.vote), voteOf(input.cloture_vote), voteOf(input.passage_vote)].filter(
    (v): v is 'YEA' | 'NAY' => v !== null,
  );
}

/**
 * ANY NAY GOVERNS. A senator may split cloture and passage, and the split is
 * the signal rather than noise:
 *   cloture NAY + passage YEA — blocked the bill, then joined once it was going
 *     to pass anyway. The block is the real position.
 *   cloture YEA + passage NAY — allowed debate as procedural courtesy, then
 *     opposed enactment. The passage NAY is the real position.
 * Both collapse to the same rule.
 *
 * Note this is NOT "read the flat `vote` field": that field is a rollup which
 * takes the passage value when the two diverge, erasing the block on exactly
 * the rows where it matters most.
 */
export function effectiveVote(input: AlignmentInput): NormalisedVote {
  const cast = castVotesOf(input);
  if (!cast.length) return null;
  return cast.includes('NAY') ? 'NAY' : 'YEA';
}

/** Sheet booleans arrive as strings; real booleans pass through. */
const flag = (v: boolean | string | null | undefined): boolean =>
  typeof v === 'boolean' ? v : truthy(v);

export const isSponsor = (input: AlignmentInput): boolean => flag(input.is_sponsor);
export const isCosponsor = (input: AlignmentInput): boolean => flag(input.is_cosponsor);

export function isSponsored(input: AlignmentInput): boolean {
  return isSponsor(input) || isCosponsor(input);
}

/**
 * The alignment table.
 *
 * Returns the *internal* outcome set, which is wider than the voter-facing
 * label set: PROCEDURAL_SWITCH and ERROR are real results here. Collapse with
 * `toVerdict()` before rendering — never invent a fourth label.
 */
export function deriveAlignment(
  input: AlignmentInput,
  /**
   * REQUIRED — deliberately not defaulted.
   *
   * WF10A defaults this to 'Campaign Promise', which is safe there because the
   * sheet column is always populated. Here the input is arbitrary user text
   * with no provenance, so a default would silently give every free-typed query
   * the promise vocabulary and print "BROKE" against a commitment we have no
   * evidence was ever made. Forcing the caller to decide is the whole guard.
   */
  statementType: StatementType,
): AlignmentOutcome {
  const isPromise = statementType === 'Campaign Promise';
  const KEPT: AlignmentOutcome = isPromise ? 'KEPT' : 'CONSISTENT';
  const BROKE: AlignmentOutcome = isPromise ? 'BROKE' : 'INCONSISTENT';

  const effect = String(input.bill_effect ?? '').toUpperCase();

  if (effect === 'ERROR') return 'ERROR';
  if (effect !== 'ADVANCE' && effect !== 'HINDER') return 'NOT_DETERMINABLE';

  const castVotes = castVotesOf(input);
  const sponsored = isSponsored(input);

  // Sponsored the bill and then voted against it. Under Senate Rule XIII only a
  // member voting on the prevailing side may move to reconsider, so this is a
  // parliamentary maneuver rather than opposition. Not scored either way.
  if (sponsored && castVotes.includes('NAY')) return 'PROCEDURAL_SWITCH';

  let supported: boolean;
  if (castVotes.length) {
    supported = !castVotes.includes('NAY');
  } else if (sponsored) {
    // Co-sponsorship is active legislative support and is determinative when no
    // vote overrides it.
    supported = true;
  } else {
    return 'NOT_DETERMINABLE'; // no vote and no sponsorship = no action
  }

  // Stance is already baked into ADVANCE/HINDER — never re-apply it.
  if (effect === 'ADVANCE') return supported ? KEPT : BROKE;
  return supported ? BROKE : KEPT; // HINDER
}
