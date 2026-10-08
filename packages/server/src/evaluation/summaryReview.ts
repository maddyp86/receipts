import type { BillStatement } from './enrichment.js';
import type { TextVersionSelection } from './textVersions.js';

// ===========================================================================
// A BILL WHOSE SUMMARY IS UNDER REVIEW IS SET ASIDE, NOT WEIGHED.
//
// 2026-10-07: the bill-level impact statements for sjres103-119, sjres112-119
// and sjres80-119 were found wrong or misleading on direction. The evaluator
// decides direction from that summary, so a verdict resting on one — KEPT or
// BROKE alike — rests on a reading that may be backwards. Until the statement
// is regenerated, the action is set aside before evaluation and listed under
// "Found, but not evaluated" with this reason.
//
// DRIVEN BY DATA, not bill ids: the `Flagged For Review` column on the
// bill-level Impact Statements sheet (mirror.mirror_impact_statements). Clear
// the flag and the bill is weighed again on the next sync, with no deploy.
// Blank is not flagged — rows the pipeline adds later may leave it empty.
//
// Only when the bill-level summary is what the evaluator would read: if a
// usable text version applies, the evaluator reads that version instead, and
// the bill-level statement is not in play.
//
// Not a port of an n8n gate, so it does not live in preEvaluatorGates.ts.
// ===========================================================================

/** The gate id, for the trace and the audit log. Never shown to a reader. */
export const SUMMARY_UNDER_REVIEW_GATE = 'SUMMARY_UNDER_REVIEW';

/** Shown verbatim on the "Found, but not evaluated" card. Claims nothing about the senator. */
export const SUMMARY_UNDER_REVIEW_REASON =
  "Our summary of this bill is under review, so we didn't weigh it either way. The bill itself is linked below.";

/** True when the action must be set aside: flagged bill-level summary, and no usable text version in its place. */
export function summaryUnderReview(
  statement: BillStatement | null | undefined,
  selection: TextVersionSelection | null | undefined,
): boolean {
  return Boolean(statement?.flagged_for_review) && !selection?.version;
}
