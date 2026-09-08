import type { AlignmentOutcome } from '@receipts/shared';
import type { JudgeVerdict } from './judge.js';
import type { JudgeGateHit } from './judgeGates.js';

// ===========================================================================
// DISPOSITIONS — what a judged row becomes.
//
// SOURCE: the live WF13 workflow (92pe8N4vmUdoXlFc, node `Set Disposition`),
// plus handoff v2 §5's disposition table. Ported 2026-09-07.
//
// The stale `13_wf13_workflow_sdk.js` draft is NOT the source: it forced
// NOT_DETERMINABLE on any double-fail, which threw away a correct judge verdict
// on sjres7-119 (the judge said BROKE @ 0.7 with the counterargument attached,
// matching the hand audit exactly, and the workflow overwrote it).
//
// ── ONE DEVIATION FROM §5, DELIBERATE ─────────────────────────────────────
// §5 says JUDGE_ERROR leaves the verdict untouched and keeps Grade = PENDING.
// That is safe in the PIPELINE because WF11 refuses to score PENDING. The query
// tool has no WF11 — "leave it untouched" here would RENDER an unjudged
// accusation to a user. So an infrastructure failure WITHHOLDS: the accusation
// is replaced with NOT_DETERMINABLE for display, the original is preserved for
// the audit row, and the grade stays PENDING so it can be judged later.
//
// Contract 5 says an infrastructure failure is never a CONTENT verdict. It does
// not say the unreviewed content gets published in the meantime.
// ===========================================================================

export type Disposition =
  | 'PASS'
  | 'PASS_ON_RETRY'
  | 'REVIEW_REQUIRED'
  | 'REVIEW_REQUIRED_JUDGE_CORRECTED'
  | 'JUDGE_ERROR'
  | `GATED_${string}`;

const ACCUSATIONS = new Set(['BROKE', 'INCONSISTENT']);

/** Verdicts the judge is allowed to substitute. Anything else is ignored. */
const VALID_CORRECTIONS = new Set<AlignmentOutcome>([
  'KEPT',
  'BROKE',
  'CONSISTENT',
  'INCONSISTENT',
  'NOT_DETERMINABLE',
  'PROCEDURAL_SWITCH',
  'NOT_APPLICABLE_EXPIRED',
  'NOT_APPLICABLE',
]);

/** A restored accusation is capped here — it survived a FAIL to get back. */
export const CORRECTED_ACCUSATION_CAP = 0.7;
/** A retry's verdict is capped here, whatever confidence it claims. */
export const RETRY_CONFIDENCE_CAP = 0.75;

export interface RowUnderJudgement {
  verdict: AlignmentOutcome;
  confidence: number | null;
  reasoning: string;
}

export interface DispositionResult {
  disposition: Disposition;
  /** What the user sees. */
  verdict: AlignmentOutcome;
  confidence: number | null;
  reasoning: string;
  /** The evaluator's original verdict, preserved for the record. */
  model_verdict: AlignmentOutcome;
  /**
   * True when the row must NOT reach scoring or display as an accusation.
   * PENDING and REVIEW_REQUIRED both mean "no judge has cleared this".
   */
  withheld: boolean;
}

/**
 * A gate caught it before the judge ran.
 *
 * The gate's verdict is authoritative here — it is deterministic and its reason
 * is already written for a reader.
 */
export function gatedDisposition(hit: JudgeGateHit, row: RowUnderJudgement): DispositionResult {
  return {
    disposition: `GATED_${hit.class}`,
    verdict: 'NOT_DETERMINABLE',
    confidence: null,
    reasoning: `${row.reasoning} | GATE (${hit.gate}/${hit.class}): ${hit.detail}`.trim(),
    model_verdict: row.verdict,
    withheld: true,
  };
}

/**
 * Apply a judge verdict to a row.
 *
 * `retried` is false in the query tool (one pass — see config.judge.retryEnabled),
 * so PASS_ON_RETRY does not currently occur. The branch is kept because the
 * retry path is a flag flip away and its absence would be silently wrong.
 */
export function applyJudgeVerdict(
  row: RowUnderJudgement,
  judge: JudgeVerdict,
  opts: { retried?: boolean } = {},
): DispositionResult {
  // ---- Infrastructure failure. Never a content verdict, and never published.
  if (judge.grade === 'ERROR' || judge.failure_class === 'JUDGE_NO_OUTPUT') {
    const isAccusation = ACCUSATIONS.has(String(row.verdict).toUpperCase());
    return {
      disposition: 'JUDGE_ERROR',
      // An accusation nobody reviewed is withheld; a non-accusation is
      // harmless to show and stays as it was.
      verdict: isAccusation ? 'NOT_DETERMINABLE' : row.verdict,
      confidence: isAccusation ? null : row.confidence,
      reasoning: isAccusation
        ? `${row.reasoning} | WITHHELD: the second-opinion review could not run (${judge.critique}). This reading is not published until it has been checked.`.trim()
        : row.reasoning,
      model_verdict: row.verdict,
      withheld: true,
    };
  }

  // ---- Passed.
  if (judge.grade === 'PASS') {
    if (opts.retried) {
      return {
        disposition: 'PASS_ON_RETRY',
        verdict: row.verdict,
        confidence:
          row.confidence === null ? null : Math.min(row.confidence, RETRY_CONFIDENCE_CAP),
        reasoning: row.reasoning,
        model_verdict: row.verdict,
        withheld: false,
      };
    }
    return {
      disposition: 'PASS',
      verdict: row.verdict,
      confidence: row.confidence,
      reasoning: row.reasoning,
      model_verdict: row.verdict,
      withheld: false,
    };
  }

  // ---- Failed. Apply the judge's correction when it offered one.
  //
  // This is the case the stale draft got wrong. When the judge supplies a
  // corrected_verdict, THAT correction is the second opinion this whole layer
  // exists to produce — discarding it in favour of a blanket NOT_DETERMINABLE
  // throws away the answer we paid for.
  const corrected = String(judge.corrected_verdict).toUpperCase() as AlignmentOutcome;
  if (corrected && VALID_CORRECTIONS.has(corrected)) {
    const isAccusation = ACCUSATIONS.has(corrected);
    let confidence = judge.corrected_confidence ?? row.confidence ?? CORRECTED_ACCUSATION_CAP;
    if (isAccusation) confidence = Math.min(confidence, CORRECTED_ACCUSATION_CAP);

    let reasoning =
      `${row.reasoning} | JUDGE CORRECTION (${judge.failure_class}): ${judge.critique}`.trim();
    if (judge.senator_counterargument) {
      reasoning += ` | SENATOR RESPONSE: ${judge.senator_counterargument}`;
    }

    return {
      disposition: 'REVIEW_REQUIRED_JUDGE_CORRECTED',
      verdict: corrected,
      confidence,
      reasoning,
      model_verdict: row.verdict,
      // A corrected accusation is still an accusation a judge FAILED once.
      // It shows, but flagged for review.
      withheld: isAccusation,
    };
  }

  // ---- Failed with no correction offered. Nothing defensible survives.
  return {
    disposition: 'REVIEW_REQUIRED',
    verdict: 'NOT_DETERMINABLE',
    confidence: null,
    reasoning: `${row.reasoning} | REVIEW (no judge correction offered): ${judge.critique}`.trim(),
    model_verdict: row.verdict,
    withheld: true,
  };
}

// ---------------------------------------------------------------------------
// THE RETRY INVARIANT (behavioural contract 4).
//
// SOURCE: WF13's `Parse Re-eval`. Ported verbatim including a detail the prose
// summary loses: the confidence check applies ONLY to accusations. Raising
// confidence on a KEPT is allowed; raising it on a BROKE is not.
//
// > A retry may only move a verdict AWAY from BROKE/INCONSISTENT, or lower
// > confidence. Anything else is discarded and the original is retained.
//
// An adversarial critique must never be able to MANUFACTURE an accusation.
// This is live code with tests even though retry is currently disabled, so
// enabling it is a flag flip rather than a re-port.
// ---------------------------------------------------------------------------

export interface RetryCandidate {
  verdict: AlignmentOutcome;
  confidence: number | null;
}

export interface RetryDecision {
  accepted: boolean;
  /** Why it was discarded, for the audit row. Empty when accepted. */
  note: string;
}

export function checkRetryInvariant(
  original: RetryCandidate,
  retry: RetryCandidate,
): RetryDecision {
  const origIsAccusation = ACCUSATIONS.has(String(original.verdict).toUpperCase());
  const retryIsAccusation = ACCUSATIONS.has(String(retry.verdict).toUpperCase());

  const movedToward = retryIsAccusation && !origIsAccusation;
  const raised =
    retryIsAccusation &&
    retry.confidence !== null &&
    original.confidence !== null &&
    retry.confidence > original.confidence + 1e-9;

  if (movedToward || raised) {
    return {
      accepted: false,
      note:
        `INVARIANT: retry tried ${retry.verdict}@${retry.confidence} from ` +
        `${original.verdict}@${original.confidence}; discarded`,
    };
  }
  return { accepted: true, note: '' };
}
