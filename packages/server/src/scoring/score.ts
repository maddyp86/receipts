import type {
  AlignmentOutcome,
  BillEffect,
  ConfidenceBand,
  Direction,
  DirectedAction,
  EvidenceType,
  FactorReceipt,
  MatchedAction,
  NotDeterminableReason,
  PromiseType,
  RankedEntry,
  ScoredResult,
  StatementType,
  Verdict,
} from '@receipts/shared';
import { toVerdict } from '@receipts/shared';
import {
  EVIDENCE_TYPE_FACTOR,
  HIGH_AVG_STRENGTH,
  MEANINGFUL_MINORITY_SHARE,
  SIMILARITY,
} from './config.js';
import { deriveAlignment, isSponsored, type AlignmentInput } from './deriveAlignment.js';
import { PATTERN_MULTIPLIER, actionTier, votePattern } from './votePattern.js';

// ===========================================================================
// The deterministic scoring service.
//
// Pure. No I/O, no model calls, no clock. Given the same matches it returns the
// same verdict forever, which is the entire basis of the product's claim to be
// auditable rather than a black box.
//
// Structure: gates run first and can short-circuit; dials only set the band for
// a result that already has a direction.
//
//   G0  non-legislative promise with no legislative action  -> NOT_DETERMINABLE
//   G1  determinability: nothing above the evidence floor    -> NOT_DETERMINABLE
//   G2  direction: matches disagree                          -> ranked verdicts
//   dials: count, strength, evidence type                    -> High/Medium/Low
//
// NOT_DETERMINABLE is a distinct outcome, never "low confidence", and it always
// carries a specific reason so the UI can explain *why* rather than shrug.
// ===========================================================================

/** A retrieved match plus the effect judgement the metadata cannot carry. */
export type ScorableMatch = MatchedAction & {
  bill_effect: BillEffect;
  bill_effect_reasoning: string;
  /** Optional whip comparison; only affects tier selection for abstentions. */
  party_alignment?: string;
};

export interface ScoreInput {
  promise_type: PromiseType;
  /**
   * REQUIRED. Picks the verdict vocabulary — see deriveAlignment. Free-typed
   * text has no provenance, so callers must decide rather than inherit.
   */
  statement_type: StatementType;
  /**
   * Whether the promise is specific enough to check against legislative action
   * at all. Defaults to true so existing callers are unaffected, but a `false`
   * here short-circuits before retrieval is ever consulted — see G0.
   */
  is_evaluable?: boolean;
  matches: ScorableMatch[];
}

const mean = (xs: number[]): number =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

const round = (n: number, dp = 4): number => Number.parseFloat(n.toFixed(dp));

/**
 * Classify a match's evidence weight class.
 *
 * A match whose effect could not be determined — or whose metadata was too thin
 * to read an action off — is demoted to `associative`, which cannot carry a
 * verdict on its own.
 */
function evidenceTypeOf(match: ScorableMatch, tier: string, directed: boolean): EvidenceType {
  if (!directed) return 'associative';
  if (tier === 'VOTED') return 'vote';
  if (tier === 'SPONSOR' || tier === 'CO_SPONSOR') return 'sponsorship';
  if (tier === 'PROCEDURAL' || tier === 'ABSTAIN') return 'procedural';
  return 'associative';
}

function directionOf(outcome: AlignmentOutcome): Direction {
  // Routed through toVerdict so both vocabularies collapse the same way — a
  // CONSISTENT reads as 'keeps' exactly as a KEPT does.
  const bucket = toVerdict(outcome);
  if (bucket === 'KEPT') return 'keeps';
  if (bucket === 'BROKE') return 'breaks';
  return 'neutral';
}

/**
 * The dials. Only ever called on a directionally-clean subset.
 *
 * High    ≥2 matches, all hard evidence, average strength at or above the High
 *         bar, unanimous direction (guaranteed by the caller).
 * Medium  one strong hard match, or ≥2 clean matches with mixed strength.
 * Low     a single weak match, or soft evidence only.
 */
function bandFor(subset: DirectedAction[]): { band: ConfidenceBand; why: string } {
  const isHard = (m: DirectedAction) =>
    m.evidence_type === 'vote' || m.evidence_type === 'sponsorship';

  const hardCount = subset.filter(isHard).length;
  const allHard = hardCount === subset.length;
  const avg = mean(subset.map((m) => m.score));

  if (hardCount === 0) {
    return { band: 'Low', why: 'soft evidence only — no recorded vote or sponsorship' };
  }
  if (subset.length >= 2 && allHard && avg >= HIGH_AVG_STRENGTH) {
    return {
      band: 'High',
      why: `${subset.length} hard-evidence matches, all aligned, average strength ${round(avg, 3)} at or above the High bar`,
    };
  }
  if (subset.length === 1) {
    const only = subset[0]!;
    return only.score >= HIGH_AVG_STRENGTH
      ? { band: 'Medium', why: 'a single strong hard-evidence match' }
      : { band: 'Low', why: 'a single match, below the strength bar for a confident read' };
  }
  return {
    band: 'Medium',
    why: `${subset.length} aligned matches with mixed strength or evidence type (average ${round(avg, 3)})`,
  };
}

function emptyReceipt(overrides: Partial<FactorReceipt> = {}): FactorReceipt {
  return {
    match_count: 0,
    directed_count: 0,
    avg_strength: 0,
    strongest_score: 0,
    evidence_mix: { vote: 0, sponsorship: 0, procedural: 0, associative: 0 },
    direction_split: { keeps: 0, breaks: 0, neutral: 0 },
    weight_split: { keeps: 0, breaks: 0 },
    minority_share: 0,
    trace: [],
    scoring_flags: [],
    ...overrides,
  };
}

function notDeterminable(
  reason: NotDeterminableReason,
  receipt: FactorReceipt,
  evidence: DirectedAction[] = [],
): ScoredResult {
  return {
    verdict: 'NOT_DETERMINABLE',
    band: null,
    mode: 'not_determinable',
    nd_reason: reason,
    ranked: [],
    receipt,
    evidence,
  };
}

export function scoreMatches(input: ScoreInput): ScoredResult {
  const trace: string[] = [];
  const flags: string[] = [];

  // ---- G0: is there a checkable commitment at all? ------------------------
  // Runs before anything else. A promise too vague to name a policy, program or
  // outcome cannot be checked against a voting record, and retrieval on a vague
  // promise is worse than useless: the interpretation step still has to pick
  // *some* issue classification, and the keywords that classification injects
  // will happily match bills that have nothing to do with what was asked.
  // Better to say we couldn't tell what to check.
  if (input.is_evaluable === false) {
    trace.push(
      'G0 short-circuit: the promise is not specific enough to check against legislative action. No retrieval was scored.',
    );
    return notDeterminable('NOT_EVALUABLE', emptyReceipt({ trace, scoring_flags: flags }));
  }

  // Defensive: the store should already have dropped sub-WEAK rows, but the
  // scorer owns the floor and must not depend on that.
  const retrieved = input.matches.filter((m) => m.score >= SIMILARITY.WEAK);
  const aboveFloor = retrieved.filter((m) => m.score >= SIMILARITY.STRONG);
  const weakOnly = retrieved.filter(
    (m) => m.score >= SIMILARITY.WEAK && m.score < SIMILARITY.STRONG,
  );

  trace.push(
    `Retrieved ${input.matches.length} candidate actions; ${aboveFloor.length} at or above the evidence floor (${SIMILARITY.STRONG}), ${weakOnly.length} related but below it.`,
  );

  // ---- G1: determinability ------------------------------------------------
  if (aboveFloor.length === 0) {
    const reason: NotDeterminableReason =
      retrieved.length === 0 ? 'NO_MATCHES' : 'ALL_BELOW_FLOOR';
    trace.push(`G1 short-circuit: ${reason}. No band is reached — this is not "low confidence".`);
    return notDeterminable(
      reason,
      emptyReceipt({ match_count: retrieved.length, trace, scoring_flags: flags }),
    );
  }

  // ---- Direct every match above the floor ---------------------------------
  const evidence: DirectedAction[] = aboveFloor.map((m) => {
    const alignmentInput: AlignmentInput = {
      bill_effect: m.bill_effect,
      vote: m.vote,
      cloture_vote: m.cloture_vote,
      passage_vote: m.passage_vote,
      is_sponsor: m.is_sponsor,
      is_cosponsor: m.is_cosponsor,
    };

    const outcome = deriveAlignment(alignmentInput, input.statement_type);
    const pattern = votePattern(m.cloture_vote, m.passage_vote, m.vote);
    const tier =
      outcome === 'PROCEDURAL_SWITCH'
        ? 'PROCEDURAL'
        : actionTier(alignmentInput, m.party_alignment);

    const direction = directionOf(outcome);
    const directed = direction !== 'neutral';
    const evidence_type = evidenceTypeOf(m, tier, directed);

    const rowFlags: string[] = [];
    if (outcome === 'PROCEDURAL_SWITCH') rowFlags.push('PROCEDURAL_SWITCH');
    if (outcome === 'ERROR') rowFlags.push('BILL_EFFECT_ERROR');
    if (m.missing_fields.length) rowFlags.push(`MISSING_METADATA:${m.missing_fields.join('|')}`);
    if (tier === 'ABSTAIN') rowFlags.push('SILENT_AVOIDANCE');

    return {
      ...m,
      outcome,
      direction,
      evidence_type,
      action_tier: tier,
      vote_pattern: pattern,
      weight: directed ? round(m.score * EVIDENCE_TYPE_FACTOR[evidence_type]) : 0,
      scoring_flags: rowFlags,
    } as DirectedAction;
  });

  for (const e of evidence) flags.push(...e.scoring_flags);

  const keeps = evidence.filter((e) => e.direction === 'keeps');
  const breaks = evidence.filter((e) => e.direction === 'breaks');
  const directed = [...keeps, ...breaks];

  const keepWeight = round(keeps.reduce((a, e) => a + e.weight, 0));
  const breakWeight = round(breaks.reduce((a, e) => a + e.weight, 0));
  const totalWeight = keepWeight + breakWeight;
  const minorityShare =
    totalWeight > 0 ? round(Math.min(keepWeight, breakWeight) / totalWeight, 3) : 0;

  const receipt: FactorReceipt = {
    match_count: aboveFloor.length,
    directed_count: directed.length,
    avg_strength: round(mean(directed.map((e) => e.score)), 3),
    strongest_score: round(Math.max(0, ...evidence.map((e) => e.score)), 3),
    evidence_mix: evidence.reduce(
      (acc, e) => {
        acc[e.evidence_type] += 1;
        return acc;
      },
      { vote: 0, sponsorship: 0, procedural: 0, associative: 0 } as Record<EvidenceType, number>,
    ),
    direction_split: {
      keeps: keeps.length,
      breaks: breaks.length,
      neutral: evidence.length - directed.length,
    },
    weight_split: { keeps: keepWeight, breaks: breakWeight },
    minority_share: minorityShare,
    trace,
    scoring_flags: [...new Set(flags)],
  };

  // ---- G1b: nothing could be directed -------------------------------------
  if (directed.length === 0) {
    const allProcedural =
      evidence.length > 0 && evidence.every((e) => e.outcome === 'PROCEDURAL_SWITCH');
    const anyMissing = evidence.some((e) => e.missing_fields.length > 0);
    const anyAction = evidence.some((e) =>
      isSponsored({ is_sponsor: e.is_sponsor, is_cosponsor: e.is_cosponsor, bill_effect: e.bill_effect }) ||
      e.action_tier === 'VOTED' ||
      e.action_tier === 'ABSTAIN',
    );

    let reason: NotDeterminableReason;
    if (allProcedural) reason = 'PROCEDURAL_SWITCH';
    else if (input.promise_type === 'non_legislative' && !anyAction) reason = 'NON_LEGISLATIVE';
    else if (anyMissing) reason = 'UNDIRECTABLE_METADATA';
    else if (!anyAction) reason = 'NO_ACTION';
    else reason = 'ALL_NEUTRAL';

    trace.push(
      `G1b short-circuit: ${aboveFloor.length} related actions, but none could be directed (${reason}).`,
    );
    return notDeterminable(reason, { ...receipt, trace }, evidence);
  }

  trace.push(
    `G1 passed: ${directed.length} of ${aboveFloor.length} actions carry a direction (${keeps.length} toward keeping, ${breaks.length} toward breaking).`,
  );

  // ---- G2: direction gate -------------------------------------------------
  const conflict = keeps.length > 0 && breaks.length > 0;

  if (conflict) {
    const dominantIsKeep = keepWeight >= breakWeight;
    const dominantSet = dominantIsKeep ? keeps : breaks;
    const dissentSet = dominantIsKeep ? breaks : keeps;

    const dominantBand = bandFor(dominantSet);
    // Never claim High on a contested record.
    const cappedBand: ConfidenceBand = dominantBand.band === 'High' ? 'Medium' : dominantBand.band;

    trace.push(
      `G2 conflict: evidence points both ways (weight ${keepWeight} keeping vs ${breakWeight} breaking; minority share ${minorityShare}).`,
    );
    trace.push(
      minorityShare >= MEANINGFUL_MINORITY_SHARE
        ? 'Dissenting evidence is substantial, not incidental.'
        : 'Dissenting evidence is present but a small share of the total.',
    );
    trace.push(
      `Ranked mode: dominant verdict from its own subset (${dominantBand.why}); High capped to Medium because the record is contested.`,
    );

    const ranked: RankedEntry[] = [
      {
        verdict: dominantIsKeep ? 'KEPT' : 'BROKE',
        band: cappedBand,
        weight: dominantIsKeep ? keepWeight : breakWeight,
        evidence_uids: dominantSet.map((e) => e.action_uid),
      },
      {
        verdict: dominantIsKeep ? 'BROKE' : 'KEPT',
        band: bandFor(dissentSet).band,
        weight: dominantIsKeep ? breakWeight : keepWeight,
        evidence_uids: dissentSet.map((e) => e.action_uid),
      },
    ];

    return {
      verdict: ranked[0]!.verdict,
      band: cappedBand,
      mode: 'ranked',
      nd_reason: null,
      ranked,
      receipt: { ...receipt, trace },
      evidence,
    };
  }

  // ---- Clean direction: dials set the band --------------------------------
  const verdict: Verdict = keeps.length > 0 ? 'KEPT' : 'BROKE';
  const { band, why } = bandFor(directed);
  trace.push(`G2 passed: direction is unanimous (${verdict}).`);
  trace.push(`Band ${band} — ${why}.`);

  return {
    verdict,
    band,
    mode: 'single',
    nd_reason: null,
    ranked: [],
    receipt: { ...receipt, trace },
    evidence,
  };
}

export { PATTERN_MULTIPLIER };
