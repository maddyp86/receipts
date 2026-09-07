import {
  EVALUATOR_SYSTEM_PROMPT,
  EVALUATOR_SYSTEM_PROMPT_LENGTH,
  EVALUATOR_SYSTEM_PROMPT_VERSION,
} from './evaluatorPromptV7.js';
import type { ResponsesEnvelope, ResponsesRequestBody } from './relevance.js';
import { normalizeRelevanceResponse } from './relevance.js';
import { config } from '../config.js';

// ===========================================================================
// FULFILLMENT — the bill_effect leg.
//
// PORT of WF10A `Promise Alignment Evaluator` (BuA0XMoRIeA8K-IziChwR), running
// EVALUATOR PROMPT v7 (docs/fix/07_wf10a_evaluator_prompt_v7.md, 2026-09-04)
// on gpt-5.4-mini. Ported 2026-09-07.
//
// v7 replaced v6 wholesale. What v6 did that produced false accusations:
// a 0.6 confidence FLOOR, "NEVER return NEUTRAL because the connection requires
// inference", an asymmetric cloture/passage precedence, and `Prior LLM
// Reasoning` in the payload — which anchored this step on the relevance step's
// conclusion. All four are gone. Do not reintroduce any of them "for coverage":
// each one exists in the audit as a specific false accusation about a real
// senator.
//
// NEW IN v7: a `same_object` gate (same object, not merely the same policy
// lane) that short-circuits to NEUTRAL, and a CONTESTED bill effect for cases
// where the direction IS the partisan dispute. Both route to NOT_DETERMINABLE.
//
// This is the axis where disagreement with the corpus is most damaging: it
// decides ADVANCE / HINDER / NEUTRAL, and the verdict follows directly from
// that. Hence the same model as the batch pipeline, deliberately not Anthropic
// — the handoff lists "consolidate to single-vendor" as a tempting mistake.
//
// It is a DIFFERENT question from relevance. Relevance asks "is this bill about
// the promise at all"; fulfillment asks "which way does it push the goal".
// Different prompt, different node, different length.
//
// NOTE ON CONFIDENCE: the prompt instructs a −0.1 penalty for Policy Positions
// and forbids confidence >= 0.9 for them. That penalty is applied by the MODEL,
// per the prompt. Never re-apply it in code — it would double-count, which is
// the same class of bug as re-applying stance in deriveAlignment.
// ===========================================================================

export type BillEffect = 'ADVANCE' | 'HINDER' | 'NEUTRAL' | 'CONTESTED';
export type FulfillmentAlignment =
  | 'KEPT'
  | 'BROKE'
  | 'CONSISTENT'
  | 'INCONSISTENT'
  | 'NOT_DETERMINABLE'
  | 'PROCEDURAL_SWITCH';

const KNOWN_EFFECTS = new Set<string>(['ADVANCE', 'HINDER', 'NEUTRAL', 'CONTESTED']);
const KNOWN_ALIGNMENTS = new Set<string>([
  'KEPT',
  'BROKE',
  'CONSISTENT',
  'INCONSISTENT',
  'NOT_DETERMINABLE',
  'PROCEDURAL_SWITCH',
]);

export interface FulfillmentCandidate {
  statement_type: string;
  promise_uid: string;
  promise_text: string;
  promise_stance: string;
  promise_primary_issue: string;
  promise_sub_issue: string;

  bill_id: string;
  bill_impact_uid?: string;
  action_uid?: string;
  bill_title: string;
  bill_summary: string;
  bill_primary_issue: string;
  bill_sub_issue: string;
  bill_intended_effects?: string;
  bill_mechanisms?: string;
  affected_stakeholders?: Array<{
    stakeholder_group?: string;
    positive_impacts?: string;
    negative_impacts?: string;
  }>;

  reverses_existing_policy?: string;
  target_name?: string;
  target_source?: string;
  target_effect?: string;

  vote: string;
  cloture_vote?: string;
  cloture_vote_date?: string;
  passage_vote?: string;
  passage_vote_date?: string;
  is_sponsor: string;
  is_cosponsor: string;

  // ---- v7 context. Produced by the scope classifier and the pre-evaluator
  // gates. Every one of these is OPTIONAL and renders as an explicit UNKNOWN /
  // NA / none when absent — the prompt is written to treat a missing field as
  // "not established", never as a licence to assume the permissive value.
  promise_date?: string;
  scope?: string;
  valid_until?: string;
  anchor_entity?: string;
  role_condition?: string;
  match_verdict?: string;
  partial_subtype?: string;
  temporal_reference?: string;
  bill_congress?: string;
  bill_class?: string;
  senator_role?: string;
  cloture_result?: string;
  party_whip_vote?: string;
  party_alignment?: string;
  action_date?: string;
  vote_flags?: string;
}

/**
 * REMOVED IN v7: `prior_llm_reasoning`.
 *
 * v6 passed the relevance step's reasoning into this payload as "for reference
 * only". It was not treated as reference — it anchored the fulfilment call on a
 * conclusion reached while answering a different question ("is this bill about
 * the statement" vs "which way does it push the goal"). fix/07 removes it from
 * the payload entirely.
 *
 * A caller that still sets it fails to compile: object-literal excess-property
 * checking rejects the unknown key against `FulfillmentCandidate`. There is a
 * test asserting the string does not appear in the built message, because the
 * compiler cannot catch a template that reinstates it by hand.
 */

export interface FulfillmentResult {
  bill_effect: BillEffect | 'ERROR';
  /**
   * The MODEL's verdict. Recorded for agreement tracking only — it is NEVER the
   * verdict (contract 1). `deriveAlignment` decides from bill_effect + votes.
   */
  alignment: FulfillmentAlignment | 'ERROR';
  reasoning: string;
  confidence: number;
  /**
   * v7 STEP 0. False means the bill is in the same policy lane but acts on a
   * different object, which the prompt routes to NEUTRAL -> NOT_DETERMINABLE.
   * Undefined on an older or malformed response.
   */
  same_object?: boolean;
  /** v7 disclosure flags: SPLIT_VOTE, BROAD_VEHICLE, IMPACT_CONFLICT, … */
  flags: string[];
  /** v7 `governing_vote`, kept for the disclosure line. */
  governing_vote?: string;
  error?: string;
}

export interface EvaluatedFulfillment {
  action_uid: string;
  result: FulfillmentResult;
}

const S = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const or = (v: unknown, fallback: string): string => S(v) || fallback;

export function fulfillmentErrorResult(message: string): FulfillmentResult {
  return {
    bill_effect: 'ERROR',
    alignment: 'ERROR',
    reasoning: message,
    confidence: 0,
    flags: [],
    error: message,
  };
}

/**
 * Hand port of the node's user template (an n8n expression, so it cannot be
 * extracted verbatim the way the system prompt can).
 *
 * The extractor asserts that template's length, so an upstream edit fails
 * generation and forces a re-read of this function rather than silently
 * leaving the port describing a message the node no longer sends.
 */
export function buildFulfillmentUserMessage(c: FulfillmentCandidate): string {
  const stakeholders =
    c.affected_stakeholders && c.affected_stakeholders.length
      ? c.affected_stakeholders
          .map(
            (sg) =>
              `  • ${or(sg.stakeholder_group, 'Unspecified')} — Positive: ${or(
                sg.positive_impacts,
                'none stated',
              )}; Negative: ${or(sg.negative_impacts, 'none stated')}`,
          )
          .join('\n')
      : '  • N/A — no stakeholder data available';

  // Field-for-field mirror of the v7 USER template
  // (docs/fix/07_wf10a_evaluator_prompt_v7.md, "## USER"). The n8n original is
  // an expression, so it cannot be extracted the way the system prompt is —
  // this is a hand port and the field ORDER is part of it.
  //
  // Note what is NOT here: no "## PRIOR EVALUATION CONTEXT", and no TASK
  // section restating the rules. v6 had both. The task restatement drifted from
  // the system prompt (it still said bill_effect was one of three values after
  // CONTESTED was added), and a user message that contradicts the system
  // message is resolved by the model, not by us.
  return `Evaluate whether this senator's legislative action is evidence about the statement below, following the system rules. Use ONLY the information provided.

## STATEMENT
- Statement Type: ${S(c.statement_type)}
- Statement UID: ${S(c.promise_uid)}
- Statement: ${S(c.promise_text)}
- Stance: ${S(c.promise_stance)}
- Primary / Sub Issue: ${S(c.promise_primary_issue)} / ${S(c.promise_sub_issue)}
- Date made: ${or(c.promise_date, 'unknown')}
- Scope: ${or(c.scope, 'UNKNOWN')}${S(c.valid_until) ? ` (valid until ${S(c.valid_until)})` : ''}
- Anchor entity: ${or(c.anchor_entity, 'none')}
- Role condition: ${or(c.role_condition, 'UNKNOWN')}
- Relevance step: match verdict ${or(c.match_verdict, 'NA')}, partial subtype ${or(
    c.partial_subtype,
    'NA',
  )}, temporal reference ${or(c.temporal_reference, 'NA')}

## BILL
- Bill ID: ${S(c.bill_id)} (${or(c.bill_congress, '?')}th Congress)
- Bill class: ${or(c.bill_class, 'UNKNOWN')}
- Title: ${S(c.bill_title)}
- Summary (may reflect sponsor framing): ${S(c.bill_summary)}
- Primary / Sub Issue: ${S(c.bill_primary_issue)} / ${S(c.bill_sub_issue)}

## BILL IMPACT ANALYSIS
- Intended Effects: ${S(c.bill_intended_effects)}
- Mechanisms: ${S(c.bill_mechanisms)}
- Affected Stakeholders:
${stakeholders}

## REVERSAL TARGET (only meaningful when Reverses Existing Policy is true)
- Reverses Existing Policy: ${or(c.reverses_existing_policy, 'false')}
- Target Name: ${or(c.target_name, 'N/A')}
- Target Source: ${or(c.target_source, 'N/A')}
- Target Effect: ${or(c.target_effect, 'N/A')}

## SENATOR'S ACTION
- Senator role at the time: ${or(c.senator_role, 'UNKNOWN')}
- Cloture Vote: ${or(c.cloture_vote, 'NA')} on ${or(c.cloture_vote_date, 'NA')} — result: ${or(
    c.cloture_result,
    'UNKNOWN',
  )}
- Passage Vote: ${or(c.passage_vote, 'NA')} on ${or(c.passage_vote_date, 'NA')}
- Party whip's vote: ${or(c.party_whip_vote, 'NA')} — party alignment: ${or(
    c.party_alignment,
    'NA',
  )}
- Is Sponsor: ${S(c.is_sponsor)} · Is Co-Sponsor: ${S(c.is_cosponsor)}
- Action date: ${or(c.action_date, 'unknown')}
- Vote flags: ${or(c.vote_flags, 'none')}

Return the JSON specified in the system message.`;
}

/** Byte-mirror of the request WF10A posts, with the model read from config. */
export function buildFulfillmentRequest(c: FulfillmentCandidate): ResponsesRequestBody {
  // Guard the prompt at request time as well as at generation time: a hand-edit
  // to the generated file would otherwise change how every bill is judged with
  // nothing failing.
  if (EVALUATOR_SYSTEM_PROMPT.length !== EVALUATOR_SYSTEM_PROMPT_LENGTH) {
    throw new Error(
      `[FULFILLMENT] System prompt is ${EVALUATOR_SYSTEM_PROMPT.length} chars, ` +
        `expected ${EVALUATOR_SYSTEM_PROMPT_LENGTH}. Regenerate with ` +
        `tools/extract-fix-prompt.mjs evaluator rather than editing the file.`,
    );
  }

  return {
    model: config.models.fulfill,
    input: [
      { role: 'system', content: EVALUATOR_SYSTEM_PROMPT },
      { role: 'user', content: buildFulfillmentUserMessage(c) },
    ],
    // Bumped with the prompt, per the fix bundle's apply order. Leaving it at
    // v1 would serve cached v6 completions for v7 requests.
    prompt_cache_key: EVALUATOR_SYSTEM_PROMPT_VERSION,
    reasoning: { effort: 'low' },
    top_p: 0.98,
    store: true,
  };
}

/**
 * Parse the evaluator's JSON.
 *
 * Carries forward the relevance leg's unknown-value assertion: an unrecognised
 * `bill_effect` or `alignment` becomes ERROR rather than being coerced. A new
 * label silently coerced to NEUTRAL would read as "this bill doesn't bear on
 * the promise" — an answer, not an error.
 */
export function parseFulfillmentResponse(text: string | null | undefined): FulfillmentResult {
  const raw = S(text);
  if (!raw) return fulfillmentErrorResult('Fulfillment evaluator returned an empty message.');

  let parsed: Record<string, unknown>;
  try {
    const fenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    parsed = JSON.parse(fenced) as Record<string, unknown>;
  } catch {
    return fulfillmentErrorResult(`Fulfillment evaluator returned non-JSON: ${raw.slice(0, 200)}`);
  }

  const effect = S(parsed.bill_effect).toUpperCase();
  if (!KNOWN_EFFECTS.has(effect)) {
    return fulfillmentErrorResult(
      `Fulfillment evaluator returned an unknown bill_effect "${parsed.bill_effect}". ` +
        `Expected one of ${[...KNOWN_EFFECTS].join(', ')}.`,
    );
  }

  const alignment = S(parsed.alignment ?? parsed.promise_alignment).toUpperCase();
  if (!KNOWN_ALIGNMENTS.has(alignment)) {
    return fulfillmentErrorResult(
      `Fulfillment evaluator returned an unknown alignment "${parsed.alignment}". ` +
        `Expected one of ${[...KNOWN_ALIGNMENTS].join(', ')}.`,
    );
  }

  // §3: `alignment_confidence` can legitimately hold the string NOT_EVALUATED
  // on a gated row, and Number('NOT_EVALUATED') is NaN. Guarding to 0 here is
  // correct for THIS path — a row that reached the evaluator was not gated, so
  // a non-numeric confidence is a malformed response, not a marker.
  const confRaw = Number(parsed.confidence ?? parsed.alignment_confidence);
  const confidence = Number.isFinite(confRaw) ? confRaw : 0;

  // v7 STEP 0 short-circuits to NEUTRAL when the objects differ. Recorded
  // rather than re-derived: if the model said same_object:false but returned a
  // directional effect, that disagreement is visible instead of resolved.
  const sameObject =
    typeof parsed.same_object === 'boolean' ? parsed.same_object : undefined;

  const flags = Array.isArray(parsed.flags)
    ? parsed.flags.map((f) => S(f)).filter(Boolean)
    : [];

  return {
    bill_effect: effect as BillEffect,
    alignment: alignment as FulfillmentAlignment,
    reasoning: S(parsed.alignment_reasoning ?? parsed.reasoning),
    confidence,
    same_object: sameObject,
    flags,
    governing_vote: S(parsed.governing_vote) || undefined,
  };
}

export type ResponsesFetcher = (body: ResponsesRequestBody) => Promise<ResponsesEnvelope>;

/**
 * Evaluate every admitted candidate. Independent per candidate, so parallel.
 *
 * A failed call becomes an ERROR result for that candidate rather than failing
 * the batch — and ERROR is not NEUTRAL: downstream, an ERROR effect routes to
 * the ERROR outcome, it does not quietly become "no effect".
 */
export async function evaluateFulfillment(
  candidates: FulfillmentCandidate[],
  fetcher: ResponsesFetcher,
  opts: { concurrency?: number } = {},
): Promise<EvaluatedFulfillment[]> {
  const concurrency = opts.concurrency ?? 10;
  const out: EvaluatedFulfillment[] = new Array(candidates.length);
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= candidates.length) return;
      const candidate = candidates[i]!;
      const uid = S(candidate.action_uid);
      try {
        const envelope = await fetcher(buildFulfillmentRequest(candidate));
        // Reuses the relevance normaliser precisely for the reasoning-item
        // trap: reasoning is on, so output[0] is a reasoning item and the
        // message must be found by type, never by index.
        const { text } = normalizeRelevanceResponse(envelope);
        out[i] = { action_uid: uid, result: parseFulfillmentResponse(text) };
      } catch (e) {
        out[i] = { action_uid: uid, result: fulfillmentErrorResult((e as Error).message) };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));

  if (out.length !== candidates.length || out.some((r) => r === undefined)) {
    throw new Error(
      `evaluateFulfillment emitted ${out.filter(Boolean).length} results for ` +
        `${candidates.length} candidates — rows were lost.`,
    );
  }

  return out;
}
