import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { JUDGE_SYSTEM_PROMPT, JUDGE_SYSTEM_PROMPT_VERSION } from './judgePrompt.js';
import type { JudgeGateHit } from './judgeGates.js';

// ===========================================================================
// THE ADVERSARIAL JUDGE.
//
// SOURCE: docs/fix/12_wf13_judge_system_prompt.md for the prompt; the live WF13
// workflow (92pe8N4vmUdoXlFc, nodes `Judge (Sonnet) 1` / `Parse Judge 1`) for
// the request shape and the parser. Ported 2026-09-07.
//
// Every accusation gets a second opinion before it counts. The judge grades
// whether a verdict is DEFENSIBLE; it does not re-evaluate the statement.
//
// ── ANTHROPIC API SPECIFICS (handoff v2 §5) ───────────────────────────────
// These cost real debugging time upstream. Do not rediscover them:
//
//   * `claude-sonnet-5` REJECTS `temperature` — 400, "deprecated for this
//     model". Send only model, max_tokens, system, messages. The live workflow
//     still sets temperature inside its judge_body object and strips it at the
//     HTTP node; this port never constructs the key at all.
//   * `max_tokens: 1200` IS NOT ENOUGH. The model spent the whole budget on a
//     thinking block, emitted no text, and returned stop_reason: max_tokens.
//     Use 8000.
//   * Response content CAN BE THINKING BLOCKS. Filter for type === 'text'; if
//     that yields nothing it is an infrastructure failure, not a verdict.
//   * NEVER LET AN EMPTY RESPONSE BECOME A CONTENT VERDICT. The first version
//     wrote FAIL / T7 / HALLUCINATED_LINK for a response that said nothing —
//     a fabricated accusation in the audit log.
// ===========================================================================

/** See the header. 1200 produced thinking-only responses with no text. */
const JUDGE_MAX_TOKENS = 8000;

export type JudgeGrade = 'PASS' | 'FAIL' | 'ERROR';

export interface JudgeVerdict {
  grade: JudgeGrade;
  failed_test: string;
  failure_class: string;
  corrected_verdict: string;
  corrected_bill_effect: string;
  corrected_confidence: number | null;
  senator_counterargument: string;
  gate_agreement: string;
  gold_agreement: string;
  critique: string;
  model: string;
  prompt_version: string;
}

/** What the judge is asked to grade. */
export interface JudgeInput {
  statement_text: string;
  statement_type: string;
  scope?: string | null;
  valid_until?: string | null;
  anchor_entity?: string | null;
  role_condition?: string | null;
  promise_date?: string | null;
  bill_id: string;
  bill_title: string;
  bill_summary?: string | null;
  bill_class?: string | null;
  intended_effects?: string | null;
  mechanisms?: string | null;
  stakeholders?: string | null;
  reverses_existing_policy?: string | null;
  target_effect?: string | null;
  cloture_vote?: string | null;
  cloture_vote_date?: string | null;
  cloture_result?: string | null;
  passage_vote?: string | null;
  passage_vote_date?: string | null;
  party_whip_vote?: string | null;
  party_alignment?: string | null;
  senator_role?: string | null;
  is_sponsor?: string | null;
  is_cosponsor?: string | null;
  action_date?: string | null;
  vote_flags?: string[] | null;
  vote_governing?: string | null;
  /** The evaluator's outputs — graded, never trusted as evidence. */
  bill_effect: string;
  bill_effect_reasoning?: string | null;
  verdict: string;
  alignment_reasoning?: string | null;
  confidence: number | null;
  /** Output of the deterministic gates. Confirmed or disputed, not re-derived. */
  gate_results: JudgeGateHit[];
}

const S = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const or = (v: unknown, fallback: string): string => S(v) || fallback;

/**
 * The user message.
 *
 * The gate results are included so the judge confirms or disputes them rather
 * than re-deriving — the prompt says as much. `gold` is omitted entirely: a
 * user-typed statement has no regression row to compare against, and an empty
 * gold block would invite the model to invent one.
 */
export function buildJudgeUserMessage(c: JudgeInput): string {
  const gates = c.gate_results.length
    ? c.gate_results.map((g) => `- ${g.gate} / ${g.class}: ${g.detail}`).join('\n')
    : '- none fired';

  return `Grade the verdict below.

## STATEMENT
- Text: ${S(c.statement_text)}
- Statement Type: ${S(c.statement_type)}
- Date made: ${or(c.promise_date, 'unknown')}
- Scope: ${or(c.scope, 'UNKNOWN')}${S(c.valid_until) ? ` (valid until ${S(c.valid_until)})` : ''}
- Anchor entity: ${or(c.anchor_entity, 'none')}
- Role condition: ${or(c.role_condition, 'UNKNOWN')}

## BILL
- Bill ID: ${S(c.bill_id)}
- Bill class: ${or(c.bill_class, 'UNKNOWN')}
- Title: ${S(c.bill_title)}
- Summary (may reflect sponsor framing): ${or(c.bill_summary, 'NA')}
- Intended Effects: ${or(c.intended_effects, 'NA')}
- Mechanisms: ${or(c.mechanisms, 'NA')}
- Affected Stakeholders: ${or(c.stakeholders, 'NA')}
- Reverses Existing Policy: ${or(c.reverses_existing_policy, 'false')}
- Target Effect: ${or(c.target_effect, 'NA')}

## SENATOR'S ACTION
- Senator role at the time: ${or(c.senator_role, 'UNKNOWN')}
- Cloture Vote: ${or(c.cloture_vote, 'NA')} on ${or(c.cloture_vote_date, 'NA')} — result: ${or(c.cloture_result, 'UNKNOWN')}
- Passage Vote: ${or(c.passage_vote, 'NA')} on ${or(c.passage_vote_date, 'NA')}
- Party whip's vote: ${or(c.party_whip_vote, 'NA')} — party alignment: ${or(c.party_alignment, 'NA')}
- Is Sponsor: ${or(c.is_sponsor, 'NA')} · Is Co-Sponsor: ${or(c.is_cosponsor, 'NA')}
- Action date: ${or(c.action_date, 'unknown')}
- Vote flags: ${c.vote_flags?.length ? c.vote_flags.join(';') : 'none'}
- Governing vote: ${or(c.vote_governing, 'NA')}

## THE VERDICT YOU ARE GRADING
- bill_effect: ${S(c.bill_effect)}
- bill_effect_reasoning: ${or(c.bill_effect_reasoning, 'NA')}
- verdict: ${S(c.verdict)}
- alignment_reasoning: ${or(c.alignment_reasoning, 'NA')}
- confidence: ${c.confidence === null ? 'NOT_EVALUATED' : c.confidence}

## GATE RESULTS
${gates}

Return the JSON specified in the system message.`;
}

/** Strips a ```json fence, then falls back to the first {...} block. */
function parseJudgeJson(raw: string): Record<string, unknown> | null {
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const m = /\{[\s\S]*\}/.exec(cleaned);
    if (!m) return null;
    try {
      return JSON.parse(m[0]) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

/** An infrastructure failure, never a finding about the row. */
export function judgeErrorVerdict(reason: string): JudgeVerdict {
  return {
    grade: 'ERROR',
    failed_test: '',
    failure_class: 'JUDGE_NO_OUTPUT',
    corrected_verdict: '',
    corrected_bill_effect: '',
    corrected_confidence: null,
    senator_counterargument: '',
    gate_agreement: '',
    gold_agreement: '',
    critique: reason,
    model: config.models.judge,
    prompt_version: JUDGE_SYSTEM_PROMPT_VERSION,
  };
}

/**
 * Parse an Anthropic response into a verdict.
 *
 * Port of WF13's `Parse Judge 1`, including the distinction between a
 * thinking-only response, an empty one, and unparseable output — all three are
 * JUDGE_NO_OUTPUT, but the critique says which, because "raise max_tokens" and
 * "the model returned prose" need different fixes.
 */
export function parseJudgeResponse(message: {
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string | null;
}): JudgeVerdict {
  const blocks = Array.isArray(message.content) ? message.content : [];
  const raw = blocks
    .filter((b) => b.type === 'text')
    .map((b) => S(b.text))
    .join('');
  const stop = S(message.stop_reason);
  const thinkingOnly = blocks.length > 0 && blocks.every((b) => b.type === 'thinking');

  if (!raw) {
    return judgeErrorVerdict(
      thinkingOnly || stop === 'max_tokens'
        ? `judge produced no text (stop_reason=${stop || 'none'}${thinkingOnly ? ', thinking-only response' : ''}) — raise max_tokens`
        : `judge returned an empty response (stop_reason=${stop || 'none'})`,
    );
  }

  const p = parseJudgeJson(raw);
  if (!p) {
    return judgeErrorVerdict(`judge output was not valid JSON: ${raw.slice(0, 200)}`);
  }

  let grade: JudgeGrade = U(p.grade) === 'PASS' ? 'PASS' : 'FAIL';
  let failedTest = S(p.failed_test);
  let failureClass = S(p.failure_class);
  let critique = S(p.critique);

  // A PASS IS INVALID WITHOUT A COUNTERARGUMENT. The prompt says so ("if you
  // cannot think of one, you have not looked hard enough"), and the parser
  // enforces it rather than trusting compliance: a pass with no stated
  // counterargument has not actually been tested against the senator's reply.
  if (grade === 'PASS' && !S(p.senator_counterargument)) {
    grade = 'FAIL';
    failureClass = 'UNDISCLOSED_CAVEAT';
    failedTest = 'T6';
    critique = `${critique} [PASS without counterargument -> FAIL]`.trim();
  }

  const conf = Number(p.corrected_confidence);

  return {
    grade,
    failed_test: failedTest,
    failure_class: failureClass,
    corrected_verdict: S(p.corrected_verdict),
    corrected_bill_effect: S(p.corrected_bill_effect),
    corrected_confidence: Number.isFinite(conf) ? conf : null,
    senator_counterargument: S(p.senator_counterargument),
    gate_agreement: S(p.gate_agreement),
    gold_agreement: S(p.gold_agreement) || 'NO_GOLD',
    critique,
    model: config.models.judge,
    prompt_version: JUDGE_SYSTEM_PROMPT_VERSION,
  };
}

const U = (v: unknown): string => S(v).toUpperCase();

export class JudgeUnavailableError extends Error {
  readonly code = 'MISSING_CREDENTIAL';
  constructor() {
    super(
      'The verdict judge requires ANTHROPIC_API_KEY, which is not set. Refusing to ' +
        'publish an unjudged accusation: without the second opinion there is nothing ' +
        'standing between the evaluator and a public claim about a senator.',
    );
    this.name = 'JudgeUnavailableError';
  }
}

export type JudgeFetcher = (input: JudgeInput) => Promise<JudgeVerdict>;

export function liveJudgeFetcher(): JudgeFetcher {
  return async (input) => {
    if (!config.anthropic.apiKey) throw new JudgeUnavailableError();

    const client = new Anthropic({ apiKey: config.anthropic.apiKey });
    // NOTE the absence of `temperature`. claude-sonnet-5 400s on it; this is
    // not an omission to be tidied up.
    const message = await client.messages.create({
      model: config.models.judge,
      max_tokens: JUDGE_MAX_TOKENS,
      system: JUDGE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildJudgeUserMessage(input) }],
    });

    return parseJudgeResponse(message as Parameters<typeof parseJudgeResponse>[0]);
  };
}

/**
 * Judge one row, turning any transport failure into JUDGE_NO_OUTPUT.
 *
 * A thrown request is infrastructure, exactly like an empty response, and must
 * not become a finding about the senator.
 */
export async function judgeVerdict(
  input: JudgeInput,
  fetcher: JudgeFetcher = liveJudgeFetcher(),
): Promise<JudgeVerdict> {
  try {
    return await fetcher(input);
  } catch (err) {
    return judgeErrorVerdict(
      `judge call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
