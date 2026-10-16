import Anthropic from '@anthropic-ai/sdk';
import { ANSWER_LABEL_COPY, type DirectedAction, type Envelope, type RecordAnswer, type StreamEvent } from '@receipts/shared';
import { config } from '../config.js';
import { anthropicContent, anthropicUsage, traceBegin, traceStep } from '../trace/Trace.js';
import { answerLabel } from '../scoring/answerLabel.js';
import { stubBillEffects, stubInterpretation } from '../llm/stub.js';
import { dispatchTool, type QuerySession } from './dispatch.js';
import { RECORD_EXPLANATION_CONSTRAINTS } from './prompts.js';
import { TOOL_DEFINITIONS } from './toolDefs.js';

// ===========================================================================
// The record-question pipeline: "Did they vote to extend the enhanced ACA tax
// credits?"
//
// A fixed sequence of the same tools the orchestrator calls, in the same
// order, run in code: the order never changes, so the model turns that chose
// it bought nothing, and their system prompt ("a voter has asked whether this
// senator kept a promise") is the framing a question must never get.
//
//   interpret -> resolve -> embed -> search (with the relevance gate)
//   -> evaluate (enrichment, text versions, the vote and vehicle gates, the
//      bill-effect evaluator; no scope check and no judge)
//   -> the answer label (code) -> one explanation call -> the result
//
// The evaluator reads each bill against the action the question names, as a
// neutral goal. The scorer still runs inside evaluate_effects, so each bill
// carries its effect and votes, but its verdict and band are never shown or
// stored for a record question: the label below is the answer.
// ===========================================================================

type Emit = (event: StreamEvent) => void;
type RunTool = (session: QuerySession, emit: Emit, name: string, input: Record<string, unknown>) => Promise<Envelope<unknown>>;

export { ANSWER_LABEL_COPY };

/** Each evidence row as the label rules read it. */
function answerFor(session: QuerySession): RecordAnswer {
  const evidence: DirectedAction[] = session.scored?.evidence ?? [];
  return answerLabel(
    evidence.map((e) => ({
      action_uid: e.action_uid,
      bill_id: String(e.bill_id ?? ''),
      bill_effect: e.bill_effect,
      cloture_vote: e.cloture_vote,
      passage_vote: e.passage_vote,
      vote: e.vote,
      is_sponsor: e.is_sponsor,
      is_cosponsor: e.is_cosponsor,
      bill_class: e.bill_class ?? null,
    })),
    session.gated?.length ?? 0,
  );
}

/** What the explainer is given: the question, the label, and each bill's facts. */
export function recordFacts(session: QuerySession, answer: RecordAnswer): Record<string, unknown> {
  const byUid = new Map((session.scored?.evidence ?? []).map((e) => [e.action_uid, e]));
  return {
    question: session.promiseText,
    asked_about: session.interpretation?.restated ?? null,
    senator: session.senator?.name ?? null,
    answer_label: answer.label,
    answer_line: ANSWER_LABEL_COPY[answer.label],
    answer_reason: answer.reason,
    bills: [...new Set(answer.rows.map((r) => r.action_uid))].map((uid) => {
      const e = byUid.get(uid);
      return {
        action_uid: uid,
        bill_id: e?.bill_id ?? null,
        title: e?.title ?? null,
        summary: e?.summary ?? null,
        bill_effect: e?.bill_effect ?? null,
        bill_effect_reasoning: e?.bill_effect_reasoning ?? null,
        bill_class: e?.bill_class ?? null,
        record: e?.record ?? null,
        stages: answer.rows
          .filter((r) => r.action_uid === uid)
          .map((r) => ({
            stage: r.stage === 'cloture' ? 'vote to end debate' : r.stage === 'passage' ? 'final vote' : r.stage,
            vote: r.vote,
            reading: r.reading,
            broad_package: r.broad,
          })),
        vote_context: e?.vote_context?.map((t) => ({
          stage: t.stage === 'cloture' ? 'vote to end debate' : 'final vote',
          yea: t.yea, nay: t.nay, not_voting: t.not_voting, result: t.result_text, passed: t.passed,
          votes_needed: t.threshold === '3/5' ? 60 : t.threshold === '2/3' ? 67 : null,
          by_party: t.by_party, senator_vote: t.senator_vote,
          senator_party_majority: t.party_majority, senator_with_party_majority: t.with_party,
        })),
      };
    }),
    set_aside: (session.gated ?? []).map((g) => ({ bill_id: g.bill_id, title: g.title, reason: g.reason })),
  };
}

/**
 * A fact-only fallback, used when no model is available or no draft passed
 * the checks. It says only what the label and the rows say.
 */
export function plainRecordExplanation(session: QuerySession, answer: RecordAnswer): string {
  const q = session.promiseText.trim();
  const surname = String(session.senator?.name ?? 'The senator').split(/\s+/).pop()!;
  const lines = [`You asked: "${q}"`];
  if (answer.reason === 'TOO_BROAD') {
    lines.push('This question is too broad to check against specific bills. Try naming a specific bill, program or policy.');
  } else if (answer.reason === 'NOTHING_FOUND') {
    lines.push(`We found no recorded vote or bill by ${surname} on this in the record we cover.`);
  } else if (answer.reason === 'NOTHING_COUNTED') {
    lines.push(`We found bills on this, but none of them clearly does what you asked about. Each one is listed below with the reason.`);
  } else {
    lines.push(`${ANSWER_LABEL_COPY[answer.label]} The bills and each vote are listed below.`);
  }
  return lines.join(' ');
}

const EXPLAIN_TOOL = (TOOL_DEFINITIONS as unknown as Anthropic.Tool[]).find((t) => t.name === 'explain_result')!;
const MAX_EXPLAIN_ATTEMPTS = 3;

/**
 * One explanation call (two more only when the checks send a draft back).
 * True when a draft was accepted and stored on the session.
 */
async function explainRecord(session: QuerySession, answer: RecordAnswer): Promise<boolean> {
  if (!config.anthropic.apiKey) return false;
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `Here is the record for the voter's question. Write the answer with explain_result.\n\n${JSON.stringify(recordFacts(session, answer), null, 2)}`,
    },
  ];
  for (let attempt = 1; attempt <= MAX_EXPLAIN_ATTEMPTS; attempt += 1) {
    const end = traceBegin();
    let message: Anthropic.Message;
    try {
      message = await client.messages.create({
        model: config.models.explain,
        max_tokens: config.anthropic.maxTokens,
        system: RECORD_EXPLANATION_CONSTRAINTS,
        tools: [EXPLAIN_TOOL],
        tool_choice: { type: 'tool', name: 'explain_result' },
        messages,
      });
    } catch (err) {
      end({
        stage: 'ORCHESTRATOR_TURN', kind: 'model', status: 'error', label: `record explanation call ${attempt} failed`,
        model: config.models.explain, prompt_version: 'record-explanation-v1', prompt_text: RECORD_EXPLANATION_CONSTRAINTS,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    end({
      stage: 'ORCHESTRATOR_TURN', kind: 'model', label: `record explanation · attempt ${attempt} · stop_reason=${message.stop_reason ?? 'none'}`,
      model: config.models.explain, prompt_version: 'record-explanation-v1', prompt_text: RECORD_EXPLANATION_CONSTRAINTS,
      usage: anthropicUsage(message.usage),
      input: { attempt },
      output: { stop_reason: message.stop_reason, content: anthropicContent(message.content) },
    });
    const call = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!call) return false;
    const env = await dispatchTool(session, 'explain_result', call.input as Record<string, unknown>);
    if (env.ok) return true;
    // Sent back with the checks' reasons, like the orchestrator's drafts.
    messages.push({ role: 'assistant', content: message.content });
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: call.id, is_error: true, content: env.error.message }],
    });
  }
  return false;
}

/** The record question, end to end. Emits the same events a statement does, plus `result.record`. */
export async function runRecordQuestion(
  session: QuerySession,
  emit: Emit,
  deps: { runTool: RunTool; finish: (s: QuerySession, e: Emit) => boolean },
): Promise<void> {
  session.inputKind = 'RECORD_QUESTION';
  const fail = (env: Envelope<unknown>) => {
    if (!env.ok) emit({ type: 'error', error: env.error });
  };

  const interpreted = await deps.runTool(session, emit, 'interpret_promise', config.demoMode ? { ...stubInterpretation(session.promiseText) } : {});
  if (!interpreted.ok) return fail(interpreted);

  const resolved = await deps.runTool(session, emit, 'resolve_senator', { politician_id: session.politicianId });
  if (!resolved.ok) return fail(resolved);
  if (session.uncached && session.senator) {
    await deps.runTool(session, emit, 'queue_senator', {});
    emit({ type: 'uncached', senator: session.senator, queued: session.queued });
    return;
  }

  let answer: RecordAnswer;
  if (session.interpretation && !session.interpretation.is_evaluable) {
    // Too broad to hold against a bill: say so, rather than search.
    const scored = await deps.runTool(session, emit, 'evaluate_effects', { effects: [] });
    if (!scored.ok) return fail(scored);
    answer = { label: 'NO_RECORDED_ACTION_FOUND', reason: 'TOO_BROAD', rows: [], counted: { for: 0, against: 0 }, set_aside: 0 };
  } else {
    const embedded = await deps.runTool(session, emit, 'embed_text', {});
    if (!embedded.ok) return fail(embedded);
    const searched = await deps.runTool(session, emit, 'search_actions', {});
    if (!searched.ok) return fail(searched);
    // No orchestrator reading to pass: the fulfillment evaluator is the
    // authority on each bill. In demo mode, with no evaluator, the stub reads.
    const effects = config.demoMode
      ? stubBillEffects(session.matches ?? [], {
          primary_issue: session.interpretation!.primary_issue,
          sub_issue: session.interpretation!.sub_issue,
          stance: session.interpretation!.stance,
        })
      : [];
    const scored = await deps.runTool(session, emit, 'evaluate_effects', { effects });
    if (!scored.ok) return fail(scored);
    answer = answerFor(session);
  }

  session.record = answer;
  traceStep({
    stage: 'RECORD_ANSWER', kind: 'deterministic',
    label: `${answer.label} · ${answer.reason} · ${answer.counted.for} for / ${answer.counted.against} against · ${answer.rows.length} row(s) · ${answer.set_aside} set aside`,
    input: { evidence: (session.scored?.evidence ?? []).map((e) => ({ uid: e.action_uid, effect: e.bill_effect, cloture: e.cloture_vote, passage: e.passage_vote, vote: e.vote, bill_class: e.bill_class ?? null })) },
    output: answer,
  });

  const explained = config.demoMode ? false : await explainRecord(session, answer);
  if (!explained) {
    session.explanation = { why: plainRecordExplanation(session, answer), connectors: {}, confidence: 0.5 };
    traceStep({ stage: 'EXPLAIN_CHECK', kind: 'deterministic', label: 'no accepted draft: the plain fact sentence is shown', output: session.explanation });
  }

  if (!deps.finish(session, emit)) {
    emit({ type: 'error', error: { code: 'INTERNAL', message: 'Could not assemble a result.', recoverable: true } });
  }
}
