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
//
// ── 2026-10-03: AUTHORED and CO_SIGNED split by sponsorship tier ──────────
// WF2c's `Sponsor Tier` (brief 3) separates a sponsor whose bill moved past
// referral from one whose bill did not, and an original co-sponsor from a
// late one. The tier describes the RECORD: SPONSOR_ADVANCED says the bill
// reached a hearing, markup, report or further, never that the sponsor moved
// it there. So the labels below name what happened to the bill and when the
// name went on, and none of them names the tier or implies who did the work.
// Absent or contradictory tier data falls back to the unsplit signal — the
// record is unknown, and unknown is not a lower tier.
// ===========================================================================

export type EffortSignal =
  | 'PRESERVED_FOR_RECONSIDERATION'
  | 'AUTHORED'
  | 'AUTHORED_ADVANCED'
  | 'AUTHORED_STALLED'
  | 'CO_SIGNED'
  | 'CO_SIGNED_ORIGINAL'
  | 'CO_SIGNED_LATE'
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
  /**
   * WF2c `Sponsor Tier`. Changes the label, never which signals fire and never
   * anything numeric. Read only when it agrees with the sponsor flags.
   */
  sponsor_tier?: string | null;
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

  const tier = String(input.sponsor_tier ?? '').toUpperCase();
  // The flags decide WHETHER a sponsorship signal fires, exactly as before; the
  // tier only chooses which of its forms. A tier that contradicts the flag (a
  // sponsor row tiered as a co-sponsor) is ignored rather than trusted.
  if (sponsored) {
    signals.push(
      tier === 'SPONSOR_ADVANCED' ? 'AUTHORED_ADVANCED' : tier === 'SPONSOR_STALLED' ? 'AUTHORED_STALLED' : 'AUTHORED',
    );
  }
  if (cosponsored) {
    signals.push(
      tier === 'ORIGINAL_COSPONSOR' ? 'CO_SIGNED_ORIGINAL' : tier === 'LATE_COSPONSOR' ? 'CO_SIGNED_LATE' : 'CO_SIGNED',
    );
  }

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
  AUTHORED_ADVANCED: 'Authored — the bill moved past referral',
  AUTHORED_STALLED: 'Authored — no committee action after referral',
  CO_SIGNED: 'Co-signed',
  CO_SIGNED_ORIGINAL: 'Co-signed at introduction',
  CO_SIGNED_LATE: 'Co-signed after introduction',
  BLOCKED_OPPOSITION: 'Blocked opposition',
  VOTED_TO_ADVANCE: 'Voted to advance',
  VOTED_AGAINST: 'Voted against',
  NO_ACTION: 'No clear signal',
};

export const EFFORT_EXPLAINER: Record<EffortSignal, string> = {
  PRESERVED_FOR_RECONSIDERATION:
    'Sponsored the bill and then voted against it. This pattern is typically a procedural maneuver to preserve the ability to bring the bill back, and it is not scored in either direction.',
  AUTHORED: 'Put their name on the bill as its sponsor.',
  // "Moved past referral", not "advanced it": the record shows the bill got a
  // hearing, markup or report, and does not show who brought that about.
  AUTHORED_ADVANCED:
    'Sponsored the bill, and the record shows it moved past referral to committee — a hearing, a markup, a committee report, or further. It does not show who moved it.',
  AUTHORED_STALLED:
    'Sponsored the bill. The record shows no committee action after it was referred.',
  // The previous wording said a co-sponsorship is "weighted lower than a
  // recorded vote". It is not: EVIDENCE_TYPE_FACTOR weights both at 1.0.
  CO_SIGNED: 'Co-sponsored the bill. A real legislative act, though it carries no recorded roll-call vote.',
  CO_SIGNED_ORIGINAL:
    'An original co-sponsor: their name was on the bill when it was introduced.',
  CO_SIGNED_LATE:
    'Joined the bill as a co-sponsor after it was introduced.',
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
  'AUTHORED_ADVANCED',
  'AUTHORED_STALLED',
  'CO_SIGNED',
  'CO_SIGNED_ORIGINAL',
  'CO_SIGNED_LATE',
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
