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
  | 'ERROR'
  /**
   * The statement's window had closed, or its precondition no longer held, when
   * this action happened. Produced by the pre-evaluator gates, never by the
   * alignment table.
   *
   * Distinct from NOT_DETERMINABLE on purpose: "we could not read this action"
   * and "this action could not bear on this statement" are different findings,
   * and only the second one is about the statement. Both render as
   * NOT_DETERMINABLE, with their own reason.
   */
  | 'NOT_APPLICABLE_EXPIRED'
  /** No legislative action can fulfil or break this kind of statement at all. */
  | 'NOT_APPLICABLE';

/**
 * The bill's direction of travel on the goal stated in the promise.
 *
 * CONTESTED (evaluator v7) is not a weaker NEUTRAL. It means the bill's
 * direction on this goal IS the partisan dispute — rival bills where each side
 * claims theirs advances the same objective. The tool is not the referee of
 * that dispute, so CONTESTED routes to NOT_DETERMINABLE.
 *
 * ERROR is the absence of a finding and must never collapse to NEUTRAL, which
 * asserts "this bill does not move the goal" — a finding nobody made.
 */
export type BillEffect = 'ADVANCE' | 'HINDER' | 'NEUTRAL' | 'CONTESTED' | 'ERROR';

/** Classifier stance vocabulary. These exact strings go into the embedded text. */
export type Stance = 'In Favor' | 'Opposed' | 'Neutral/Unclear';

// ---------------------------------------------------------------------------
// Statement scope — what KIND of thing was said, and whether legislative action
// can be tested against it at all.
//
// Source: docs/fix/01_statement_scope_classifier.v1_1.md (2026-09-07).
// Runs BEFORE retrieval and can stop a query outright. This is a different
// question from `promise_type`/`stance` (which ask what the statement is ABOUT)
// and the two classifiers both run.
// ---------------------------------------------------------------------------

/** What kind of act the statement performs. */
export type SpeechAct = 'POSITION' | 'COMMITMENT' | 'OPERATIONAL' | 'CREDIT_CLAIM' | 'RHETORIC';

/**
 * Speech acts no vote or sponsorship can fulfil or break.
 *
 * Scheduling remarks, credit claims and rhetoric are not commitments, so their
 * absence from the record is not inaction and their presence is not a promise.
 * Handoff v2 §7: counting them inflates the denominator with statements nobody
 * made — ~26% of a sample statement set.
 */
export const NON_TESTABLE_SPEECH_ACTS: readonly SpeechAct[] = [
  'OPERATIONAL',
  'CREDIT_CLAIM',
  'RHETORIC',
] as const;

export function isTestableSpeechAct(act: SpeechAct): boolean {
  return !NON_TESTABLE_SPEECH_ACTS.includes(act);
}

/** Does the statement bind across the term, or only inside a window/vehicle/role? */
export type StatementScope = 'STANDING' | 'BOUNDED';

/** A precondition the statement presupposes about the speaker's office. */
export type RoleCondition = 'NONE' | 'MAJORITY_LEADER' | 'COMMITTEE_CHAIR' | 'MAJORITY_PARTY';

/** The marker `valid_until` carries when the window is relative and no date was given. */
export const VALID_UNTIL_UNKNOWN = 'UNKNOWN';

export interface ScopeClassification {
  speech_act: SpeechAct;
  scope: StatementScope;
  /**
   * ISO date, `UNKNOWN`, or empty.
   *
   * Empty means STANDING — no last testable date, which is not the same as
   * `UNKNOWN` (bounded, but the window could not be resolved). Collapsing the
   * two turns "never expires" into "we don't know", or worse, the reverse.
   */
  valid_until: string;
  anchor_entity: string;
  role_condition: RoleCondition;
  confidence: number;
  reasoning: string;
  /** Deterministic post-check overrides that fired, e.g. `SCOPE_OVERRIDE_BOUNDED`. */
  flags: string[];
  /** e.g. 'claude-haiku-4-5 / scope-classifier-v1.1'. Stored with the result. */
  model: string;
}

// ---------------------------------------------------------------------------
// Query halts — terminal, and NOT errors.
//
// A halt is a correct, complete answer that happens not to be a verdict. The
// tool declines to retrieve because retrieval could not produce evidence about
// this statement, and says why. Rendering these as failures would teach users
// the tool is broken when it is being careful.
// ---------------------------------------------------------------------------

export type QueryHaltReason =
  /** speech_act ∈ {OPERATIONAL, CREDIT_CLAIM, RHETORIC} — nothing to fulfil or break. */
  | 'NON_TESTABLE_SPEECH_ACT'
  /** scope = BOUNDED with valid_until = UNKNOWN — we need the date to test the window. */
  | 'STATEMENT_DATE_REQUIRED';

export interface QueryHalt {
  reason: QueryHaltReason;
  /** User-facing copy. Safe to render verbatim. */
  message: string;
  /** True when supplying a statement date would let the query proceed. */
  recoverable_with_date: boolean;
  scope: ScopeClassification;
}

/** Copy for the non-testable speech acts, keyed by act. Source: fix/08. */
export const SPEECH_ACT_HALT_NOUN: Record<string, string> = {
  OPERATIONAL: 'scheduling',
  CREDIT_CLAIM: 'credit-claiming',
  RHETORIC: 'rhetorical',
};

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
  /** From Pinecone metadata. Drives the OBSERVED coverage window on a result. */
  congress?: number;
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

  // -- Disclosure fields (handoff v2 §4). NOT bookkeeping. ------------------
  /**
   * Which vote decided this outcome, in words —
   * e.g. 'CLOTURE (60-vote threshold; split vote)', 'SPONSORSHIP', 'NO_ACTION'.
   *
   * A row that reads "voted NAY -> BROKE" while hiding a cloture YEA is exactly
   * the claim a senator's office knocks down. Anything that renders `outcome`
   * must render this beside it.
   */
  vote_governing: string;
  /**
   * Disclosure flags travelling with the row. `SPLIT_VOTE` when cloture and
   * passage diverge; more classes arrive with the pre-evaluator gates.
   */
  vote_flags: string[];
  /**
   * The evaluator's confidence for this single action, after the split-vote cap
   * (contract 2). `null` when no evaluator ran.
   *
   * Stays numeric. The `NOT_EVALUATED` marker that gated rows carry is a
   * separate field — see handoff v2 §3: a marker must never be replaced with a
   * value from the column's own vocabulary, and `0` is a value.
   */
  alignment_confidence: number | null;
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
  | 'UNDIRECTABLE_METADATA'
  /**
   * Behavioural contract 3: an accusation below the confidence floor with no
   * counterargument on the record. NOT an exoneration — the copy for this must
   * say we could not defensibly call it, never that he kept it.
   */
  | 'WITHHELD_LOW_CONFIDENCE'
  /**
   * The adversarial judge failed the reading, or could not run at all.
   *
   * Same posture as WITHHELD_LOW_CONFIDENCE and for the same reason: an
   * accusation no second opinion has cleared is not published. Distinct from it
   * because the cause differs — one is a confidence bar, this is a review that
   * failed or never happened, and a reader deserves to know which.
   */
  | 'WITHHELD_PENDING_REVIEW'
  /**
   * A pre-evaluator gate closed every candidate before the evaluator ran: the
   * statement's window had passed, its precondition no longer held, or the
   * vehicle could not bear on it. Each gated action carries its own reason.
   */
  | 'GATED';

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

/**
 * What record was actually searched.
 *
 * Rendered on EVERY result, not only empty ones. A verdict drawn from two
 * 118th-Congress bills is scoped by the same boundary as a no-match, and the
 * reader is owed the boundary either way.
 */
export interface CoverageWindow {
  /** Declared collected window, e.g. [118, 119]. Empty when unconfigured. */
  congresses: number[];
  /**
   * The span actually seen in this query's retrieved candidates.
   *
   * Derived from the data rather than asserted, so that extending collection
   * cannot leave a hardcoded sentence quietly lying in the other direction.
   * Null when nothing was retrieved — then only the declared window applies.
   */
  observed: { min: number; max: number } | null;
  /**
   * True when the tool cannot say what it searched. Renders as a weaker claim,
   * never as a confident absence.
   */
  unknown: boolean;
}

/**
 * One sentence, safe to show, stating the boundary.
 *
 * Deliberately says what was SEARCHED, never what the senator did. The
 * distinction is the whole point: the tool can speak with authority about its
 * own corpus and has no standing to speak about anything outside it.
 *
 * Lives in `shared` rather than in the server because the client renders it and
 * the server persists it, and two copies of this sentence would drift. The
 * DERIVATION stays server-side in `scoring/coverage.ts` — it reads config, and
 * `observed` must come from the retrieved candidates rather than from anything
 * the browser could assert.
 */
export function coverageSentence(coverage: CoverageWindow): string {
  if (coverage.unknown) {
    return 'We could not establish which legislative record was searched, so treat an empty result as inconclusive rather than as an absence of action.';
  }

  // Prefer the DECLARED window; fall back to what was actually observed.
  // An unset COVERAGE_CONGRESSES with real candidates in hand is not "we don't
  // know" — the data says which congresses were searched, and saying so is
  // better than a vague disclaimer.
  const list = coverage.congresses.length
    ? coverage.congresses
    : coverage.observed
      ? Array.from(
          { length: coverage.observed.max - coverage.observed.min + 1 },
          (_, i) => coverage.observed!.min + i,
        )
      : [];

  if (!list.length) {
    return 'This covers only the legislation we have analyzed, which may not be a senator’s full record.';
  }

  const span =
    list.length === 1
      ? `the ${ordinal(list[0]!)} Congress`
      : `the ${list.slice(0, -1).map(ordinal).join(', ')} and ${ordinal(list[list.length - 1]!)} Congress`;

  return `We searched ${span}. Anything before that is outside the record we have analyzed, so an empty result here is not a finding that the senator has no record on the subject.`;
}

const ordinal = (n: number): string => {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
};

/**
 * A retrieved action that a pre-evaluator gate closed before the evaluator ran.
 *
 * DISPLAYED WITH ITS REASON, never dropped. fix/08 calls gated items "the thing
 * that makes the tool look honest": "Not evaluated: leader procedural vote" is
 * a useful answer, and silently discarding the row turns a deliberate refusal
 * to read something into an absence of evidence.
 *
 * Kept out of `ScoredResult.evidence` on purpose. These rows never reached the
 * evaluator, so they carry no direction, no weight and no confidence — sitting
 * them beside scored evidence would imply they were weighed and found wanting,
 * when in fact we declined to weigh them at all.
 */
export interface GatedAction {
  action_uid: string;
  bill_id: string;
  bill_number?: string;
  title: string;
  /** Which gate fired, e.g. `G4_vehicle`. Analyst trace only, not Level 1. */
  gate: string;
  /**
   * The terminal outcome the gate assigned.
   *
   * `NOT_APPLICABLE_EXPIRED` and `NOT_APPLICABLE` are the interesting ones:
   * "this action could not bear on this statement" is a finding about the
   * STATEMENT, and different from "we could not read this action".
   */
  outcome: AlignmentOutcome;
  /** Plain-language, written for a reader, safe to render verbatim. */
  reason: string;
  source_url?: string;
}

/**
 * What the adversarial second opinion did with an accusation.
 *
 * The judge runs ONLY on a derived BROKE/INCONSISTENT — the minority of
 * queries, and exactly where the risk is. Its disposition was persisted, handed
 * to the model and logged to the console, and never shown to the person reading
 * the verdict.
 */
export interface JudgeDisclosure {
  /** PASS | PASS_ON_RETRY | REVIEW_REQUIRED | REVIEW_REQUIRED_JUDGE_CORRECTED | JUDGE_ERROR | GATED_*. */
  disposition: string;
  /** True when the accusation was not published. */
  withheld: boolean;
  /**
   * True when no review happened at all — no credential, or the model returned
   * nothing usable.
   *
   * Load-bearing, and NOT the same as a failed review. "A reviewer disagreed"
   * and "nobody looked" are different facts about how much scrutiny a reading
   * received, and a reader deserves to know which. Handoff v2 §5: an
   * infrastructure failure is never a content verdict.
   */
  unavailable: boolean;
  /**
   * The senator's strongest counterargument, as the judge stated it.
   *
   * §5: a PASS is invalid without one — the parser downgrades a
   * counterargument-free PASS to FAIL. So whenever an accusation IS published,
   * this exists, and showing it beside the accusation is the entire point of
   * requiring it.
   */
  counterargument: string | null;
  /** Analyst vocabulary. Level 2 only. */
  failed_test: string | null;
  failure_class: string | null;
}

/**
 * Plain-language copy per judge disposition.
 *
 * Same discipline as ND_REASON_COPY: the wording lives here so it cannot drift,
 * and NONE of it is exculpatory. Withholding an accusation is not a finding
 * that the senator kept anything, and a review that could not run is not a
 * review that cleared him.
 */
export const JUDGE_DISPOSITION_COPY: Record<string, string> = {
  PASS: 'This reading was put to a second, adversarial review, which did not overturn it.',
  PASS_ON_RETRY:
    'This reading did not survive a first adversarial review. It was re-examined and passed on the second look, and is held to a lower confidence as a result.',
  REVIEW_REQUIRED:
    'A second, adversarial review did not sustain this reading, and offered no correction we could stand behind. We are not publishing it. The bills and votes are below — read them and judge for yourself.',
  REVIEW_REQUIRED_JUDGE_CORRECTED:
    'A second, adversarial review did not sustain the original reading and supplied a correction. What you see is the corrected reading, flagged for human review.',
  // NOT "a reviewer disagreed". Nobody looked, and saying otherwise would claim
  // a scrutiny this reading never received.
  JUDGE_ERROR:
    'The second-opinion review could not run, so this reading has not been checked by anything but the evaluator. We do not publish an accusation no reviewer has seen. The bills and votes are below — read them and judge for yourself.',
};

/**
 * The sentence for a disposition, or null when there is nothing to say.
 *
 * `GATED_*` dispositions are matched by prefix: the suffix is the failure class,
 * which is analyst vocabulary and belongs in the trace rather than in front of
 * a voter.
 */
export function judgeDispositionSentence(disposition: string | null | undefined): string | null {
  if (!disposition) return null;
  if (JUDGE_DISPOSITION_COPY[disposition]) return JUDGE_DISPOSITION_COPY[disposition]!;
  if (disposition.startsWith('GATED_')) {
    return 'A deterministic check caught this reading before it reached review, so we are not publishing it. The bills and votes are below — read them and judge for yourself.';
  }
  return null;
}

export interface QueryResult {
  senator: Senator;
  interpretation: Interpretation;
  scored: ScoredResult;
  explanation: Explanation;
  /** True when interpret/explain came from deterministic stubs. */
  demo_mode: boolean;
  /** True when matches came from fixtures rather than Pinecone. */
  fixture_mode: boolean;
  /** What record was searched. Must be rendered alongside any verdict. */
  coverage?: CoverageWindow;
  /**
   * Actions closed by a gate before evaluation. Rendered with their reasons.
   *
   * Optional because results persisted before this field existed do not carry
   * it — absent means "we don't know", never "none were gated".
   */
  gated?: GatedAction[];
  /**
   * What the adversarial review did, when one was attempted.
   *
   * Absent means the judge never came into it — the verdict was not an
   * accusation. It does NOT mean the reading passed review.
   */
  judge?: JudgeDisclosure;
}

// ---------------------------------------------------------------------------
// SSE stream events
// ---------------------------------------------------------------------------

export type StepId =
  /**
   * Statement scope classification. FIRST, before interpret — it can halt the
   * query, and the cheapest wasted work is work never started.
   */
  | 'classify_scope'
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

/**
 * The query stopped before retrieval, on purpose.
 *
 * Deliberately NOT a StreamErrorEvent. A halt is a complete answer — the tool
 * declined to retrieve because retrieval could not produce evidence about this
 * statement. The UI must render it as an explanation, never as a failure with a
 * retry button: retrying changes nothing, and a `STATEMENT_DATE_REQUIRED` halt
 * wants a date, not another attempt.
 */
export interface HaltEvent {
  type: 'halt';
  halt: QueryHalt;
}

export interface DoneEvent {
  type: 'done';
}

export type StreamEvent =
  | StepEvent
  | InterpretationEvent
  | UncachedEvent
  | ResultEvent
  | HaltEvent
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
  // Deliberately NOT exculpatory. Withholding an accusation is not a finding
  // that he kept it, and this sentence must never be readable as one.
  WITHHELD_LOW_CONFIDENCE:
    "The record here points against this promise, but not clearly enough for us to say so publicly. The bills and votes are below — read them and judge for yourself.",
  // Also deliberately not exculpatory. "A reviewer disagreed" is not "he kept
  // it", and the sentence must not be readable as either an accusation or a
  // clearing.
  WITHHELD_PENDING_REVIEW:
    "A second review didn't back this reading, so we're not publishing it. The bills and votes are below — read them and judge for yourself.",
  GATED:
    "The legislation we found can't settle this statement — the window it applied to had closed, or the bills were too broad to say anything about it specifically. Each item below says which.",
};

/**
 * Copy for a NOT_DETERMINABLE that arrived with no reason recorded.
 *
 * Exists so the UI never has to fall back to `NO_MATCHES`, which is the
 * strongest absence claim in the vocabulary — "we searched and this senator has
 * nothing on the subject". Defaulting to it on a missing field would have the
 * tool assert a finding it never made, which is the same failure the coverage
 * sentence exists to prevent, arriving through a different door.
 *
 * Says only what is actually known: no defensible reading, reason unrecorded.
 */
export const ND_NO_REASON_COPY =
  "We couldn't reach a defensible reading here, and the specific reason wasn't recorded. Anything we did find is below — read it and judge for yourself.";

/**
 * Plain-language rendering of `vote_governing`, for Level 1.
 *
 * The raw strings are analyst vocabulary and one of them —
 * `CLOTURE (60-vote threshold; split vote)` — contains "threshold", which is in
 * BANNED_LEVEL1_TERMS. Printing it verbatim to a voter would break the Level-1
 * rule that the receipt carries no statistics, so the raw value stays in the
 * analyst trace and these sentences stand in front of it.
 *
 * Unknown keys return null and render nothing. A `vote_governing` value this
 * map has not been taught is jargon, and showing jargon is worse than showing
 * one less line — the votes themselves are already named on the card.
 */
export const GOVERNING_VOTE_COPY: Record<string, string> = {
  // The disclosure that matters most. Handoff v2 §4: a row reading "voted NAY
  // -> BROKE" while hiding a cloture YEA is exactly the claim a senator's
  // office knocks down.
  'CLOTURE (60-vote threshold; split vote)':
    'Two votes here, and they point different ways. The vote on whether to let the bill proceed is the one that governs, because that is the stage where a bill lives or dies.',
  'CLOTURE+PASSAGE (agree)':
    'They voted the same way twice — once on whether to let the bill proceed, once on the bill itself.',
  'CLOTURE (only vote recorded)':
    'The one recorded vote was on whether to let the bill proceed, not on the bill itself.',
  'PASSAGE (no cloture vote)':
    'The recorded vote was on the bill itself; there was no separate vote on whether to let it proceed.',
  'VOTE (untyped)':
    'The record shows a single vote on this bill without saying which stage it belonged to.',
  SPONSORSHIP: 'There was no vote to read here — putting their name to the bill is the action.',
  SPONSOR_NAY:
    'They put their name to this bill and then voted against it. We do not read that as either keeping or breaking the statement.',
};

/**
 * The Level-1 sentence for a governing vote, or null when there is nothing to
 * say (`NA`, `NO_ACTION`, or a value this map has not been taught).
 */
export function governingVoteSentence(voteGoverning: string | null | undefined): string | null {
  if (!voteGoverning) return null;
  return GOVERNING_VOTE_COPY[voteGoverning] ?? null;
}

/**
 * Reader-facing copy for the disclosure flags travelling on a row.
 *
 * These are a separate channel from `scoring_flags`: they are shown beside the
 * verdict rather than used to weight it. Each says something that changes how
 * the row should be read, which is why they are Level 1 rather than trace.
 *
 * Unknown flags render nothing here and appear raw in the analyst trace.
 */
export const VOTE_FLAG_COPY: Record<string, string> = {
  SPLIT_VOTE: 'Split vote — the two votes on this bill went different ways.',
  // Institutional fact, not a motive. The platform's non-goals rule out intent
  // attribution, so this says what the role involves and leaves the reading to
  // the reader.
  FLOOR_LEADER:
    'They held a floor leadership role at the time — a role that involves casting procedural votes on the chamber\'s behalf.',
  ACTION_DATE_PROXY:
    'We do not have an exact date for this action, so the start of that Congress was used when checking timing.',
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
