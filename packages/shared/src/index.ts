// ===========================================================================
// Shared contract between the server and the web client.
//
// The type names here are load-bearing. `Verdict` has exactly three members and
// must keep exactly three: it is what a voter reads. `AlignmentOutcome` is the
// wider internal set the WF10A port actually produces — PROCEDURAL_SWITCH and
// ERROR are real outcomes of that table, but they present as NOT_DETERMINABLE
// with their own reason rather than as labels of their own.
// ===========================================================================

/** Voter-facing verdict labels. Exactly three. Do not extend. */
export type Verdict = 'KEPT' | 'BROKE' | 'NOT_DETERMINABLE';

/**
 * Where the claim that this is a PROMISE comes from.
 *
 * Load-bearing, not cosmetic. It picks the verdict vocabulary — and, since
 * 2026-08-19, selects the decision-score base table and the index bucket
 * (Trust vs Consistency). It has no provenance in free-typed text, which is
 * why the default is the weaker one.
 *
 * It DOES carry a −0.1 confidence penalty for the weaker commitment standard —
 * but the penalty is applied by the fulfillment evaluator per its system
 * prompt, NOT by any code. WF10A's `Promise Alignment Evaluator` prompt
 * instructs it three times ("Apply a -0.1 confidence penalty relative to what
 * you would assign for an equivalent Campaign Promise") and forbids
 * `confidence >= 0.9` for Policy Positions outright.
 *
 * Reading the code alone shows no penalty, which is exactly how this was
 * briefly mis-corrected: `statementType` really does only pick the label pair,
 * and `alignment_confidence` really does pass through the parse untouched. The
 * mechanism is upstream of the parse, in the prompt. Do not "implement" it in
 * code — that would double-apply it. See RECONCILIATION 2026-08-19.
 *
 * Downstream consequence, deliberate: `computeDecisionScore` awards
 * CONFIDENCE_HIGH (+0.05) at `>= 0.9`, so a Policy Position can never earn it.
 */
export type StatementType = 'Campaign Promise' | 'Policy Position';

/** How we came to believe a query is a campaign promise. Drives the copy. */
export type ProvenanceSource =
  | 'default'    // free text, no evidence he said it — Policy Position
  | 'corpus'     // matched a tracked statement; type came from that row
  | 'asserted';  // the user ticked "he promised this"; premise is theirs

/**
 * Everything the alignment table can return, including outcomes that are not
 * voter-facing labels. Map to `Verdict` via `toVerdict()` before rendering.
 *
 * CONSISTENT/INCONSISTENT are the Policy Position vocabulary; KEPT/BROKE are
 * the Campaign Promise vocabulary. Same table, different labels.
 */
export type AlignmentOutcome =
  | Verdict
  | 'CONSISTENT'
  | 'INCONSISTENT'
  | 'PROCEDURAL_SWITCH'
  | 'ERROR';

/** The bill's direction of travel on the goal stated in the promise. */
export type BillEffect = 'ADVANCE' | 'HINDER' | 'NEUTRAL' | 'ERROR';

/** Classifier stance vocabulary. These exact strings go into the embedded text. */
export type Stance = 'In Favor' | 'Opposed' | 'Neutral/Unclear';

/** Classifier promise-type vocabulary. Four values, not two. */
export type PromiseType = 'policy' | 'process' | 'rhetorical' | 'non_legislative';

export type ConfidenceBand = 'High' | 'Medium' | 'Low';

/** Retrieval bands from WF7a: STRONG >= 0.575, WEAK >= 0.50, else dropped. */
export type MatchStrength = 'STRONG' | 'WEAK' | 'BELOW_THRESHOLD';

/** Evidence weighting class. Hard evidence is a vote or a sponsorship. */
export type EvidenceType = 'vote' | 'sponsorship' | 'procedural' | 'associative';

export type ActionTier =
  | 'VOTED'
  | 'SPONSOR'
  | 'CO_SPONSOR'
  | 'ABSTAIN'
  | 'PROCEDURAL'
  | 'NONE';

/** The eight WF11 vote patterns. */
export type VotePattern =
  | 'DECISIVE_BLOCK'
  | 'CONSISTENT_OPPOSE'
  | 'CONSISTENT_SUPPORT'
  | 'PASSAGE_ONLY'
  | 'NO_FLOOR_ACTION'
  | 'BLOCKED_THEN_JOINED'
  | 'ENABLED_THEN_OPPOSED'
  | 'CLOTURE_ONLY_YEA';

/** A normalised directional vote. Abstentions normalise to `null`, not a value. */
export type NormalisedVote = 'YEA' | 'NAY' | null;

/** Which way a single matched action points relative to the promise. */
export type Direction = 'keeps' | 'breaks' | 'neutral';

// ---------------------------------------------------------------------------
// Envelopes — every tool and every branch returns one of these. Nothing throws
// into a dead end.
// ---------------------------------------------------------------------------

export interface ToolError {
  code:
    | 'UNCACHED_SENATOR'
    | 'NO_MATCHES'
    | 'BELOW_FLOOR'
    | 'UNDIRECTABLE'
    | 'UPSTREAM_UNAVAILABLE'
    | 'MISSING_METADATA'
    | 'BAD_INPUT'
    | 'INTERNAL';
  message: string;
  /** True when a retry could plausibly succeed. Drives the UI's retry affordance. */
  recoverable: boolean;
  details?: Record<string, unknown>;
}

export type Envelope<T> = { ok: true; data: T } | { ok: false; error: ToolError };

export const ok = <T>(data: T): Envelope<T> => ({ ok: true, data });
export const fail = <T = never>(error: ToolError): Envelope<T> => ({ ok: false, error });

// ---------------------------------------------------------------------------
// Senators
// ---------------------------------------------------------------------------

export interface Senator {
  politician_id: string;
  name: string;
  /** Cached senators answer instantly; uncached ones become a demand signal. */
  cached: boolean;
  party?: 'D' | 'R' | 'I';
  state?: string;
}

// ---------------------------------------------------------------------------
// Interpretation — mirrors the live Statement Classifier's output contract,
// because these strings are embedded verbatim into the query text.
// ---------------------------------------------------------------------------

export interface Interpretation {
  /** The user's text, unmodified. */
  raw: string;
  /**
   * Which vocabulary the verdict is rendered in, and where that claim came
   * from. Defaults to the weaker standard because free-typed text carries no
   * provenance — printing "BROKE" against a commitment we have no evidence was
   * made is the one output with real downside.
   */
  statement_type: StatementType;
  provenance: ProvenanceSource;
  /** One-line neutral paraphrase shown back to the user. */
  restated: string;
  /** Fields the user corrected on this run, for the delta display. */
  corrections_applied?: CorrectionDelta[];
  /**
   * True when the Campaign Promise vocabulary came from the USER asserting the
   * premise rather than from evidence. Must travel with the verdict into any
   * share or export — the claim "he promised this" is then the user's, and
   * dropping the attribution silently converts it into ours.
   */
  user_asserted_premise?: boolean;
  primary_issue: string;
  sub_issue: string;
  stance: Stance;
  promise_type: PromiseType;
  is_evaluable: boolean;
  key_policy_terms: string[];
  /**
   * The verbatim `Taxonomy Keywords` cell, looked up by
   * (primary_issue, sub_issue). A lookup, never model output, and never
   * re-joined — upstream treats this cell as an opaque string.
   */
  taxonomy_keywords: string;
  reasoning: string;
}

// ---------------------------------------------------------------------------
// Retrieved actions
// ---------------------------------------------------------------------------

export interface MatchedAction {
  action_uid: string;
  bill_id: string;
  bill_number?: string;
  bill_type?: string;
  title: string;
  summary: string;
  intended_effects: string;
  mechanisms: string;
  affected_stakeholders?: string;

  action_type: string;
  is_sponsor: boolean;
  is_cosponsor: boolean;

  /** Raw values as stored. 'NA' / 'NOT_VOTED' / '' all mean "no directional vote". */
  vote: string;
  cloture_vote: string;
  passage_vote: string;

  /** Bridging vocabulary — the "why this bill" connector. */
  bill_keywords: string[];
  primary_issue: string;
  sub_issue: string;
  source_url: string;

  /** Cosine similarity from Pinecone. */
  score: number;
  strength: MatchStrength;

  /**
   * Metadata fields that were expected and absent. Surfaced rather than
   * silently defaulted, so a thin result is visibly thin.
   */
  missing_fields: string[];
}

/** A matched action after the LLM has judged its effect on the promise goal. */
export interface DirectedAction extends MatchedAction {
  bill_effect: BillEffect;
  bill_effect_reasoning: string;
  outcome: AlignmentOutcome;
  direction: Direction;
  evidence_type: EvidenceType;
  action_tier: ActionTier;
  vote_pattern: VotePattern;
  /** Deterministic weight = strength_factor × evidence_type_factor. */
  weight: number;
  scoring_flags: string[];
}

// ---------------------------------------------------------------------------
// Scoring output
// ---------------------------------------------------------------------------

/**
 * Why a NOT_DETERMINABLE happened. Each maps to distinct plain-language copy —
 * "we couldn't find enough to say" is not one message, it's several.
 */
export type NotDeterminableReason =
  | 'NO_MATCHES'
  | 'ALL_BELOW_FLOOR'
  | 'ALL_NEUTRAL'
  | 'NO_ACTION'
  | 'PROCEDURAL_SWITCH'
  | 'NON_LEGISLATIVE'
  | 'NOT_EVALUABLE'
  | 'UNDIRECTABLE_METADATA';

/** Level-2 analyst trace. Never rendered at Level 1. */
export interface FactorReceipt {
  match_count: number;
  directed_count: number;
  avg_strength: number;
  strongest_score: number;
  evidence_mix: Record<EvidenceType, number>;
  direction_split: { keeps: number; breaks: number; neutral: number };
  weight_split: { keeps: number; breaks: number };
  minority_share: number;
  /** Ordered gate/dial trace, e.g. "G1 passed: 4 of 10 matches above floor". */
  trace: string[];
  scoring_flags: string[];
}

export interface RankedEntry {
  verdict: Exclude<Verdict, 'NOT_DETERMINABLE'>;
  band: ConfidenceBand;
  weight: number;
  evidence_uids: string[];
}

export interface ScoredResult {
  verdict: Verdict;
  band: ConfidenceBand | null;
  mode: 'single' | 'ranked' | 'not_determinable';
  /** Populated only when verdict is NOT_DETERMINABLE. */
  nd_reason: NotDeterminableReason | null;
  /** Populated only in ranked mode: dominant first, dissent after. */
  ranked: RankedEntry[];
  receipt: FactorReceipt;
  evidence: DirectedAction[];
}

// ---------------------------------------------------------------------------
// Explanation — generated from a frozen ScoredResult. Cannot alter it.
// ---------------------------------------------------------------------------

export interface Explanation {
  /** The Level-1 "why", 2–3 sentences, no statistics. */
  why: string;
  /** action_uid -> one-line "why this bill" connector. */
  connectors: Record<string, string>;
  confidence: number;
}

// ---------------------------------------------------------------------------
// The complete query result
// ---------------------------------------------------------------------------

export interface QueryResult {
  senator: Senator;
  interpretation: Interpretation;
  scored: ScoredResult;
  explanation: Explanation;
  /** True when interpret/explain came from deterministic stubs. */
  demo_mode: boolean;
  /** True when matches came from fixtures rather than Pinecone. */
  fixture_mode: boolean;
}

// ---------------------------------------------------------------------------
// SSE stream events
// ---------------------------------------------------------------------------

export type StepId =
  | 'interpret'
  | 'resolve_senator'
  | 'embed'
  | 'search'
  | 'score'
  | 'explain';

export interface StepEvent {
  type: 'step';
  id: StepId;
  label: string;
  status: 'running' | 'done' | 'error';
  /** Short human-readable detail, e.g. "found 4 related actions". */
  detail?: string;
}

/**
 * A user's correction to the classification.
 *
 * EVERY correctable field here lives inside the embedded query text, so a
 * correction changes the vector and therefore the candidate set. That makes a
 * correction a FULL RE-RUN from embedding — not a re-evaluation of the matches
 * already on screen, and not a filter over them. The UI must express it as an
 * explicit action for that reason: live-updating controls would imply the
 * result reshapes in place, which is the one thing it cannot do.
 */
export interface Corrections {
  primary_issue?: string;
  sub_issue?: string;
  stance?: Stance;
  promise_type?: PromiseType;
  key_policy_terms?: string[];
  /**
   * The user asserts this was an actual campaign promise, which upgrades the
   * verdict vocabulary to KEPT/BROKE. Gated behind a feature flag pending copy
   * review, and the premise is attributed to the user wherever it is shown.
   */
  assert_campaign_promise?: boolean;
}

/** One field the user changed, for the delta display. */
export interface CorrectionDelta {
  field: string;
  from: string;
  to: string;
}

export interface InterpretationEvent {
  type: 'interpretation';
  interpretation: Interpretation;
}

export interface UncachedEvent {
  type: 'uncached';
  senator: Senator;
  queued: boolean;
}

export interface ResultEvent {
  type: 'result';
  result: QueryResult;
}

export interface StreamErrorEvent {
  type: 'error';
  error: ToolError;
}

export interface DoneEvent {
  type: 'done';
}

export type StreamEvent =
  | StepEvent
  | InterpretationEvent
  | UncachedEvent
  | ResultEvent
  | StreamErrorEvent
  | DoneEvent;

// ---------------------------------------------------------------------------
// Presentation helpers — the §8.6 vocabulary table, in code, so Level 1 copy
// cannot drift from the agreed wording.
// ---------------------------------------------------------------------------

/**
 * Collapse the internal outcome set onto the three rendering buckets.
 *
 * P0.2's three labels are a RENDERING contract, not the internal vocabulary:
 * both statement-type vocabularies map into it, and the words a user actually
 * reads come from `outcomeHeadline()`.
 */
export function toVerdict(outcome: AlignmentOutcome): Verdict {
  if (outcome === 'KEPT' || outcome === 'CONSISTENT') return 'KEPT';
  if (outcome === 'BROKE' || outcome === 'INCONSISTENT') return 'BROKE';
  return 'NOT_DETERMINABLE';
}

/**
 * The words a user reads, chosen by provenance.
 *
 * Printing "BROKE" next to a sitting senator on a commitment we have no
 * evidence he made is the one output that could genuinely damage someone. So a
 * free-typed query gets alignment language; promise language is earned, either
 * by a corpus match or by the user asserting the premise — and when it is
 * asserted, the copy says whose premise it is.
 */
export function outcomeHeadline(
  outcome: AlignmentOutcome,
  statementType: StatementType,
  provenance: ProvenanceSource,
): string {
  const bucket = toVerdict(outcome);
  if (bucket === 'NOT_DETERMINABLE') return VERDICT_PHRASE.NOT_DETERMINABLE;

  if (statementType === 'Policy Position') {
    return bucket === 'KEPT'
      ? 'His record is consistent with this position'
      : 'His record runs counter to this position';
  }

  if (provenance === 'asserted') {
    return bucket === 'KEPT'
      ? 'You indicated this was a campaign promise. On that basis, his record is consistent with it'
      : 'You indicated this was a campaign promise. On that basis, his record runs counter to it';
  }

  // Corpus-verified promise: the strongest claim the product makes, and earned.
  return bucket === 'KEPT' ? 'Kept' : 'Broke';
}

export const BAND_PHRASE: Record<ConfidenceBand, string> = {
  High: "we're confident",
  Medium: "there's decent evidence",
  Low: 'the evidence is thin',
};

export const STRENGTH_PHRASE: Record<MatchStrength, string> = {
  STRONG: 'closely related',
  WEAK: 'loosely related',
  BELOW_THRESHOLD: 'not closely related enough to count',
};

export const VERDICT_PHRASE: Record<Verdict, string> = {
  KEPT: 'Kept',
  BROKE: 'Broke',
  NOT_DETERMINABLE: "We couldn't find enough to say",
};

/**
 * Plain-language reasons for each NOT_DETERMINABLE cause. A thin result is
 * designed with as much care as a strong one, so each cause gets its own
 * sentence rather than a shared shrug.
 */
export const ND_REASON_COPY: Record<NotDeterminableReason, string> = {
  NO_MATCHES:
    "We didn't find any bills or votes in this senator's analyzed record that relate to this promise.",
  ALL_BELOW_FLOOR:
    "We found some legislation on this subject, but nothing closely enough related to this promise to count as evidence.",
  ALL_NEUTRAL:
    "The bills we found touch this subject but don't move the goal in this promise in either direction.",
  NO_ACTION:
    "We found related legislation, but this senator neither voted on it nor put their name to it — so there's no action to judge.",
  PROCEDURAL_SWITCH:
    'They sponsored this bill but voted against it, so we can’t read this as either keeping or breaking the promise.',
  NON_LEGISLATIVE:
    "This promise isn't something a bill or a vote can settle, and we only track legislative action.",
  NOT_EVALUABLE:
    "We couldn't tell what specific commitment to check here. Try naming the policy, program, or outcome you have in mind.",
  UNDIRECTABLE_METADATA:
    "We found related legislation but couldn't establish which way it cuts on this promise, so we're not going to guess.",
};

/** Words that must never appear in Level-1 voter-facing copy. */
export const BANNED_LEVEL1_TERMS = [
  'similarity',
  'cosine',
  'confidence band',
  'threshold',
  'multiplier',
  'score',
  'modifier',
] as const;

/**
 * Motive language. The platform's non-goals rule out intent attribution, and a
 * missed vote has non-strategic explanations we cannot distinguish from the
 * data. Score the behaviour; describe the behaviour.
 */
export const BANNED_MOTIVE_TERMS = [
  'avoid',
  'dodge',
  'ducked',
  'strategic',
  'maneuver',
  'virtue signal',
  'deliberately',
  'intentionally',
  'wanted to',
  'tried to hide',
] as const;
