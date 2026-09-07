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
// SOURCE: fix/06_wf10a_derive_alignment.js, 2026-09-05.
// Ported 2026-09-07 per fix/14_claude_code_handoff_v2.md §10 (behavioural
// contracts 1 and 2). Copy the logic, not the field names — the n8n original
// reads matchData['Cloture Vote']; this reads AlignmentInput.cloture_vote.
//
// ── 2026-09-05: "ANY NAY GOVERNS" REMOVED ─────────────────────────────────
// The previous version of THIS FILE implemented the pre-fix rule, and defended
// it at length. That defence was accurate about the node as it stood before
// fix/06 and is now wrong. Recording what it said, because the argument is
// seductive and will be re-proposed by anyone reading the split-vote data cold:
//
//   "cloture NAY + passage YEA — blocked the bill, then joined once it was
//    going to pass anyway. The block is the real position.
//    cloture YEA + passage NAY — allowed debate as procedural courtesy, then
//    opposed enactment. The passage NAY is the real position."
//
// Both halves read the NAY as decisive. Stated plainly, that is not a rule
// about which vote binds — it is a rule that a split vote is always opposition,
// and therefore always a BROKE when the bill ADVANCEs the goal. The audit found
// 14 rows produced this way, including the March 2025 CR votes where the
// cloture YEA was the operative 60-vote act and the passage NAY was symbolic.
//
// The rule now, applied SYMMETRICALLY:
//   - Both votes present and agreeing -> that direction.
//   - Both present and diverging: the vote taken at the BINDING threshold
//     governs. Cloture requires 60, so when a cloture vote exists the bill
//     lives or dies there and cloture governs. Passage governs only when no
//     cloture vote was taken.
//   - A divergent row ALWAYS carries split=true so callers can display both
//     votes and cap confidence at 0.75 (contract 2).
//   - Sponsor + any NAY -> PROCEDURAL_SWITCH (unchanged).
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
 * The outcome of the alignment table, plus the disclosure fields that make a
 * split vote reportable.
 *
 * `governing` and `split` are DISCLOSURE, not bookkeeping. Handoff v2 §4: "A
 * row that reads 'voted NAY -> BROKE' while hiding a cloture YEA is exactly the
 * claim a senator's office knocks down." Anything that renders a verdict must
 * render these alongside it.
 */
export interface DerivedAlignment {
  verdict: AlignmentOutcome;
  /** Human-readable statement of which vote decided, e.g. 'CLOTURE (60-vote threshold; split vote)'. */
  governing: string;
  /** True when cloture and passage diverge. Caps confidence at 0.75 downstream. */
  split: boolean;
}

/**
 * Every directional vote on the bill, in WF10A's field order, with
 * non-directional entries removed.
 *
 * Still used for "did this senator act at all" questions (action tier, effort
 * signals). It deliberately says nothing about which vote governs — that is
 * `effectiveVote`'s job and the two answers differ on split rows.
 */
export function castVotesOf(input: AlignmentInput): Array<'YEA' | 'NAY'> {
  return [voteOf(input.vote), voteOf(input.cloture_vote), voteOf(input.passage_vote)].filter(
    (v): v is 'YEA' | 'NAY' => v !== null,
  );
}

/** The three vote fields, normalised, in the precedence order fix/06 reads them. */
function votesOf(input: AlignmentInput) {
  return {
    cloture: voteOf(input.cloture_vote),
    passage: voteOf(input.passage_vote),
    /** Legacy resolved rollup. Used only when neither typed vote exists. */
    plain: voteOf(input.vote),
  };
}

/**
 * True when cloture and passage were both cast and point opposite ways.
 *
 * Exported because contract 2's confidence cap applies wherever a confidence is
 * finalised, which is not always where the verdict is derived.
 */
export function isSplitVote(input: AlignmentInput): boolean {
  const { cloture, passage } = votesOf(input);
  return Boolean(cloture && passage && cloture !== passage);
}

/**
 * Contract 2: a split vote caps confidence at 0.75, whatever the evaluator said.
 *
 * The cap is applied in code rather than asked for in the prompt because it is
 * the one confidence rule that must hold even when the model ignores it.
 */
export const SPLIT_VOTE_CONFIDENCE_CAP = 0.75;

export function capSplitConfidence(confidence: number, split: boolean): number {
  if (!split || !Number.isFinite(confidence)) return confidence;
  return Math.min(confidence, SPLIT_VOTE_CONFIDENCE_CAP);
}

/**
 * The vote that decides, under the binding-threshold rule.
 *
 * NOT "any NAY". Cloture governs whenever it was taken, because that is where a
 * bill needing 60 lives or dies; passage governs only in its absence; the flat
 * `vote` rollup is a last resort because it takes the passage value when the two
 * diverge, erasing the block on exactly the rows where it matters most.
 *
 * `effortSignals` reads this too, and inherits the fix deliberately: there is
 * one notion of which vote counted, and the divergence is disclosed through
 * `split` rather than by holding two different opinions about it.
 */
export function effectiveVote(input: AlignmentInput): NormalisedVote {
  const { cloture, passage, plain } = votesOf(input);
  if (cloture) return cloture;
  if (passage) return passage;
  return plain;
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
): DerivedAlignment {
  const isPromise = statementType === 'Campaign Promise';
  const KEPT: AlignmentOutcome = isPromise ? 'KEPT' : 'CONSISTENT';
  const BROKE: AlignmentOutcome = isPromise ? 'BROKE' : 'INCONSISTENT';
  const ND: AlignmentOutcome = 'NOT_DETERMINABLE';

  const effect = String(input.bill_effect ?? '').toUpperCase();

  if (effect === 'ERROR') return { verdict: 'ERROR', governing: 'NA', split: false };
  // NEUTRAL and CONTESTED are findings that the bill does not settle the
  // question — named explicitly so CONTESTED cannot fall through as "unknown
  // effect" once evaluator v7 starts emitting it.
  if (effect === 'NEUTRAL' || effect === 'CONTESTED') {
    return { verdict: ND, governing: 'NA', split: false };
  }
  if (effect !== 'ADVANCE' && effect !== 'HINDER') {
    return { verdict: ND, governing: 'NA', split: false };
  }

  const { cloture, passage, plain } = votesOf(input);
  const sponsored = isSponsored(input);

  // Sponsored the bill and then voted against it. Under Senate Rule XIII only a
  // member voting on the prevailing side may move to reconsider, so this is a
  // parliamentary maneuver rather than opposition. Not scored either way.
  //
  // Checked against ALL THREE vote fields, not the governing one: a sponsor NAY
  // anywhere is the Rule XIII signature regardless of which vote binds.
  if (sponsored && [cloture, passage, plain].includes('NAY')) {
    return { verdict: 'PROCEDURAL_SWITCH', governing: 'SPONSOR_NAY', split: false };
  }

  let effective: NormalisedVote = null;
  let governing = 'NA';
  let split = false;

  if (cloture && passage) {
    split = cloture !== passage;
    effective = cloture; // cloture is the binding vote when it exists
    governing = split ? 'CLOTURE (60-vote threshold; split vote)' : 'CLOTURE+PASSAGE (agree)';
  } else if (cloture) {
    effective = cloture;
    governing = 'CLOTURE (only vote recorded)';
  } else if (passage) {
    effective = passage;
    governing = 'PASSAGE (no cloture vote)';
  } else if (plain) {
    effective = plain;
    governing = 'VOTE (untyped)';
  }

  let supported: boolean;
  if (effective) {
    supported = effective === 'YEA';
  } else if (sponsored) {
    // Co-sponsorship is active legislative support and is determinative when no
    // vote overrides it.
    supported = true;
    governing = 'SPONSORSHIP';
  } else {
    // No vote and no sponsorship = no action.
    return { verdict: ND, governing: 'NO_ACTION', split: false };
  }

  // Stance is already baked into ADVANCE/HINDER — never re-apply it.
  const verdict = effect === 'ADVANCE' ? (supported ? KEPT : BROKE) : (supported ? BROKE : KEPT);
  return { verdict, governing, split };
}
