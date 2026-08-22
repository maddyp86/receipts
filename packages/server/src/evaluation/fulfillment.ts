import {
  FULFILLMENT_SYSTEM_PROMPT,
  FULFILLMENT_SYSTEM_PROMPT_LENGTH,
} from './fulfillmentPrompt.js';
import type { ResponsesEnvelope, ResponsesRequestBody } from './relevance.js';
import { normalizeRelevanceResponse } from './relevance.js';
import { config } from '../config.js';

// ===========================================================================
// FULFILLMENT — the bill_effect leg.
//
// PORT of WF10A `Promise Alignment Evaluator` (BuA0XMoRIeA8K-IziChwR), which
// runs the 32,507-char prompt in fulfillmentPrompt.ts on gpt-5.4-mini.
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

export type BillEffect = 'ADVANCE' | 'HINDER' | 'NEUTRAL';
export type FulfillmentAlignment =
  | 'KEPT'
  | 'BROKE'
  | 'CONSISTENT'
  | 'INCONSISTENT'
  | 'NOT_DETERMINABLE';

const KNOWN_EFFECTS = new Set<string>(['ADVANCE', 'HINDER', 'NEUTRAL']);
const KNOWN_ALIGNMENTS = new Set<string>([
  'KEPT',
  'BROKE',
  'CONSISTENT',
  'INCONSISTENT',
  'NOT_DETERMINABLE',
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

  prior_llm_reasoning?: string;
}

export interface FulfillmentResult {
  bill_effect: BillEffect | 'ERROR';
  alignment: FulfillmentAlignment | 'ERROR';
  reasoning: string;
  confidence: number;
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

  return `Evaluate whether this senator's legislative action aligns with the statement below, following the evaluation rules defined in the system message.

Use ONLY the information provided below. Do not infer intent or treat unrelated legislative action as evidence of betrayal.

## STATEMENT
- Statement Type: ${S(c.statement_type)}
- Statement UID: ${S(c.promise_uid)}
- Statement: ${S(c.promise_text)}
- Stance: ${S(c.promise_stance)}
- Primary Issue: ${S(c.promise_primary_issue)}
- Sub Issue: ${S(c.promise_sub_issue)}

## BILL
- Bill ID: ${S(c.bill_id)}
- Impact UID: ${S(c.bill_impact_uid)}
- Action ID: ${S(c.action_uid)}
- Title: ${S(c.bill_title)}
- Summary: ${S(c.bill_summary)}
- Bill Primary Issue: ${S(c.bill_primary_issue)}
- Bill Sub Issue: ${S(c.bill_sub_issue)}

## BILL IMPACT ANALYSIS
- Intended Effects: ${S(c.bill_intended_effects)}
- Mechanisms: ${S(c.bill_mechanisms)}
- Affected Stakeholders (all groups):
${stakeholders}

## REVERSAL TARGET (only meaningful when Reverses Existing Policy is true)
- **Reverses Existing Policy:** ${or(c.reverses_existing_policy, 'false')}
- **Target Name:** ${or(c.target_name, 'N/A')}
- **Target Source:** ${or(c.target_source, 'N/A')}
- **Target Effect:** ${or(c.target_effect, 'N/A')}

## SENATOR'S ACTION
- Vote: ${S(c.vote)}
- Cloture Vote: ${or(c.cloture_vote, 'NA')}  (procedural: did debate end so the bill could proceed)
- Cloture Vote Date: ${or(c.cloture_vote_date, 'NA')}
- Passage Vote: ${or(c.passage_vote, 'NA')}  (substantive: enact the bill)
- Passage Vote Date: ${or(c.passage_vote_date, 'NA')}
- Is Sponsor: ${S(c.is_sponsor)}
- Is Co-Sponsor: ${S(c.is_cosponsor)}

## PRIOR EVALUATION CONTEXT
- Prior LLM Reasoning (for reference only): ${S(c.prior_llm_reasoning)}

## TASK

1. Determine the **Bill Effect** on the statement's policy goal:
   - ADVANCE, HINDER, or NEUTRAL  
   (If the bill does not meaningfully affect the statement's goal, it MUST be labeled NEUTRAL.)

2. Determine the **Alignment** using the correct verdict labels for the Statement Type:
   - If Statement Type = "Campaign Promise": KEPT | BROKE | NOT_DETERMINABLE
   - If Statement Type = "Policy Position": CONSISTENT | INCONSISTENT | NOT_DETERMINABLE
     (apply the -0.1 confidence penalty per the system rules; maximum confidence is 0.9)

3. Provide concise reasoning that explicitly explains the logical chain:
   Statement → Bill Effect → Senator Action → Outcome

4. Assign a confidence score consistent with the clarity of the connection.  
   High confidence is not permitted for NEUTRAL or weakly related cases.

Return your answer strictly in the JSON format specified in the system message.`;
}

/** Byte-mirror of the request WF10A posts, with the model read from config. */
export function buildFulfillmentRequest(c: FulfillmentCandidate): ResponsesRequestBody {
  // Guard the prompt at request time as well as at generation time: a hand-edit
  // to the generated file would otherwise change how every bill is judged with
  // nothing failing.
  if (FULFILLMENT_SYSTEM_PROMPT.length !== FULFILLMENT_SYSTEM_PROMPT_LENGTH) {
    throw new Error(
      `[FULFILLMENT] System prompt is ${FULFILLMENT_SYSTEM_PROMPT.length} chars, ` +
        `expected ${FULFILLMENT_SYSTEM_PROMPT_LENGTH}. Regenerate with ` +
        `tools/extract-fulfillment-prompt.mjs rather than editing the file.`,
    );
  }

  return {
    model: config.models.fulfill,
    input: [
      { role: 'system', content: FULFILLMENT_SYSTEM_PROMPT },
      { role: 'user', content: buildFulfillmentUserMessage(c) },
    ],
    prompt_cache_key: 'promise-alignment-v1',
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
        `Expected one of ADVANCE, HINDER, NEUTRAL.`,
    );
  }

  const alignment = S(parsed.alignment ?? parsed.promise_alignment).toUpperCase();
  if (!KNOWN_ALIGNMENTS.has(alignment)) {
    return fulfillmentErrorResult(
      `Fulfillment evaluator returned an unknown alignment "${parsed.alignment}". ` +
        `Expected one of ${[...KNOWN_ALIGNMENTS].join(', ')}.`,
    );
  }

  const confRaw = Number(parsed.confidence ?? parsed.alignment_confidence);
  const confidence = Number.isFinite(confRaw) ? confRaw : 0;

  return {
    bill_effect: effect as BillEffect,
    alignment: alignment as FulfillmentAlignment,
    reasoning: S(parsed.reasoning),
    confidence,
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
