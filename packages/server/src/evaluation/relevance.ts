/**
 * Relevance evaluation — port of W7b's live chain:
 *
 *   Build Eval Request -> Match Evaluation (HTTP) -> Normalize Eval Response
 *   -> Parse LLM Response
 *
 * Verified against dwO2OT2iRpR7bCov on 2026-08-17 (published; versionId ==
 * activeVersionId). Three things the build spec did not state and a port will
 * get wrong without them:
 *
 *  1. The model is `gpt-5.4-mini` on the RESPONSES endpoint (/v1/responses),
 *     not chat/completions, with `reasoning: { effort: 'low' }`,
 *     `top_p: 0.98`, `store: true`.
 *  2. Because reasoning is on, `output[0]` is a REASONING item and the message
 *     sits at `output[1]`. W7b has a whole node whose only job is to find the
 *     message by `type` and re-emit it at index 0, because the parser reads
 *     index 0 with a hardcoded index. Reading `output[0].content[0].text`
 *     directly yields undefined and every row becomes an ERROR verdict while
 *     the HTTP call reports 200.
 *  3. SYSTEM goes FIRST and is byte-static. Prefix caching only works when the
 *     leading tokens are identical across calls. Do not reorder.
 *
 * The user block below mirrors `buildUser` in the live node exactly, including
 * its `|| 'NA'` fallbacks and its duplicated TAXONOMY LABELS section.
 */

import {
  RELEVANCE_SYSTEM_PROMPT,
  RELEVANCE_PROMPT_CACHE_KEY,
  RELEVANCE_MODEL,
} from './relevancePrompt.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type YesNoNA = 'Yes' | 'No' | 'NA';
export type RelevanceVerdict = 'TRUE_POSITIVE' | 'FALSE_POSITIVE' | 'PARTIAL' | 'ERROR';
export type ActionType = 'VOTE' | 'SPONSORSHIP' | 'NONE' | 'ERROR';

/**
 * One retrieved candidate, assembled from the Pinecone match plus the
 * classified query. Field names mirror `Parse and Store Matches` in W7a so the
 * two legs stay diff-able.
 *
 * NOTE: every bill/action field here is available in Pinecone vector metadata
 * (see W7a's `Trim Matches` KEEP list). The relevance step needs NO sheet
 * reads — see the note in evidenceGate.ts about deferring enrichment.
 */
export interface RelevanceCandidate {
  // promise / query side (from the classifier + user input)
  promise_uid: string;
  promise_text: string;
  promise_stance: string;
  promise_type: string;
  promise_primary_issue: string;
  promise_sub_issue: string;
  key_policy_terms: string;
  promise_date: string;

  // bill side (Pinecone metadata)
  bill_id: string;
  bill_title: string;
  bill_summary: string;
  bill_intended_effects?: string;
  bill_mechanisms?: string;
  bill_primary_issue: string;
  bill_sub_issue: string;
  bill_impact_uid?: string;
  action_uid?: string;

  // senator action (Pinecone metadata)
  is_sponsor: string; // 'TRUE' | 'FALSE' | 'NA'
  is_cosponsor: string;
  vote: string;
  vote_id: string;
  cloture_vote?: string;
  cloture_vote_id?: string;
  passage_vote?: string;
  passage_vote_id?: string;

  // match context
  similarity_score: number;
  match_direction: string;
  match_rank: number;
}

export interface RelevanceResult {
  action_type: ActionType;
  topic_relevant: YesNoNA | 'ERROR';
  action_relevant: YesNoNA | 'ERROR';
  effort_relevant: YesNoNA | 'ERROR';
  specificity_match: YesNoNA | 'ERROR';
  no_vote_available: boolean;
  verdict: RelevanceVerdict;
  reasoning: string;
  confidence: number;
  /** Mirrors W7b's calculateCompositeScore. Reporting only — nothing gates on it. */
  composite_score: number;
  /** LLM_EVALUATED | NEEDS_REVIEW | ERROR */
  evaluation_status: 'LLM_EVALUATED' | 'NEEDS_REVIEW' | 'ERROR';
  /** ACCEPTED | ACCEPTED_SPONSORSHIP | REJECTED | NEEDS_HUMAN_REVIEW | PENDING */
  terminal_status:
    | 'ACCEPTED'
    | 'ACCEPTED_SPONSORSHIP'
    | 'REJECTED'
    | 'NEEDS_HUMAN_REVIEW'
    | 'PENDING';
  /** Present when the call or parse failed. */
  error?: string;
}

export interface EvaluatedCandidate extends RelevanceCandidate {
  relevance: RelevanceResult;
}

export interface ResponsesRequestBody {
  model: string;
  input: Array<{ role: 'system' | 'user'; content: string }>;
  prompt_cache_key: string;
  reasoning: { effort: 'low' };
  top_p: number;
  store: boolean;
}

// ---------------------------------------------------------------------------
// 1. Request
// ---------------------------------------------------------------------------

/** Byte-mirror of `buildUser` in W7b's Build Eval Request. */
export function buildRelevanceUserMessage(j: RelevanceCandidate): string {
  return `Evaluate this promise-bill match:

## CAMPAIGN PROMISE
**Promise UID:** ${j.promise_uid}
**Statement:** ${j.promise_text}
**Stance:** ${j.promise_stance}
**Promise Type:** ${j.promise_type}
**Policy Area:** ${j.promise_primary_issue} / ${j.promise_sub_issue}
**Key Policy Terms:** ${j.key_policy_terms}
**Date Made:** ${j.promise_date}

## BILL
**Bill ID:** ${j.bill_id}
**Title:** ${j.bill_title}
**Summary:** ${j.bill_summary}
**Intended Effects:** ${j.bill_intended_effects || 'NA'}
**Mechanisms:** ${j.bill_mechanisms || 'NA'}
**Policy Area:** ${j.bill_primary_issue} / ${j.bill_sub_issue}

## SENATOR'S INVOLVEMENT WITH THIS BILL
**Is Sponsor:** ${j.is_sponsor}
**Is Co-Sponsor:** ${j.is_cosponsor}
**Cloture Vote:** ${j.cloture_vote || 'NA'} (roll call ${j.cloture_vote_id || 'NA'})
**Passage Vote:** ${j.passage_vote || 'NA'} (roll call ${j.passage_vote_id || 'NA'})
**Resolved Primary Vote:** ${j.vote} (roll call ${j.vote_id})

## MATCH CONTEXT
**Semantic Similarity Score:** ${j.similarity_score}
**Match Direction:** ${j.match_direction}
**Match Rank:** ${j.match_rank}

## TAXONOMY LABELS
These labels are assigned independently to bills and to promises, by different
classification steps and from different source vocabularies. Genuinely related
items routinely carry different labels. Treat a difference here as no evidence
either way, and judge relevance from the bill and promise text.

- **Bill:** ${j.bill_primary_issue} / ${j.bill_sub_issue}
- **Promise:** ${j.promise_primary_issue} / ${j.promise_sub_issue}

---

Evaluate whether this bill is relevant for assessing if the senator kept this promise. Return your evaluation in the JSON format specified in the system message.
`;
}

/** Byte-mirror of the request body W7b posts to /v1/responses. */
export function buildRelevanceRequest(candidate: RelevanceCandidate): ResponsesRequestBody {
  return {
    model: RELEVANCE_MODEL,
    input: [
      { role: 'system', content: RELEVANCE_SYSTEM_PROMPT },
      { role: 'user', content: buildRelevanceUserMessage(candidate) },
    ],
    prompt_cache_key: RELEVANCE_PROMPT_CACHE_KEY,
    reasoning: { effort: 'low' },
    top_p: 0.98,
    store: true,
  };
}

// ---------------------------------------------------------------------------
// 2. Normalize — find the message by TYPE, never by position
// ---------------------------------------------------------------------------

export interface ResponsesEnvelope {
  output?: Array<{ type?: string; content?: Array<{ text?: string }> }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
  status?: string;
  incomplete_details?: unknown;
}

export interface RelevanceUsage {
  input_tokens: number;
  cached_tokens: number;
  cache_hit_rate: number;
  output_tokens: number;
  reasoning_tokens: number;
}

/**
 * Returns the assistant message text plus usage. Throws rather than returning a
 * shape the parser would mis-read — W7b's node does the same, deliberately:
 * a missing message item means the envelope changed, not that the model
 * declined to answer.
 */
export function normalizeRelevanceResponse(
  envelope: ResponsesEnvelope
): { text: string; usage: RelevanceUsage } {
  const arr = Array.isArray(envelope.output) ? envelope.output : [];
  const msg = arr.find((o) => o && o.type === 'message');

  if (!msg) {
    const types = arr.map((o) => o && o.type).join(', ') || '(empty output array)';
    throw new Error(
      `[EVAL HTTP] No message item in the Responses output. Saw: ${types}. ` +
        `status=${envelope.status ?? 'unknown'} ` +
        `incomplete=${JSON.stringify(envelope.incomplete_details ?? null)}`
    );
  }

  const u = envelope.usage ?? {};
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  const inputTokens = u.input_tokens ?? 0;

  return {
    text: msg.content?.[0]?.text ?? '',
    usage: {
      input_tokens: inputTokens,
      cached_tokens: cached,
      cache_hit_rate: inputTokens ? Math.round((cached / inputTokens) * 1000) / 10 : 0,
      output_tokens: u.output_tokens ?? 0,
      reasoning_tokens: u.output_tokens_details?.reasoning_tokens ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Parse
// ---------------------------------------------------------------------------

/** Mirrors W7b's calculateCompositeScore. Reporting only. */
function calculateCompositeScore(parsed: Record<string, unknown>): number {
  const actionType = String(parsed.action_type ?? '').toUpperCase();
  const scores: number[] = [];
  const push = (v: unknown) => {
    const s = String(v ?? '');
    if (s && s.toLowerCase() !== 'na') scores.push(s.toLowerCase() === 'yes' ? 1 : 0);
  };

  push(parsed.topic_relevant);
  if (actionType === 'VOTE') push(parsed.action_relevant);
  else if (actionType === 'SPONSORSHIP') push(parsed.effort_relevant);
  push(parsed.specificity_match);

  return scores.length
    ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100
    : 0;
}

function resolveEvaluationStatus(
  verdict: string | undefined,
  confidence: number
): RelevanceResult['evaluation_status'] {
  if (!verdict || verdict === 'ERROR') return 'ERROR';
  const v = verdict.toUpperCase();
  if (v === 'PARTIAL') return 'NEEDS_REVIEW';
  if (confidence < 0.7) return 'NEEDS_REVIEW';
  return 'LLM_EVALUATED';
}

function resolveTerminalStatus(
  verdict: string | undefined,
  noVoteAvailable: boolean
): RelevanceResult['terminal_status'] {
  const v = String(verdict ?? '').toUpperCase();
  if (v === 'TRUE_POSITIVE' && !noVoteAvailable) return 'ACCEPTED';
  if (v === 'TRUE_POSITIVE' && noVoteAvailable) return 'ACCEPTED_SPONSORSHIP';
  if (v === 'FALSE_POSITIVE') return 'REJECTED';
  if (v === 'PARTIAL') return 'NEEDS_HUMAN_REVIEW';
  return 'PENDING';
}

const KNOWN_VERDICTS = new Set(['TRUE_POSITIVE', 'FALSE_POSITIVE', 'PARTIAL']);

function errorResult(message: string): RelevanceResult {
  return {
    action_type: 'ERROR',
    topic_relevant: 'ERROR',
    action_relevant: 'ERROR',
    effort_relevant: 'ERROR',
    specificity_match: 'ERROR',
    no_vote_available: false,
    verdict: 'ERROR',
    reasoning: message,
    confidence: 0,
    composite_score: 0,
    evaluation_status: 'ERROR',
    terminal_status: 'PENDING',
    error: message,
  };
}

/**
 * Parse one model response. Never throws — an unparseable response becomes an
 * ERROR verdict, which the evidence gate excludes. Silent success on a broken
 * response is the failure mode this pipeline keeps paying for; an ERROR row is
 * visible in the assertion counts.
 */
export function parseRelevanceResponse(text: string | null | undefined): RelevanceResult {
  if (!text) return errorResult('No response text received from the relevance evaluator.');

  const cleanJson = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleanJson) as Record<string, unknown>;
  } catch (e) {
    return errorResult(
      `Relevance response was not valid JSON: ${(e as Error).message}. ` +
        `First 200 chars: ${cleanJson.slice(0, 200)}`
    );
  }

  const rawVerdict = String(parsed.verdict ?? '').toUpperCase();
  if (!KNOWN_VERDICTS.has(rawVerdict)) {
    // ASSERTION (build spec §5, "verdict in the known vocabulary"). A new label
    // leaking through would sail past the evidence gate's `verdict === PARTIAL`
    // test and be silently dropped with no counter incremented.
    return errorResult(
      `Relevance evaluator returned an unknown verdict "${parsed.verdict}". ` +
        `Expected one of TRUE_POSITIVE, FALSE_POSITIVE, PARTIAL.`
    );
  }

  const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
  const noVoteAvailable = parsed.no_vote_available === true;

  return {
    action_type: (String(parsed.action_type ?? 'NONE').toUpperCase() as ActionType) ?? 'NONE',
    topic_relevant: (parsed.topic_relevant as YesNoNA) ?? 'NA',
    action_relevant: (parsed.action_relevant as YesNoNA) ?? 'NA',
    effort_relevant: (parsed.effort_relevant as YesNoNA) ?? 'NA',
    specificity_match: (parsed.specificity_match as YesNoNA) ?? 'NA',
    no_vote_available: noVoteAvailable,
    verdict: rawVerdict as RelevanceVerdict,
    reasoning: String(parsed.reasoning ?? ''),
    confidence,
    composite_score: calculateCompositeScore(parsed),
    evaluation_status: resolveEvaluationStatus(rawVerdict, confidence),
    terminal_status: resolveTerminalStatus(rawVerdict, noVoteAvailable),
  };
}

// ---------------------------------------------------------------------------
// 4. Driver — parallel, because sequential is the latency problem
// ---------------------------------------------------------------------------

export type ResponsesFetcher = (body: ResponsesRequestBody) => Promise<ResponsesEnvelope>;

/**
 * What one evaluation looked like on the wire, for the query trace.
 *
 * Fired once per candidate, AFTER the result is parsed, whether the call
 * succeeded or threw. `envelope` is the raw response when there was one;
 * `error` is the transport or normalisation failure when there was not. The
 * parsed `result` is what the gate will see, so a reader can put the raw text
 * and the parse side by side.
 */
export interface EvaluationObservation<C, R> {
  candidate: C;
  request: ResponsesRequestBody;
  envelope: ResponsesEnvelope | null;
  rawText: string | null;
  error: string | null;
  durationMs: number;
  result: R;
}

export interface EvaluateRelevanceOptions {
  /** Cap on concurrent calls. 10 candidates at topK 10 → one wave. */
  concurrency?: number;
  /** Trace hook. Must not throw; a throwing observer is swallowed and logged. */
  observe?: (o: EvaluationObservation<RelevanceCandidate, RelevanceResult>) => void;
}

/** Call an observer without letting it disturb the evaluation. */
export function notify<T>(observe: ((o: T) => void) | undefined, o: T): void {
  if (!observe) return;
  try {
    observe(o);
  } catch (err) {
    console.error('[trace] observer threw (non-fatal):', err instanceof Error ? err.message : err);
  }
}

/**
 * Evaluates every candidate. Independent per candidate, so they run in
 * parallel — this is item 4 on the build list and it is what takes the
 * relevance leg from ~40s to ~4s.
 *
 * A rejected call becomes an ERROR result rather than failing the batch: one
 * bad candidate should not deny the user the other nine.
 */
export async function evaluateRelevance(
  candidates: RelevanceCandidate[],
  fetcher: ResponsesFetcher,
  opts: EvaluateRelevanceOptions = {}
): Promise<EvaluatedCandidate[]> {
  const concurrency = opts.concurrency ?? 10;
  const out: EvaluatedCandidate[] = new Array(candidates.length);
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= candidates.length) return;
      // Non-null: the loop bound guarantees this index exists. Asserted rather
      // than guarded so a genuine hole still trips the post-loop assertion.
      const candidate = candidates[i]!;
      const request = buildRelevanceRequest(candidate);
      const t0 = Date.now();
      let envelope: ResponsesEnvelope | null = null;
      let rawText: string | null = null;
      try {
        envelope = await fetcher(request);
        const { text } = normalizeRelevanceResponse(envelope);
        rawText = text;
        out[i] = { ...candidate, relevance: parseRelevanceResponse(text) };
        notify(opts.observe, {
          candidate, request, envelope, rawText, error: null,
          durationMs: Date.now() - t0, result: out[i]!.relevance,
        });
      } catch (e) {
        out[i] = { ...candidate, relevance: errorResult((e as Error).message) };
        notify(opts.observe, {
          candidate, request, envelope, rawText, error: (e as Error).message,
          durationMs: Date.now() - t0, result: out[i]!.relevance,
        });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length) }, worker)
  );

  // ASSERTION (build spec §5): admitted ≤ candidates is checked downstream;
  // here we only guarantee no candidate was dropped.
  if (out.length !== candidates.length || out.some((r) => r === undefined)) {
    throw new Error(
      `evaluateRelevance emitted ${out.filter(Boolean).length} results for ` +
        `${candidates.length} candidates — rows were lost.`
    );
  }

  return out;
}
