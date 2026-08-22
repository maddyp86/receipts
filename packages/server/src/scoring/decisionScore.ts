import type {
  ActionTier,
  AlignmentOutcome,
  StatementType,
  VotePattern,
} from '@receipts/shared';
import { PATTERN_MULTIPLIER } from './votePattern.js';

// ===========================================================================
// PORT of WF11 `Compute Decision Score` (toxQrXxgx8QNvXoc).
// Reconciled against the live node on 2026-08-19; node last updated
// 2026-08-19T23:39 (version 8ce52983) — the policy-position scoring split.
//
// Ported rather than forked, deliberately. Two copies of this scorer means the
// query tool and the trust report can print different numbers for the same
// senator on the same bill — the one inconsistency a fact-checking product
// cannot survive. This file is a transcription; if the node changes, this
// changes with it, and the test suite is the contract between them.
//
// Everything here is a pure function. No I/O, no clock, no model call.
// ===========================================================================

// ---- WEIGHTS — every tunable number lives here, as upstream --------------

/** Recorded floor vote exists. Party dimension only meaningful here. */
const BASE_VOTED = {
  KEPT: {
    CROSS_PARTY: { OPPOSED: 1.3, NO_DATA: 1.1, ALIGNED: 1.0 },
    WITH_PARTY: { OPPOSED: 1.0, NO_DATA: 0.9, ALIGNED: 0.8 },
  },
  BROKE: {
    CROSS_PARTY: { ALIGNED: -1.5, OPPOSED: -1.2, NO_DATA: -1.1 },
    WITH_PARTY: { ALIGNED: -1.4, OPPOSED: -1.1, NO_DATA: -1.0 },
  },
} as const;

/**
 * Sponsorship without a floor vote.
 *
 * Cut sharply from the old NOT_VOTED band (0.6–0.8) because 82% of STRONG
 * evidence in the corpus is co-sponsorship and 87% of matched bills are dead —
 * the index was mostly measuring the cheapest available signal. The asymmetry
 * is intentional: sponsorship is self-selected, so it is cheap credit and
 * expensive blame.
 *
 * ⚠ These six numbers are proposals awaiting sign-off (method spec §7).
 */
const BASE_SPONSOR = {
  KEPT: { OPPOSED: 0.5, NO_DATA: 0.45, ALIGNED: 0.35 },
  BROKE: { ALIGNED: -1.2, OPPOSED: -0.9, NO_DATA: -1.0 },
} as const;

const BASE_COSPONSOR = {
  KEPT: { OPPOSED: 0.35, NO_DATA: 0.3, ALIGNED: 0.2 },
  BROKE: { ALIGNED: -1.1, OPPOSED: -0.85, NO_DATA: -0.95 },
} as const;

/** Recorded "Not Voting" on a roll call — Silent Avoidance. */
const BASE_ABSTAIN = { KEPT: -0.3, BROKE: -0.5 } as const;

// ---- POLICY POSITION BASE TABLES (v1 — UNSIGNED) -------------------------
//
// Campaign promises and policy positions are DIFFERENT commitments and feed
// SEPARATE indices — Trust (KEPT/BROKE on promises) and Consistency
// (CONSISTENT/INCONSISTENT on positions). They are never blended into one
// headline. To keep a single rule tree, position verdicts are normalised to
// KEPT/BROKE for CONTROL FLOW ONLY; the base lookup then re-splits on
// statement type so the magnitudes differ.
//
// Seeding rationale, transcribed from the node (v1 — revise after feedback,
// do NOT treat as signed off):
//   Positive side ~0.85× the promise band. Acting consistently with a stated
//   position is intentional but less binding than keeping a promise made to
//   constituents in exchange for a vote.
//   Negative side compressed further toward zero than a flat 0.85×. Breaking a
//   promise is a betrayal; contradicting a stated position is an
//   inconsistency. A single multiplier cannot express "lower upside AND softer
//   downside" — that asymmetry is why these are separate tables rather than a
//   scaled copy.
const BASE_VOTED_POSITION = {
  KEPT: {
    // = CONSISTENT
    CROSS_PARTY: { OPPOSED: 1.1, NO_DATA: 0.95, ALIGNED: 0.85 },
    WITH_PARTY: { OPPOSED: 0.85, NO_DATA: 0.75, ALIGNED: 0.7 },
  },
  BROKE: {
    // = INCONSISTENT
    CROSS_PARTY: { ALIGNED: -1.0, OPPOSED: -0.8, NO_DATA: -0.75 },
    WITH_PARTY: { ALIGNED: -0.9, OPPOSED: -0.75, NO_DATA: -0.7 },
  },
} as const;

const BASE_SPONSOR_POSITION = {
  KEPT: { OPPOSED: 0.42, NO_DATA: 0.38, ALIGNED: 0.3 },
  BROKE: { ALIGNED: -0.8, OPPOSED: -0.6, NO_DATA: -0.68 },
} as const;

const BASE_COSPONSOR_POSITION = {
  KEPT: { OPPOSED: 0.3, NO_DATA: 0.25, ALIGNED: 0.17 },
  BROKE: { ALIGNED: -0.72, OPPOSED: -0.56, NO_DATA: -0.62 },
} as const;

const BASE_ABSTAIN_POSITION = { KEPT: -0.25, BROKE: -0.35 } as const;

const MOD = {
  PLATFORM_KEPT_ALIGNS: 0.05,
  PLATFORM_KEPT_CONTRADICTS: 0.1,
  PLATFORM_BROKE_ALIGNS: -0.05,
  PLATFORM_BROKE_CONTRADICTS: -0.1,
  CONFIDENCE_HIGH: 0.05,
  EFFORT_SPONSOR: 0.1,
  EFFORT_COSPONSOR: 0.05,
  EFFORT_SPONSOR_BROKE: -0.1,
  EFFORT_COSPONSOR_BROKE: -0.05,
  DONOR_PRESSURE_OPPOSED: 0.05,
  DONOR_PRESSURE_ALIGNED: -0.1,
  SYMBOLIC_OPPOSITION: -0.15,
  SPECIFICITY_EVIDENCE: 0.85,
} as const;

const DONOR_OPPOSED_THRESHOLD = 5;
const DONOR_ALIGNED_THRESHOLD = 10;
const CONFIDENCE_HIGH_FLOOR = 0.9;
const CONFIDENCE_LOW_CEILING = 0.7;
const LOW_CONFIDENCE_MULT = 0.8;
const CLAMP_MIN = -2.0;
const CLAMP_MAX = 1.5;

// ---- TYPES ---------------------------------------------------------------

export type DonorAlignment = 'ALIGNED' | 'OPPOSED' | 'NO_DATA';

/**
 * Which index a scored row feeds. Promises and positions are kept separable so
 * the two headline numbers can never be blended into one.
 */
export type IndexBucket = 'TRUST' | 'CONSISTENCY';
export type PartyAlignment = 'WITH_PARTY' | 'CROSS_PARTY' | 'NOT_VOTED' | 'PROCEDURAL' | 'NA';
export type PlatformAlignment = 'ALIGNS' | 'CONTRADICTS' | 'NO_DATA';

export interface AppliedModifier {
  modifier: string;
  /** Additive modifiers are numbers; multipliers are rendered as "×0.85". */
  adjustment: number | string;
}

export interface DecisionScoreInput {
  alignment: AlignmentOutcome;
  /**
   * REQUIRED — deliberately not defaulted, unlike the node.
   *
   * WF11 defaults an unlabelled row to 'Campaign Promise' so a blank never
   * down-weights a pipeline row whose sheet column is reliably populated. Here
   * the input is arbitrary user text: dispatch defaults free-typed queries to
   * 'Policy Position', so a silent 'Campaign Promise' default would score on
   * the promise scale AND file the row under TRUST — the exact blending of the
   * two indices this split exists to prevent. Same guard, same reason, as
   * `deriveAlignment`'s required statementType.
   */
  statement_type: StatementType;
  action_tier: ActionTier;
  vote_pattern: VotePattern;
  party_alignment?: PartyAlignment | string;
  donor_alignment?: DonorAlignment | string;
  donor_pro_count?: number;
  platform_alignment?: PlatformAlignment | string;
  /** The fulfillment evaluator's confidence in its own reading. */
  alignment_confidence?: number | null;
  is_sponsor?: boolean;
  is_cosponsor?: boolean;
  /** 'SPECIFICITY' triggers the ×0.85 evidence discount. */
  partial_subtype?: string;
}

export interface DecisionScoreResult {
  outcome_label: string;
  statement_type: StatementType;
  /** TRUST for promises, CONSISTENCY for positions. Never mix the two means. */
  index_bucket: IndexBucket;
  action_tier: ActionTier;
  vote_pattern: VotePattern;
  pattern_multiplier: number;
  specificity_multiplier: number;
  base_score: number | null;
  modifiers_applied: AppliedModifier[];
  total_modifier: number;
  /**
   * NULL for frozen rows, never 0.0.
   *
   * This is the entire point of the contract. A zero enters the mean and says
   * "this decision was worth nothing"; null is excluded from the denominator
   * and says "we cannot tell". Roughly 16% of rows are frozen, so conflating
   * the two would drag every average toward zero for reasons that have nothing
   * to do with the senator.
   */
  decision_score: number | null;
  scorable: boolean;
  scoring_flags: string[];
}

// ---- HELPERS -------------------------------------------------------------

const U = (v: unknown): string =>
  v === null || v === undefined ? '' : String(v).trim().toUpperCase();

const round = (n: number, dp = 4): number => Number.parseFloat(n.toFixed(dp));

/** Promises feed the Trust index; positions feed Consistency. Never blended. */
const bucketOf = (t: StatementType): IndexBucket =>
  t === 'Policy Position' ? 'CONSISTENCY' : 'TRUST';

function normaliseDonor(raw: unknown): DonorAlignment {
  const d = U(raw);
  // NEUTRAL carries no directional signal — collapse it rather than inventing
  // a fourth column in the base table.
  if (d === 'ALIGNED' || d === 'OPPOSED') return d;
  return 'NO_DATA';
}

function frozen(
  input: DecisionScoreInput,
  label: string,
  flags: string[],
): DecisionScoreResult {
  return {
    outcome_label: label,
    // Carried on EVERY frozen row, including VERDICT_WITHOUT_ACTION. The live
    // node omits both fields on that one branch (see RECONCILIATION 2026-08-19)
    // — an oversight, not a decision: downstream defaults them to
    // 'Campaign Promise'/'TRUST', which misfiles a frozen position row into the
    // trust index. Reported upstream; not replicated here.
    statement_type: input.statement_type,
    index_bucket: bucketOf(input.statement_type),
    action_tier: input.action_tier,
    vote_pattern: input.vote_pattern,
    pattern_multiplier: 1.0,
    specificity_multiplier: 1.0,
    base_score: null,
    modifiers_applied: [],
    total_modifier: 0,
    decision_score: null,
    scorable: false,
    scoring_flags: flags,
  };
}

// ---- MAIN ----------------------------------------------------------------

export function computeDecisionScore(input: DecisionScoreInput): DecisionScoreResult {
  const flags: string[] = [];
  const modifiers: AppliedModifier[] = [];

  // Statement type selects both the index this row feeds and the base table
  // that scores it.
  const isPosition = input.statement_type === 'Policy Position';

  // Normalise position verdicts to the promise vocabulary for CONTROL FLOW
  // ONLY — CONSISTENT behaves like KEPT, INCONSISTENT like BROKE. The base
  // lookup re-splits on `isPosition` so the magnitudes differ. Without this,
  // every position froze at the KEPT/BROKE guard below and never entered the
  // Consistency index at all (measured upstream: 15 of 25 on the first WF11
  // chunk). This matters more here than in the pipeline: dispatch defaults
  // free-typed queries to 'Policy Position', so the freeze would have hit
  // essentially every query the tool answers.
  const rawAlignment = U(input.alignment);
  const alignment =
    rawAlignment === 'CONSISTENT' ? 'KEPT' : rawAlignment === 'INCONSISTENT' ? 'BROKE' : rawAlignment;
  const donor = normaliseDonor(input.donor_alignment);
  const platform = U(input.platform_alignment);
  const confidence =
    typeof input.alignment_confidence === 'number' && Number.isFinite(input.alignment_confidence)
      ? input.alignment_confidence
      : null;
  const donorPro = Number.isFinite(Number(input.donor_pro_count))
    ? Number(input.donor_pro_count)
    : 0;

  // ---- FREEZE: anything that is not a directional verdict ----------------
  if (alignment !== 'KEPT' && alignment !== 'BROKE') {
    const procedural = alignment === 'PROCEDURAL_SWITCH';
    return frozen(
      input,
      procedural ? 'Procedural Switch — Not Scored' : 'Indeterminate Match',
      procedural ? ['PROCEDURAL_SWITCH'] : alignment ? [] : ['MISSING_ALIGNMENT'],
    );
  }

  const verdict = alignment as 'KEPT' | 'BROKE';
  const tier = input.action_tier;
  let base: number;
  let label: string;

  const donorSuffix =
    donor === 'ALIGNED'
      ? ', Donor-Aligned'
      : donor === 'OPPOSED'
        ? ', Against Donor Interests'
        : '';

  if (tier === 'VOTED') {
    let party = U(input.party_alignment);

    if (party === 'PROCEDURAL') {
      // The party-alignment node now returns PROCEDURAL for sponsored-then-NAY.
      // Such rows normally freeze above as PROCEDURAL_SWITCH, so arriving here
      // means the two detections disagreed. Fall back rather than letting it
      // masquerade as missing whip data — and flag it distinctly so the drift
      // is visible instead of averaged away.
      party = 'WITH_PARTY';
      flags.push('PARTY_PROCEDURAL_SWITCH');
    } else if (party !== 'WITH_PARTY' && party !== 'CROSS_PARTY') {
      // The party dimension only exists when the whip position is known.
      party = 'WITH_PARTY';
      flags.push('PARTY_WHIP_DATA_MISSING');
    }

    base = (isPosition ? BASE_VOTED_POSITION : BASE_VOTED)[verdict][
      party as 'WITH_PARTY' | 'CROSS_PARTY'
    ][donor];
    label =
      (verdict === 'KEPT' ? 'Upheld' : 'Diverged') +
      (party === 'CROSS_PARTY' ? ', Crossed Party' : ', With Party') +
      donorSuffix;
  } else if (tier === 'ABSTAIN') {
    base = (isPosition ? BASE_ABSTAIN_POSITION : BASE_ABSTAIN)[verdict];
    label = 'Silent Avoidance';
  } else if (tier === 'SPONSOR') {
    base = (isPosition ? BASE_SPONSOR_POSITION : BASE_SPONSOR)[verdict][donor];
    label =
      (verdict === 'KEPT' ? 'Upheld via Sponsorship' : 'Diverged via Sponsorship') + donorSuffix;
  } else if (tier === 'CO_SPONSOR') {
    base = (isPosition ? BASE_COSPONSOR_POSITION : BASE_COSPONSOR)[verdict][donor];
    label =
      (verdict === 'KEPT' ? 'Upheld via Co-Sponsorship' : 'Diverged via Co-Sponsorship') +
      donorSuffix;
  } else {
    // A verdict with no action behind it. deriveAlignment returns
    // NOT_DETERMINABLE in this case, so reaching here means the two disagree.
    return frozen(input, 'Indeterminate Match', ['VERDICT_WITHOUT_ACTION']);
  }

  // ---- ADDITIVE MODIFIERS ------------------------------------------------

  if (platform === 'ALIGNS') {
    modifiers.push({
      modifier: `Platform Aligns + ${verdict === 'KEPT' ? 'Kept' : 'Broken'} Promise`,
      adjustment: verdict === 'KEPT' ? MOD.PLATFORM_KEPT_ALIGNS : MOD.PLATFORM_BROKE_ALIGNS,
    });
  } else if (platform === 'CONTRADICTS') {
    modifiers.push({
      modifier: `Platform Contradicts + ${verdict === 'KEPT' ? 'Kept' : 'Broken'} Promise`,
      adjustment:
        verdict === 'KEPT' ? MOD.PLATFORM_KEPT_CONTRADICTS : MOD.PLATFORM_BROKE_CONTRADICTS,
    });
  }

  if (confidence !== null && confidence >= CONFIDENCE_HIGH_FLOOR) {
    modifiers.push({ modifier: 'Alignment Confidence >= 0.9', adjustment: MOD.CONFIDENCE_HIGH });
  }

  // Legislative effort is scoped to the VOTED tier only: on the sponsorship
  // tiers the base row already IS the sponsorship, so applying it there counts
  // the same fact twice. Signed both directions — authoring a bill and then
  // voting it through against your own stated position is deliberate rather
  // than reactive.
  if (tier === 'VOTED' && (input.is_sponsor || input.is_cosponsor)) {
    const kept = verdict === 'KEPT';
    const sponsor = Boolean(input.is_sponsor);
    const adjustment = sponsor
      ? kept
        ? MOD.EFFORT_SPONSOR
        : MOD.EFFORT_SPONSOR_BROKE
      : kept
        ? MOD.EFFORT_COSPONSOR
        : MOD.EFFORT_COSPONSOR_BROKE;
    const verb = sponsor ? 'sponsored' : 'co-sponsored';
    modifiers.push({
      modifier: kept
        ? `Legislative Effort (${verb} + recorded vote)`
        : `Self-Authored Contradiction (${verb} + recorded vote)`,
      adjustment,
    });
    if (!kept) label += ' — Self-Authored';
  }

  if (donor === 'OPPOSED' && donorPro >= DONOR_OPPOSED_THRESHOLD) {
    modifiers.push({
      modifier: `Donor Pressure Resisted (pro count ${donorPro})`,
      adjustment: MOD.DONOR_PRESSURE_OPPOSED,
    });
  } else if (donor === 'ALIGNED' && donorPro >= DONOR_ALIGNED_THRESHOLD) {
    modifiers.push({
      modifier: `Concentrated Donor Alignment (pro count ${donorPro})`,
      adjustment: MOD.DONOR_PRESSURE_ALIGNED,
    });
  }

  // Supplied the cloture vote that let the bill survive, then voted NAY on
  // passage. Under the any-NAY rule that scores as KEPT — but they enabled the
  // outcome they claim to oppose. Applied to KEPT only; on BROKE the senator is
  // already being penalised and docking twice is the double-count this model
  // exists to avoid.
  if (input.vote_pattern === 'ENABLED_THEN_OPPOSED' && verdict === 'KEPT') {
    modifiers.push({
      modifier: 'Symbolic Opposition (enabled at cloture, opposed at passage)',
      adjustment: MOD.SYMBOLIC_OPPOSITION,
    });
    label += ' — Symbolic Opposition';
  } else if (input.vote_pattern === 'DECISIVE_BLOCK') {
    label += ' — Blocked at Cloture';
  } else if (input.vote_pattern === 'BLOCKED_THEN_JOINED') {
    label += ' — Blocked, Then Joined';
  }

  // ---- ARITHMETIC --------------------------------------------------------

  const totalModifier = round(
    modifiers.reduce((a, m) => a + (typeof m.adjustment === 'number' ? m.adjustment : 0), 0),
  );
  const patternMult = PATTERN_MULTIPLIER[input.vote_pattern] ?? 1.0;

  // A PARTIAL admitted as SPECIFICITY is on the promise's subject but is a
  // broader vehicle than the promise named. Real evidence, weaker evidence —
  // multiplicative so it scales with what is at stake.
  const specificityMult =
    U(input.partial_subtype) === 'SPECIFICITY' ? MOD.SPECIFICITY_EVIDENCE : 1.0;

  let score = (base + totalModifier) * patternMult * specificityMult;

  if (specificityMult !== 1.0) {
    modifiers.push({
      modifier: 'Specificity Evidence (broader vehicle than promise named)',
      adjustment: `×${specificityMult}`,
    });
  }

  // A null confidence counts as low — an unstated confidence is not a high one.
  const lowConfidence = confidence === null || confidence < CONFIDENCE_LOW_CEILING;
  if (lowConfidence) {
    score *= LOW_CONFIDENCE_MULT;
    modifiers.push({ modifier: 'Low Confidence (< 0.7) Multiplier', adjustment: '×0.8' });
  }
  if (patternMult !== 1.0) {
    modifiers.push({
      modifier: `Vote Pattern ${input.vote_pattern}`,
      adjustment: `×${patternMult}`,
    });
  }

  score = Math.max(CLAMP_MIN, Math.min(CLAMP_MAX, round(score)));

  return {
    outcome_label: label,
    statement_type: input.statement_type,
    index_bucket: bucketOf(input.statement_type),
    action_tier: tier,
    vote_pattern: input.vote_pattern,
    pattern_multiplier: patternMult,
    specificity_multiplier: specificityMult,
    base_score: base,
    modifiers_applied: modifiers,
    total_modifier: totalModifier,
    decision_score: score,
    scorable: true,
    scoring_flags: flags,
  };
}

/**
 * Aggregate a set of scored decisions under the null contract.
 *
 * The denominator is the count of SCORABLE rows, not the count of rows. Never
 * present the mean without it — "0.42 across 3 of 11 decisions" is a different
 * claim from "0.42", and only the first one is defensible.
 */
export function summariseScores(results: DecisionScoreResult[]): {
  average: number | null;
  scorable: number;
  total: number;
  frozen: number;
} {
  const scorable = results.filter((r) => r.scorable && r.decision_score !== null);
  const total = results.length;
  if (!scorable.length) {
    return { average: null, scorable: 0, total, frozen: total };
  }
  const sum = scorable.reduce((a, r) => a + (r.decision_score ?? 0), 0);
  return {
    average: round(sum / scorable.length, 3),
    scorable: scorable.length,
    total,
    frozen: total - scorable.length,
  };
}
