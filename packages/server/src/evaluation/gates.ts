/**
 * Pre-retrieval gates.
 *
 * ⚠ CORRECTION TO BOTH SPECS. `query-tool-build-spec.md` §3.3 and
 * `query-tool-thread-context.md` §3 both say "the same three gates WF10A
 * applies" / "Three gates fire before retrieval, mirroring WF10A."
 *
 * Live WF10A (`Enrich With Statement Type`, verified 2026-08-17, published)
 * applies TWO gates: promise_type and stance. There is no `is_evaluable` gate
 * in WF10A — evaluability is enforced far upstream by the source tab
 * (`Evaluable Statements - {pid}`), which only ever contains rows the
 * classifier marked evaluable.
 *
 * The query tool still needs an evaluability gate, because it has no such tab —
 * arbitrary user text arrives unfiltered. So the gate count is right by
 * accident. But it should not be described as mirroring WF10A, and more
 * importantly the two gates WF10A DOES apply have semantics the specs omit:
 *
 *  1. BOTH FAIL OPEN ON BLANK. An unknown promise_type is NOT gated. A blank
 *     stance is NOT gated. WF10A's comment: "an unknown type costs one wasted
 *     evaluation, while gating it would remove the promise from the trust score
 *     silently." Implementing the specs literally — gate on anything that isn't
 *     an allowed value — inverts this and silently drops queries.
 *
 *  2. THE STANCE SET IS FOUR VALUES, not one. Live:
 *     NEUTRAL/UNCLEAR, NEUTRAL, UNCLEAR, NONE — uppercased and trimmed.
 *     The specs name only `Neutral/Unclear`.
 *
 *  3. GATED ROWS ARE NOT DROPPED. WF10A writes a terminal NOT_APPLICABLE
 *     record carrying the plain-language reason, because a silently dropped row
 *     re-entered the queue head and deadlocked the drain. The query tool has no
 *     queue, but the user-facing equivalent holds: return the reason, never an
 *     empty result. `Bill Effect` is NOT_EVALUATED, never NEUTRAL — NEUTRAL
 *     would read as "the bill does not move this position", a finding we did
 *     not make.
 *
 * Catching these before retrieval saves ~20 LLM calls on input that can never
 * produce a verdict.
 */

/** The classifier's contract. Verified against the WF3 Claude prompt's examples. */
export interface ClassifiedStatement {
  PSU_ID: string;
  primary_issue: string;
  sub_issue: string;
  /** 'In Favor' | 'Opposed' | 'Neutral/Unclear' */
  stance: string;
  /** 'policy' | 'process' | 'rhetorical' | 'non_legislative' */
  promise_type: string;
  is_evaluable: boolean;
  key_policy_terms: string[];
  reasoning: string;
}

export type GateName = 'EVALUABILITY' | 'PROMISE_TYPE' | 'STANCE';

export interface GateResult {
  /** True when the statement should proceed to embedding + retrieval. */
  scorable: boolean;
  gate: GateName | null;
  /** Plain-language reason, safe to show the user verbatim. Empty when scorable. */
  reason: string;
  /**
   * Terminal verdict for a gated statement. NOT_APPLICABLE is terminal, not
   * pending: promise_type and stance are properties of the statement and will
   * never become scorable.
   */
  verdict: 'NOT_APPLICABLE' | null;
  /** Never a value from the ADVANCE/HINDER/NEUTRAL vocabulary. */
  bill_effect: 'NOT_EVALUATED' | null;
  /** A definitional exclusion has no confidence to report. */
  alignment_confidence: 'NOT_EVALUATED' | null;
}

/** Types that no legislative action can fulfil or break. */
const NOT_SCORABLE_TYPE = new Set(['non_legislative', 'rhetorical']);

/** Stances that carry no direction. Live set — four values, not one. */
const NOT_SCORABLE_STANCE = new Set(['NEUTRAL/UNCLEAR', 'NEUTRAL', 'UNCLEAR', 'NONE']);

const S = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

const PASS: GateResult = {
  scorable: true,
  gate: null,
  reason: '',
  verdict: null,
  bill_effect: null,
  alignment_confidence: null,
};

function gated(gate: GateName, reason: string): GateResult {
  return {
    scorable: false,
    gate,
    reason,
    verdict: 'NOT_APPLICABLE',
    bill_effect: 'NOT_EVALUATED',
    alignment_confidence: 'NOT_EVALUATED',
  };
}

/**
 * Applies the pre-retrieval gates in the order WF10A applies them:
 * promise_type, then stance. Evaluability runs first because it is this tool's
 * substitute for the Evaluable Statements tab.
 *
 * Ordering is observable — a rhetorical statement with a neutral stance reports
 * the promise_type reason, matching the pipeline.
 */
export function applyPreRetrievalGates(c: ClassifiedStatement): GateResult {
  // ---- EVALUABILITY (this tool only; upstream of WF10A in the pipeline) ----
  // Explicit `false` only. An absent field fails open, consistent with the
  // other two gates — a missing flag is not a finding.
  if (c.is_evaluable === false) {
    return gated(
      'EVALUABILITY',
      'This statement cannot be evaluated against legislative activity because it does not ' +
        'name a policy mechanism, bill, agency action, or measurable commitment.' +
        (S(c.reasoning) ? ` The classifier noted: ${S(c.reasoning)}` : '')
    );
  }

  // ---- PROMISE TYPE ----
  const promiseType = S(c.promise_type).toLowerCase();
  if (promiseType && NOT_SCORABLE_TYPE.has(promiseType)) {
    return gated(
      'PROMISE_TYPE',
      `NOT_APPLICABLE: Promise Type is ${promiseType}. No legislative action can fulfil or ` +
        `break this statement, so no vote or sponsorship is evidence for or against it.`
    );
  }

  // ---- STANCE ----
  const stanceRaw = S(c.stance);
  const stance = stanceRaw.toUpperCase();
  if (stance && NOT_SCORABLE_STANCE.has(stance)) {
    return gated(
      'STANCE',
      `NOT_APPLICABLE: Promise Stance is ${stanceRaw}. A statement with no committed direction ` +
        `cannot be advanced or hindered, so there is no alignment to measure.`
    );
  }

  // FAIL OPEN. Blank promise_type and blank stance both pass, deliberately.
  return PASS;
}

/**
 * Assertion for the classifier's output, per build spec §5 ("after classify:
 * all six fields present"). The live prompt emits eight keys; six are
 * load-bearing downstream.
 *
 * Throwing here is correct: a partial classification means `stance` may be
 * missing, and stance is baked into Bill Effect at STEP 1 of the fulfillment
 * prompt. A missing stance does not produce a weaker verdict — it produces an
 * inverted one.
 */
export function assertClassification(c: Partial<ClassifiedStatement>): asserts c is ClassifiedStatement {
  const required: Array<keyof ClassifiedStatement> = [
    'primary_issue',
    'sub_issue',
    'stance',
    'promise_type',
    'is_evaluable',
    'reasoning',
  ];
  const missing = required.filter((k) => c[k] === undefined || c[k] === null || c[k] === '');
  if (missing.length) {
    throw new Error(
      `Classifier returned partial JSON — missing: ${missing.join(', ')}. ` +
        `Refusing to proceed: stance is baked into Bill Effect at STEP 1, so a missing ` +
        `stance inverts the verdict rather than weakening it.`
    );
  }
  if (!Array.isArray(c.key_policy_terms)) {
    throw new Error('Classifier returned key_policy_terms that is not an array.');
  }
}
