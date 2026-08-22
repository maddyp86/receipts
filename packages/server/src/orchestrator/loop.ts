import Anthropic from '@anthropic-ai/sdk';
import type { QueryResult, StepId, StreamEvent, ToolError } from '@receipts/shared';
import { config } from '../config.js';
import { dispatchTool, newSession, type QuerySession } from './dispatch.js';
import { queryStore } from '../services.js';
import type { StoredAlignment, StoredMatch } from '../data/QueryStore.js';
import { derivePartialSubtype } from '../evaluation/evidenceGate.js';
import type { Corrections } from '@receipts/shared';
import { systemPrompt, EXPLANATION_CONSTRAINTS } from './prompts.js';
import { TOOL_DEFINITIONS } from './toolDefs.js';
import { stubBillEffects, stubExplanation, stubInterpretation } from '../llm/stub.js';

// ===========================================================================
// The orchestration loop.
//
// A workflow, not an autonomous agent (ADR-008, docs/adr/README.md): a fixed sequence over data we
// already have, so a Messages API tool-use loop is the right-sized primitive and
// deploys anywhere. Hand-rolled rather than using the SDK's tool runner because
// we own the wire format to the browser and want no beta dependency on what will
// be an ordinary stateless function.
//
// What the model streams is NARRATION. The verdict the user sees is read from
// `session.scored` — the deterministic service's output — no matter what the
// model says. That is the difference between this and a chatbot with citations.
// ===========================================================================

const MAX_ITERATIONS = 12;

const STEP_FOR_TOOL: Record<string, StepId> = {
  interpret_promise: 'interpret',
  resolve_senator: 'resolve_senator',
  embed_text: 'embed',
  search_actions: 'search',
  evaluate_effects: 'score',
  explain_result: 'explain',
};

const STEP_LABEL: Record<StepId, string> = {
  interpret: 'Reading your promise',
  resolve_senator: 'Checking coverage for this senator',
  embed: 'Preparing the search',
  search: 'Searching their record',
  score: 'Weighing the evidence',
  explain: 'Writing it up',
};

export type Emit = (event: StreamEvent) => void;

function detailFor(tool: string, env: { ok: boolean; data?: unknown }): string | undefined {
  if (!env.ok) return undefined;
  const d = env.data as Record<string, unknown> | undefined;
  switch (tool) {
    case 'search_actions': {
      const n = Number(d?.count ?? 0);
      return n === 0 ? 'no related actions found' : `found ${n} related ${n === 1 ? 'action' : 'actions'}`;
    }
    case 'embed_text':
      return `${d?.dimensions ?? '?'} dimensions`;
    case 'evaluate_effects':
      return 'verdict computed';
    default:
      return undefined;
  }
}

/** Run one tool, narrating it to the client as it resolves. */
async function runTool(
  session: QuerySession,
  emit: Emit,
  name: string,
  input: Record<string, unknown>,
) {
  const step = STEP_FOR_TOOL[name];
  if (step) emit({ type: 'step', id: step, label: STEP_LABEL[step], status: 'running' });

  const env = await dispatchTool(session, name, input);

  if (step) {
    emit({
      type: 'step',
      id: step,
      label: STEP_LABEL[step],
      status: env.ok ? 'done' : 'error',
      detail: env.ok ? detailFor(name, env) : env.error.message,
    });
  }

  if (name === 'interpret_promise' && env.ok && session.interpretation) {
    emit({ type: 'interpretation', interpretation: session.interpretation });
  }

  return env;
}

/** Assemble the user-facing result from server-held state, never from prose. */
function finish(session: QuerySession, emit: Emit): boolean {
  if (!session.senator || !session.interpretation || !session.scored) return false;

  const result: QueryResult = {
    senator: session.senator,
    interpretation: session.interpretation,
    scored: session.scored,
    explanation: session.explanation ?? {
      why: '',
      connectors: {},
      confidence: 0,
    },
    demo_mode: config.demoMode,
    fixture_mode: config.fixtureMode,
  };
  // Stashed so persistence stores exactly what the user saw, rather than
  // rebuilding it later from parts that may have moved on.
  session.result = result;
  emit({ type: 'result', result });
  return true;
}

// ---------------------------------------------------------------------------
// Demo path — same handlers, same validation, deterministic judgements.
// ---------------------------------------------------------------------------

async function runDemo(session: QuerySession, emit: Emit): Promise<void> {
  const interpretation = stubInterpretation(session.promiseText);
  await runTool(session, emit, 'interpret_promise', { ...interpretation });

  const resolved = await runTool(session, emit, 'resolve_senator', {
    politician_id: session.politicianId,
  });
  if (!resolved.ok) {
    emit({ type: 'error', error: resolved.error });
    return;
  }
  if (session.uncached && session.senator) {
    await runTool(session, emit, 'queue_senator', {});
    emit({ type: 'uncached', senator: session.senator, queued: session.queued });
    return;
  }

  // Nothing specific enough to check — don't spend a retrieval round trip
  // searching for bills on a subject we couldn't identify.
  if (session.interpretation && !session.interpretation.is_evaluable) {
    const unscored = await runTool(session, emit, 'evaluate_effects', { effects: [] });
    if (!unscored.ok) {
      emit({ type: 'error', error: unscored.error });
      return;
    }
    await runTool(
      session,
      emit,
      'explain_result',
      stubExplanation(session.scored!, session.senator!),
    );
    finish(session, emit);
    return;
  }

  const embedded = await runTool(session, emit, 'embed_text', {});
  if (!embedded.ok) {
    emit({ type: 'error', error: embedded.error });
    return;
  }

  const searched = await runTool(session, emit, 'search_actions', {});
  if (!searched.ok) {
    emit({ type: 'error', error: searched.error });
    return;
  }

  const effects = stubBillEffects(session.matches ?? [], {
    primary_issue: session.interpretation!.primary_issue,
    sub_issue: session.interpretation!.sub_issue,
    stance: session.interpretation!.stance,
  });
  const scored = await runTool(session, emit, 'evaluate_effects', { effects });
  if (!scored.ok) {
    emit({ type: 'error', error: scored.error });
    return;
  }

  await runTool(session, emit, 'explain_result', stubExplanation(session.scored!, session.senator!));

  if (!finish(session, emit)) {
    emit({
      type: 'error',
      error: { code: 'INTERNAL', message: 'Could not assemble a result.', recoverable: true },
    });
  }
}

// ---------------------------------------------------------------------------
// Live path — Messages API tool use.
// ---------------------------------------------------------------------------

async function runLive(session: QuerySession, emit: Emit): Promise<void> {
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: [
        `A voter has asked whether this senator kept a promise.`,
        ``,
        `Senator id: ${session.politicianId}`,
        `Promise, in the voter's own words: "${session.promiseText}"`,
        ``,
        `Run the sequence. When you reach explain_result, follow these constraints:`,
        ``,
        EXPLANATION_CONSTRAINTS,
      ].join('\n'),
    },
  ];

  for (let i = 0; i < MAX_ITERATIONS; i += 1) {
    // Streamed so a long turn never hits an HTTP timeout. Note there is no
    // temperature or top_p here — current models reject them — and no prefill.
    const stream = client.messages.stream({
      model: config.models.explain,
      max_tokens: config.anthropic.maxTokens,
      system: systemPrompt(),
      tools: TOOL_DEFINITIONS as unknown as Anthropic.Tool[],
      messages,
    });

    const message = await stream.finalMessage();

    // Check the stop reason before reading content: a refusal has no usable
    // content and must not be rendered as an answer.
    if (message.stop_reason === 'refusal') {
      emit({
        type: 'error',
        error: {
          code: 'INTERNAL',
          message: 'The model declined to process this request.',
          recoverable: false,
        },
      });
      return;
    }

    // A turn that hit the ceiling is TRUNCATED, not finished. Without this the
    // loop falls through the `!== 'tool_use'` break below and the half-written
    // turn is rendered as a completed answer — a partial explanation reads as a
    // whole one, which is the silent-success shape this project keeps guarding
    // against. Adaptive thinking counts against the same ceiling, so this can
    // fire even when the visible prose is short.
    if (message.stop_reason === 'max_tokens') {
      emit({
        type: 'error',
        error: {
          code: 'INTERNAL',
          message:
            'The model hit its output ceiling mid-turn, so the result is incomplete. ' +
            'Nothing partial is shown.',
          recoverable: true,
          details: { max_tokens: config.anthropic.maxTokens, model: config.models.explain },
        },
      });
      return;
    }

    messages.push({ role: 'assistant', content: message.content });

    if (message.stop_reason !== 'tool_use') break;

    const toolUses = message.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const env = await runTool(
        session,
        emit,
        use.name,
        (use.input ?? {}) as Record<string, unknown>,
      );

      toolResults.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: JSON.stringify(env),
        is_error: !env.ok,
      });

      // The uncached path is terminal: there is no honest answer to give, so we
      // stop rather than letting the loop improvise around it.
      if (use.name === 'resolve_senator' && session.uncached) {
        await runTool(session, emit, 'queue_senator', {});
        if (session.senator) {
          emit({ type: 'uncached', senator: session.senator, queued: session.queued });
        }
        return;
      }
    }

    // All results go back in a single user message — splitting them trains the
    // model out of parallel tool calls.
    messages.push({ role: 'user', content: toolResults });
  }

  if (!finish(session, emit)) {
    emit({
      type: 'error',
      error: {
        code: 'INTERNAL',
        message:
          'The query finished without producing a scored result. Nothing was rendered rather than guessing.',
        recoverable: true,
      },
    });
  }
}

// ---------------------------------------------------------------------------

/**
 * Persist the completed query.
 *
 * BEST EFFORT, ALWAYS. Every failure path here is swallowed after logging: a
 * database problem must never turn a query the user already got an answer to
 * into an error. Persistence is for us, not for them.
 *
 * Runs after the result has been emitted, so it cannot add latency to the
 * answer either.
 */
const S = (v: unknown): string | null =>
  v === null || v === undefined || v === '' ? null : String(v);
const N = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Every retrieved candidate, admitted or not.
 *
 * Built from `session.evaluated` rather than the gate's output, because the
 * gate reports rejections as counts by reason — the rejected ROWS only exist
 * here.
 */
function buildMatches(session: QuerySession): StoredMatch[] {
  const evaluated = session.evaluated ?? [];
  const admittedUids = new Set(
    (session.relevance?.admitted ?? []).map((a) => String(a.action_uid ?? '')),
  );

  return evaluated.map((c) => {
    const r = c.relevance;
    const verdict = String(r.verdict ?? '').toUpperCase();
    const subtype = derivePartialSubtype({
      verdict,
      confidence: r.confidence,
      effort_relevant: r.effort_relevant,
      action_relevant: r.action_relevant,
      specificity_match: r.specificity_match,
    });
    const admitted = admittedUids.has(String(c.action_uid ?? ''));

    return {
      action_uid: String(c.action_uid ?? ''),
      bill_id: String(c.bill_id ?? ''),
      bill_title: String(c.bill_title ?? ''),
      bill_summary: String(c.bill_summary ?? ''),
      bill_primary_issue: String(c.bill_primary_issue ?? ''),
      bill_sub_issue: String(c.bill_sub_issue ?? ''),
      similarity_score: N(c.similarity_score),
      match_strength: null,
      match_rank: N(c.match_rank),
      match_direction: S(c.match_direction),
      vote: S(c.vote),
      cloture_vote: S(c.cloture_vote),
      passage_vote: S(c.passage_vote),
      is_sponsor: S(c.is_sponsor),
      is_cosponsor: S(c.is_cosponsor),
      action_type: S(r.action_type),
      relevance_verdict: S(r.verdict),
      topic_relevant: S(r.topic_relevant),
      action_relevant: S(r.action_relevant),
      effort_relevant: S(r.effort_relevant),
      specificity_match: S(r.specificity_match),
      no_vote_available: typeof r.no_vote_available === 'boolean' ? r.no_vote_available : null,
      confidence: N(r.confidence),
      composite_score: N(r.composite_score),
      evaluation_status: S(r.evaluation_status),
      terminal_status: S(r.terminal_status),
      llm_reasoning: S(r.reasoning),
      admitted,
      partial_subtype: subtype,
      // The gate's own vocabulary, so a stored row reads the same as the
      // counter it was aggregated into.
      exclusion_reason: admitted
        ? null
        : verdict === 'PARTIAL'
          ? `PARTIAL/${subtype}`
          : verdict || 'BLANK',
    };
  });
}

/** The admitted matches that went through fulfillment — the KEPT/BROKE half. */
function buildAlignments(session: QuerySession): StoredAlignment[] {
  const evidence = session.scored?.evidence ?? [];
  const fulfillment = session.fulfillment ?? {};
  const modelEffects = session.orchestratorEffects ?? {};

  return evidence.map((e) => {
    const f = fulfillment[e.action_uid];
    const modelEffect = modelEffects[e.action_uid] ?? null;
    return {
      action_uid: e.action_uid,
      bill_id: String(e.bill_id ?? ''),
      bill_effect: e.bill_effect,
      bill_effect_reasoning: e.bill_effect_reasoning,
      promise_alignment: S(f?.alignment),
      alignment_confidence: N(f?.confidence),
      alignment_reasoning: S(f?.reasoning),
      model_bill_effect: modelEffect,
      // null, not false, when there is nothing to compare — "we did not check"
      // is a different claim from "they disagreed".
      model_agreed: modelEffect ? modelEffect === e.bill_effect : null,
      outcome: S(e.outcome),
      direction: S(e.direction),
      evidence_type: S(e.evidence_type),
      action_tier: S(e.action_tier),
      vote_pattern: S(e.vote_pattern),
      weight: N(e.weight),
      scoring_flags: e.scoring_flags ?? null,
    };
  });
}

async function persist(session: QuerySession, sessionId: string | null): Promise<void> {
  // Nothing worth storing until the promise was at least interpreted. A row
  // with no classification is not a training example, it is noise.
  //
  // Logged rather than returned silently: "no row appeared" and "no row was
  // attempted" look identical in the database, and only one of them is a bug.
  if (!sessionId) {
    console.warn('[persist] skipped — no session id (startSession failed above).');
    return;
  }
  if (!session.interpretation) {
    console.warn(
      `[persist] skipped — query never got past interpretation ` +
        `(uncached senator or an early error). politician=${session.politicianId}`,
    );
    return;
  }

  try {
    await queryStore.saveQuery({
      session_id: sessionId,
      politician_id: session.politicianId,
      promise_text: session.promiseText,
      interpretation: session.interpretation,
      result: session.result ?? null,
      user_asserted_premise: Boolean(session.interpretation.user_asserted_premise),
      models_used: {
        classify: config.models.classify,
        fulfill: config.models.fulfill,
        explain: config.models.explain,
      },
      degraded: {
        demo_mode: config.demoMode,
        fixture_mode: config.fixtureMode,
        relevance_applied: Boolean(session.relevance),
        // `retrieved` counts candidates that CLEARED the WEAK floor. The raw
        // backend count is separate on purpose — conflating them made a thin
        // namespace indistinguishable from a namespace full of dissimilar
        // vectors.
        retrieved: session.evaluated?.length ?? 0,
        pinecone_returned: session.retrieval?.returned ?? null,
        below_floor: session.retrieval?.belowFloor ?? null,
        top_score: session.retrieval?.topScore ?? null,
        top_k: session.retrieval?.topK ?? null,
      },
      matches: buildMatches(session),
      alignments: buildAlignments(session),
    });
    // Only claim a write when one actually happened. NullQueryStore returns a
    // plausible uuid and stores nothing, so an unconditional "stored" here
    // would assert a row that does not exist — the exact silent-success shape
    // this codebase exists to avoid.
    if (queryStore.kind !== 'local') {
      const m = buildMatches(session);
      console.info(
        `[persist] stored query for ${session.politicianId} — ` +
          `${m.length} candidates (${m.filter((x) => x.admitted).length} admitted), ` +
          `${buildAlignments(session).length} alignments`,
      );
    }
  } catch (err) {
    console.error('[persist] query NOT saved (non-fatal):', err instanceof Error ? err.message : err);
  }
}

export async function runQuery(
  politicianId: string,
  promiseText: string,
  emit: Emit,
  corrections?: Corrections,
  meta: { userAgent?: string } = {},
): Promise<void> {
  const session = newSession(politicianId, promiseText, corrections);

  // Opened up front so a query that later fails still has a session to hang
  // off. Best effort, like the write itself.
  let sessionId: string | null = null;
  try {
    sessionId = await queryStore.startSession(meta);
  } catch (err) {
    console.error('[persist] session not opened (non-fatal):', err instanceof Error ? err.message : err);
  }

  try {
    if (config.demoMode) {
      await runDemo(session, emit);
    } else {
      await runLive(session, emit);
    }
  } catch (err) {
    console.error('[loop]', err);
    const error: ToolError = {
      code: 'INTERNAL',
      message: 'Something went wrong while checking this promise.',
      recoverable: true,
      details: { cause: err instanceof Error ? err.message : String(err) },
    };
    emit({ type: 'error', error });
  } finally {
    emit({ type: 'done' });
    // After `done`, so persistence never delays the answer.
    await persist(session, sessionId);
  }
}
