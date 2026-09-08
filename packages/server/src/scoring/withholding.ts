import type { DirectedAction, ScoredResult } from '@receipts/shared';

// ===========================================================================
// BEHAVIOURAL CONTRACT 3 (handoff v2 §10).
//
//   "BROKE/INCONSISTENT below 0.7 → the counterargument must be present or the
//    reading is withheld."
//
// This is the cheap, deterministic half of the false-positive defence. An audit
// found 78 of 79 BROKE verdicts were false positives; v7's gates and prompt
// remove most of that class, and this removes the tail that survives them —
// with no model call and no added latency.
//
// WHY IT IS ASYMMETRIC. It only ever touches accusations. A KEPT at 0.6 is a
// weak favourable reading and the evidence is on screen for anyone to check. A
// BROKE at 0.6 says a sitting senator broke a promise to the public, and the
// downside of being wrong is not symmetric with the downside of staying quiet.
// Nothing here can create or strengthen an accusation.
//
// WHAT "WITHHELD" MEANS. The verdict becomes NOT_DETERMINABLE with a distinct
// reason, so the UI says "we could not defensibly call this" rather than
// "he kept it". Withholding an accusation is not an exoneration, and the copy
// for WITHHELD_LOW_CONFIDENCE must not read like one.
// ===========================================================================

/** Below this, an accusation needs the senator's counterargument on the record. */
export const ACCUSATION_CONFIDENCE_FLOOR = 0.7;

export interface WithholdingOutcome {
  /** The result to render — unchanged, or downgraded. */
  result: ScoredResult;
  /** True when an accusation was withheld. Worth logging; never hidden. */
  withheld: boolean;
  /** Plain-language reason, safe to show. Empty when nothing was withheld. */
  reason: string;
}

/**
 * The confidence backing an accusation.
 *
 * The BEST of the breaking actions, not the average: one well-evidenced action
 * at 0.85 is enough to support the reading even if three weak ones sit beside
 * it. Averaging would let weak corroboration drag a sound accusation below the
 * bar, which is the wrong failure — it withholds a defensible claim.
 */
function accusationConfidence(evidence: DirectedAction[]): number | null {
  const breaking = evidence.filter((e) => e.direction === 'breaks');
  if (!breaking.length) return null;

  const known = breaking
    .map((e) => e.alignment_confidence)
    .filter((c): c is number => typeof c === 'number' && Number.isFinite(c));

  return known.length ? Math.max(...known) : null;
}

/**
 * Apply contract 3.
 *
 * `counterargumentPresent` is a caller-supplied assertion that the senator's
 * strongest counterargument is on the record for this reading. It defaults to
 * FALSE deliberately: v7 asks the evaluator to put the counterargument in
 * `alignment_reasoning` as prose, and prose cannot be verified by inspection.
 * Guessing "there's probably a counterargument in there" is exactly the
 * unverified inference this contract exists to stop, so absent a structured
 * field the answer is no.
 *
 * When the evaluator later emits a discrete `senator_counterargument`, pass it
 * through and low-confidence accusations become renderable again — with the
 * counterargument shown beside them, which was always the point.
 */
export function applyWithholding(
  result: ScoredResult,
  opts: { counterargumentPresent?: boolean } = {},
): WithholdingOutcome {
  // Only accusations. KEPT and NOT_DETERMINABLE pass through untouched.
  if (result.verdict !== 'BROKE') {
    return { result, withheld: false, reason: '' };
  }

  if (opts.counterargumentPresent) {
    return { result, withheld: false, reason: '' };
  }

  const confidence = accusationConfidence(result.evidence);

  // null means no breaking action carried a confidence at all — the evaluator
  // did not run, or returned none. That is LESS evidence than a 0.65, not more,
  // so it fails the bar too. Fail closed: the bar is "demonstrably at or above
  // 0.7", not "not demonstrably below it".
  if (confidence !== null && confidence >= ACCUSATION_CONFIDENCE_FLOOR) {
    return { result, withheld: false, reason: '' };
  }

  const measured =
    confidence === null
      ? 'no confidence was recorded for the actions behind it'
      : `the strongest supporting action is only ${confidence.toFixed(2)} confident`;

  const reason =
    `This reading would say the senator broke the promise, but ${measured} ` +
    `and the senator's counterargument is not on the record. Below ` +
    `${ACCUSATION_CONFIDENCE_FLOOR}, an accusation is withheld rather than shown.`;

  return {
    withheld: true,
    reason,
    result: {
      ...result,
      verdict: 'NOT_DETERMINABLE',
      band: null,
      mode: 'not_determinable',
      nd_reason: 'WITHHELD_LOW_CONFIDENCE',
      // The evidence stays. Withholding the VERDICT is not hiding the record —
      // the bills and votes remain on screen for the reader to weigh. What is
      // withheld is our conclusion about them.
      receipt: {
        ...result.receipt,
        trace: [...(result.receipt.trace ?? []), `Contract 3: ${reason}`],
      },
    },
  };
}
