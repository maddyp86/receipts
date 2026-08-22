import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { formatTaxonomyForPrompt, isValidCombination } from '../embeddings/taxonomy.js';
import { TOOL_DEFINITIONS } from '../orchestrator/toolDefs.js';

// ===========================================================================
// CLASSIFICATION — the interpret_promise leg.
//
// A DEDICATED call on config.models.classify (claude-haiku-4-5), not the
// orchestrating model's own judgement. Same move as the fulfillment leg, for a
// related but distinct reason:
//
//   fulfillment — parity with the model that scored the corpus.
//   classification — parity with the corpus LABELS. The stored issue pairs were
//     produced by GPT-4.1. A classifier that drifts to a neighbouring sub-issue
//     changes the embedded text, which changes the query VECTOR, which changes
//     the candidate set. The failure surfaces as "no relevant bills" — an
//     answer, not an error.
//
// There is NO live classifier prompt to port. `IVUmoD8pG4E5M8D0` is inactive,
// its Claude classifier node is disabled, and its user-message template has a
// known typo; the corpus was classified with GPT-4.1 outside it. So this prompt
// is written here rather than extracted, and is marked as such — unlike the
// relevance and fulfillment prompts, it is NOT a transcription of a live node
// and carries no length assertion, because there is nothing upstream to assert
// against.
// ===========================================================================

const interpretTool = TOOL_DEFINITIONS.find((t) => t.name === 'interpret_promise')!;

/**
 * Output ceiling for the classify call — deliberately NOT config.anthropic.maxTokens.
 *
 * That value (64000) is sized for the EXPLAIN LOOP, which streams and shares its
 * budget with adaptive thinking. This call is a single non-streamed
 * `messages.create` returning one forced tool_use block of roughly a dozen short
 * fields, and the SDK rejects a non-streaming request whose max_tokens implies a
 * >10 minute operation:
 *
 *   "Streaming is required for operations that may take longer than 10 minutes."
 *
 * So the two ceilings are not interchangeable, and reusing the loop's here made
 * every live classification fail. 4000 is far more than this output needs and
 * far below the streaming threshold.
 */
const CLASSIFY_MAX_TOKENS = 4000;

export const CLASSIFY_SYSTEM_PROMPT = `You are a nonpartisan legislative analyst classifying a policy statement so it can be matched against a senator's recorded legislative actions.

Classify the statement the user supplies. Call the \`interpret_promise\` tool exactly once. Do not answer in prose.

## THE TAXONOMY IS CLOSED

You MUST choose a (Primary Issue, Sub Issue) pair from the approved taxonomy below, reproduced EXACTLY as written — same spelling, same spacing, same punctuation. "Health Care" is not "Healthcare". "Guns / Gun Control" is not "Gun Control".

A pair outside this list is rejected by the server. If nothing fits well, choose the closest pair that is genuinely on the statement's subject rather than inventing a label, and say so in \`reasoning\`.

If the statement is too vague to check against legislation at all, set \`is_evaluable\` to false. Do NOT guess a category to fill the field — an invented category injects that subject's vocabulary into the search and manufactures confident matches on a topic nobody asked about.

## STANCE

\`stance\` is what the statement WANTS, not how it is phrased. "Protect", "preserve" and "defend" mean the speaker wants the thing to continue — that is In Favor of that goal, not opposition.

## KEY POLICY TERMS

Specific vocabulary from the statement itself — named bills, programs, mechanisms, agencies. Never generic words like "legislation", "Americans", or "reform".

## APPROVED TAXONOMY

${formatTaxonomyForPrompt()}`;

export interface ClassifyResult {
  input: Record<string, unknown>;
  model: string;
  /** False when the returned pair is not in the approved taxonomy. */
  inTaxonomy: boolean;
}

export class ClassifyUnavailableError extends Error {
  readonly code = 'MISSING_CREDENTIAL';
  constructor() {
    super(
      'Classification requires ANTHROPIC_API_KEY, which is not set. Refusing to ' +
        'fabricate a classification: an invented issue pair moves the query vector ' +
        'and produces confident matches on the wrong subject.',
    );
    this.name = 'ClassifyUnavailableError';
  }
}

export type ClassifyFetcher = (promiseText: string) => Promise<Record<string, unknown>>;

/**
 * The live transport. Forces the `interpret_promise` tool so the result is a
 * validated object rather than prose to re-parse.
 */
export function liveClassifyFetcher(): ClassifyFetcher {
  return async (promiseText: string) => {
    if (!config.anthropic.apiKey) throw new ClassifyUnavailableError();

    const client = new Anthropic({ apiKey: config.anthropic.apiKey });
    const message = await client.messages.create({
      model: config.models.classify,
      max_tokens: CLASSIFY_MAX_TOKENS,
      system: CLASSIFY_SYSTEM_PROMPT,
      tools: [interpretTool as unknown as Anthropic.Tool],
      tool_choice: { type: 'tool', name: 'interpret_promise' },
      messages: [{ role: 'user', content: promiseText }],
    });

    if (message.stop_reason === 'max_tokens') {
      throw new Error('Classifier hit its output ceiling — the classification is incomplete.');
    }

    const block = message.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'interpret_promise',
    );
    if (!block) {
      throw new Error(
        `Classifier returned no interpret_promise tool call (stop_reason=${message.stop_reason}).`,
      );
    }
    return block.input as Record<string, unknown>;
  };
}

/**
 * Classify, and report whether the result landed inside the approved taxonomy.
 *
 * `inTaxonomy` is REPORTED, never silently repaired. Snapping a near-miss to
 * the closest valid pair would hide exactly the drift the 12-row check exists
 * to measure.
 */
export async function classifyPromise(
  promiseText: string,
  fetcher: ClassifyFetcher = liveClassifyFetcher(),
): Promise<ClassifyResult> {
  const input = await fetcher(promiseText);
  const primary = String(input.primary_issue ?? '').trim();
  const sub = String(input.sub_issue ?? '').trim();
  return {
    input,
    model: config.models.classify,
    // An is_evaluable:false result legitimately carries no pair.
    inTaxonomy: input.is_evaluable === false ? true : isValidCombination(primary, sub),
  };
}
