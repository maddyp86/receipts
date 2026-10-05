import {
  EFFECT_UNREAD,
  TEXT_AT_ACTION_UNAVAILABLE,
  DECISIVE_ENRICHMENT_GAPS,
  ENRICHMENT_GAP_PHRASE,
  type DirectedAction,
  type EnrichmentGap,
  type ScoredResult,
} from '@receipts/shared';
import { EVIDENCE_TYPE_FACTOR } from './config.js';
import { effectiveVote } from './deriveAlignment.js';

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
 * The weight an unread row would carry had the evaluator read it as directed:
 * its match score times the factor for its kind of hard evidence — a vote when
 * it carries a directional one, otherwise a sponsorship. Factors come from
 * config, so this moves with them.
 */
function unreadWeight(e: DirectedAction): number {
  return e.score * EVIDENCE_TYPE_FACTOR[effectiveVote(e) ? 'vote' : 'sponsorship'];
}

// Which failed reads decide the text or a gate lives in shared, beside the
// sentence that tells the reader; re-exported for the scorer's callers.
export { DECISIVE_ENRICHMENT_GAPS };

/** Marks a result withheld for a failed record read, for the audit log. */
export const RECORD_UNREAD = 'RECORD_UNREAD';

/**
 * Withhold an accusation reached while a decisive part of the record could
 * not be read. KEPT and NOT_DETERMINABLE pass through: a favourable reading is
 * shown at Low (the band dial does that), as the asymmetry has it.
 */
export function withholdForUnreadRecord(result: ScoredResult, gaps: readonly EnrichmentGap[] = []): WithholdingOutcome {
  if (result.verdict !== 'BROKE') return { result, withheld: false, reason: '' };
  const decisive = [...new Set(gaps)].filter((g) => DECISIVE_ENRICHMENT_GAPS.includes(g));
  if (!decisive.length) return { result, withheld: false, reason: '' };
  const reason =
    `This reading would say the senator broke the promise, but part of the record the checks depend on ` +
    `could not be read for this answer (${decisive.map((g) => ENRICHMENT_GAP_PHRASE[g]).join('; ')}). ` +
    `Without it we may have judged the wrong version of a bill's text, or let a check that should have ` +
    `applied go unapplied. An accusation is not published on an incomplete check.`;
  return {
    withheld: true,
    reason,
    result: {
      ...result,
      verdict: 'NOT_DETERMINABLE',
      band: null,
      mode: 'not_determinable',
      nd_reason: 'EVALUATION_FAILED',
      receipt: {
        ...result.receipt,
        scoring_flags: [...result.receipt.scoring_flags, RECORD_UNREAD],
        trace: [...(result.receipt.trace ?? []), `Withheld: ${reason}`],
      },
    },
  };
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
  opts: { counterargumentPresent?: boolean; enrichmentGaps?: readonly EnrichmentGap[] } = {},
): WithholdingOutcome {
  // Only accusations. KEPT and NOT_DETERMINABLE pass through untouched.
  if (result.verdict !== 'BROKE') {
    return { result, withheld: false, reason: '' };
  }

  // FIRST, and ahead of the counterargument: an accusation resting ENTIRELY on
  // actions judged against a later version of the bill than the one the
  // senator acted on. A counterargument cannot repair that — the reading was of
  // the wrong text. One breaking action with its text available is enough to
  // carry the reading to the confidence check below; the band dial has already
  // marked the result Low for the rest.
  const breaking = result.evidence.filter((e) => e.direction === 'breaks');
  if (breaking.length && breaking.every((e) => (e.vote_flags ?? []).includes(TEXT_AT_ACTION_UNAVAILABLE))) {
    const reason =
      `This reading would say the senator broke the promise, but every action behind it was judged ` +
      `against a later version of the bill than the one in effect when the senator acted — that ` +
      `version's text is not available. An accusation is not published on the strength of a ` +
      `different version.`;
    return {
      withheld: true,
      reason,
      result: {
        ...result,
        verdict: 'NOT_DETERMINABLE',
        band: null,
        mode: 'not_determinable',
        nd_reason: 'WITHHELD_TEXT_UNAVAILABLE',
        receipt: { ...result.receipt, trace: [...(result.receipt.trace ?? []), `Withheld: ${reason}`] },
      },
    };
  }

  // SECOND, also ahead of the counterargument: an accusation that bills the
  // evaluator never read could overturn. Each unread row is a vote or a
  // sponsorship whose direction is unknown; if every one of them had pointed
  // the other way, would keeping have outweighed breaking? That is the same
  // comparison the scorer uses to pick the dominant side (keeps >= breaks), so
  // "could overturn" means exactly "could have changed what we publish". If
  // so, the accusation is not published. A favourable reading is not withheld
  // on the same grounds — it shows at Low, as contract 3's asymmetry has it.
  const unread = result.evidence.filter((e) => (e.vote_flags ?? []).includes(EFFECT_UNREAD));
  if (unread.length) {
    const potential = unread.reduce((sum, e) => sum + unreadWeight(e), 0);
    const { keeps, breaks } = result.receipt.weight_split;
    if (keeps + potential >= breaks) {
      const reason =
        `This reading would say the senator broke the promise, but ${unread.length} bill(s) behind a ` +
        `vote or sponsorship could not be read against the statement, and together they carry enough ` +
        `weight to overturn it. An accusation is not published while the evidence that could reverse ` +
        `it is unread.`;
      return {
        withheld: true,
        reason,
        result: {
          ...result,
          verdict: 'NOT_DETERMINABLE',
          band: null,
          mode: 'not_determinable',
          nd_reason: 'EVALUATION_FAILED',
          receipt: { ...result.receipt, trace: [...(result.receipt.trace ?? []), `Withheld: ${reason}`] },
        },
      };
    }
  }

  // THIRD, also ahead of the counterargument: a read of the record the checks
  // depend on failed. Every check that needed it ran without it and failed
  // open, so the accusation may rest on the wrong text or a skipped gate.
  const unreadRecord = withholdForUnreadRecord(result, opts.enrichmentGaps);
  if (unreadRecord.withheld) return unreadRecord;

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
