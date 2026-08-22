import type { AlignmentOutcome, BillEffect } from '@receipts/shared';
import { castVotesOf, effectiveVote, isCosponsor, isSponsor } from './deriveAlignment.js';

// ===========================================================================
// The effort signal.
//
// The pipeline answers "did the outcome happen?". Users mostly ask "is this
// senator working on it?" Those come apart, and they come apart worst on
// exactly the cases the scorer freezes or discounts:
//
//   sponsored + NAY (Rule XIII)   frozen, no score   | authored it, kept it alive
//   no action at all              frozen, no score   | genuinely nothing on record
//
// Both produce no score. They are not the same thing, and an app that renders
// them identically is misinforming the user.
//
// ── Why this lives in the app and not the pipeline ────────────────────────
// Every input is already on the row, so it is a pure function. Keeping it out
// of the pipeline is a structural guarantee, not a preference: the sponsorship
// double-count happened because an effort signal got folded into a score. A
// layer that cannot write back to the trust index cannot repeat that.
//
// Effort is never averaged into a score and never presented as fulfilment.
// "Working toward" is not "delivered."
// ===========================================================================

export type EffortSignal =
  | 'PRESERVED_FOR_RECONSIDERATION'
  | 'AUTHORED'
  | 'CO_SIGNED'
  | 'BLOCKED_OPPOSITION'
  | 'VOTED_TO_ADVANCE'
  | 'VOTED_AGAINST'
  | 'NO_ACTION';

export interface EffortInput {
  alignment: AlignmentOutcome;
  bill_effect: BillEffect | string;
  vote?: string | null;
  cloture_vote?: string | null;
  passage_vote?: string | null;
  is_sponsor?: boolean | string | null;
  is_cosponsor?: boolean | string | null;
}

/**
 * Signals are ADDITIVE. A senator can be AUTHORED and VOTED_TO_ADVANCE and
 * BLOCKED_OPPOSITION across different bills on one question — that combination
 * is the strongest "working on it" evidence the data supports, and it is
 * completely invisible in a single averaged score.
 */
export function effortSignals(input: EffortInput): EffortSignal[] {
  const signals: EffortSignal[] = [];

  const sponsored = isSponsor(input);
  const cosponsored = isCosponsor(input);
  const votes = castVotesOf(input);
  const effective = effectiveVote(input);
  const effect = String(input.bill_effect ?? '').toUpperCase();

  // The Rule XIII case. Detected structurally (sponsored + any NAY) and
  // reported as a pattern, never as an intention — see `PROCEDURAL_SWITCH_NOTE`.
  if (String(input.alignment).toUpperCase() === 'PROCEDURAL_SWITCH') {
    signals.push('PRESERVED_FOR_RECONSIDERATION');
  }

  if (sponsored) signals.push('AUTHORED');
  if (cosponsored) signals.push('CO_SIGNED');

  // The strongest positive signal in the corpus, and the easiest to
  // under-report because to a casual reader it just looks like a NAY.
  if (effect === 'HINDER' && effective === 'NAY') signals.push('BLOCKED_OPPOSITION');
  if (effect === 'ADVANCE' && effective === 'YEA') signals.push('VOTED_TO_ADVANCE');

  // The action worked against the goal in the query.
  if (
    (effect === 'ADVANCE' && effective === 'NAY') ||
    (effect === 'HINDER' && effective === 'YEA')
  ) {
    signals.push('VOTED_AGAINST');
  }

  if (!votes.length && !sponsored && !cosponsored) signals.push('NO_ACTION');

  return signals;
}

/**
 * Voter-facing group headings.
 *
 * `BLOCKED_OPPOSITION` is labelled by EFFECT, never by vote direction — "voted
 * to block a bill that would have cut benefits", not "voted NAY on S.1234". The
 * raw vote belongs in the detail, and it must still be shown there: never
 * invert a displayed vote to make it read positive.
 */
export const EFFORT_LABEL: Record<EffortSignal, string> = {
  PRESERVED_FOR_RECONSIDERATION: 'Preserved for reconsideration',
  AUTHORED: 'Authored',
  CO_SIGNED: 'Co-signed',
  BLOCKED_OPPOSITION: 'Blocked opposition',
  VOTED_TO_ADVANCE: 'Voted to advance',
  VOTED_AGAINST: 'Voted against',
  NO_ACTION: 'No clear signal',
};

export const EFFORT_EXPLAINER: Record<EffortSignal, string> = {
  PRESERVED_FOR_RECONSIDERATION:
    'Sponsored the bill and then voted against it. This pattern is typically a procedural maneuver to preserve the ability to bring the bill back, and it is not scored in either direction.',
  AUTHORED: 'Put their name on the bill as its sponsor.',
  CO_SIGNED:
    'Co-sponsored the bill. A real legislative act, weighted lower than a recorded vote because it carries no public roll-call commitment.',
  BLOCKED_OPPOSITION:
    'Voted to stop a bill that would have worked against this goal. On a bill that cuts against a position, a vote to block it is a vote consistent with that position.',
  VOTED_TO_ADVANCE: 'Voted to move a bill forward that advances this goal.',
  VOTED_AGAINST: 'Voted in the direction that works against this goal.',
  NO_ACTION: 'No recorded vote and no sponsorship on this bill.',
};

/**
 * Ordering for display. Evidence of action leads; absence of it comes last.
 * Chronological ordering scatters the strongest evidence among procedural noise.
 */
export const EFFORT_DISPLAY_ORDER: EffortSignal[] = [
  'BLOCKED_OPPOSITION',
  'VOTED_TO_ADVANCE',
  'AUTHORED',
  'CO_SIGNED',
  'PRESERVED_FOR_RECONSIDERATION',
  'VOTED_AGAINST',
  'NO_ACTION',
];

/**
 * The one sentence allowed about a procedural switch.
 *
 * Detection is structural — sponsored plus a NAY — and that pattern is equally
 * consistent with a sponsor who turned against an amended text. The record
 * cannot separate the two, so the language stops at the pattern. Asserting that
 * a named senator was "working to advance" the bill is the claim most likely to
 * be challenged and the one least supported by the evidence.
 */
export const PROCEDURAL_SWITCH_NOTE =
  'This pattern is typically a procedural maneuver rather than opposition. It is not scored in either direction.';
