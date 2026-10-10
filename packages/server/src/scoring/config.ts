import type { EvidenceType } from '@receipts/shared';

// ===========================================================================
// Scoring constants. Every tunable number lives here.
//
// Two provenance classes, and the difference matters:
//
//   LIVE      — read from the batch pipeline. Changing one of these makes
//               Receipts disagree with the senator profile. Don't.
//   RECEIPTS  — presentation-layer only, with no pipeline equivalent, because
//               the confidence *band* is something Receipts invented for voters
//               (originally SCORING_REFERENCE.md §5 — that file does not exist
//               and the bands are documented nowhere else; see docs/adr/README.md).
//               These are honest MVP defaults and
//               are the ones that want an eval pass.
// ===========================================================================

export const SIMILARITY = {
  /**
   * RECEIPTS — the evidence floor: a match below this does not count toward a
   * verdict. DEPARTS from the pipeline (WF7a `STRONG_THRESHOLD`, 0.575); see
   * docs/RECONCILIATION.md, 2026-10-10.
   *
   * Lowered to the retrieval floor on 2026-10-10 after the accuracy set
   * (docs/eval/cases.json): the query tool's own promise text scores
   * systematically lower against the bill vectors than the corpus text the
   * pipeline calibrated on, and relevant bills the relevance check had already
   * confirmed sat at 0.50–0.573. A floor replay of the first eval run admitted
   * no wrongly-directed bill at 0.50. Precision is the relevance gate's job,
   * not the threshold's — the pipeline's own reasoning for lowering it from
   * 0.60 on 2026-08-09 (coverage 12/30 → 23/30 promises).
   *
   * Equal to WEAK, so every retrieved candidate that survives the relevance
   * check is weighed, and ALL_BELOW_FLOOR can no longer occur.
   */
  STRONG: 0.5,

  /**
   * RECEIPTS — display only: the score at which a card says "closely related"
   * rather than "loosely related". The pipeline's evidence floor, kept as the
   * wording line when the floor moved, so a 0.51 match is not described as
   * close. Not read by scoring.
   */
  CLOSE: 0.575,

  /**
   * LIVE — WF7a `WEAK_THRESHOLD`. Retrieved and worth acknowledging, but not
   * evidence. Below this, dropped entirely.
   */
  WEAK: 0.5,
} as const;

/**
 * RECEIPTS — average match strength required for a High band.
 *
 * There is no pipeline equivalent: WF11 has a confidence *multiplier*, not a
 * band. This is an MVP default chosen to sit meaningfully above the evidence
 * floor rather than derived from data, and it is the single number here most
 * likely to be wrong. Calibrate against the eval harness before trusting a
 * "we're confident" headline.
 */
export const HIGH_AVG_STRENGTH = 0.65;

/**
 * PRD §8.3 weighting. Hard evidence is a vote or a sponsorship; procedural and
 * associative matches are real but weaker, and cannot on their own carry a
 * confident verdict.
 */
export const EVIDENCE_TYPE_FACTOR: Record<EvidenceType, number> = {
  vote: 1.0,
  sponsorship: 1.0,
  procedural: 0.5,
  associative: 0.3,
};

/**
 * Share of total directed weight the minority side must reach before the
 * conflict is described as meaningful in the Level-2 trace.
 *
 * This does NOT gate ranked mode — per the direction gate, *any* genuine
 * directional conflict routes to ranked verdicts. It only affects how the
 * trace characterises the split.
 */
export const MEANINGFUL_MINORITY_SHARE = 0.15;
