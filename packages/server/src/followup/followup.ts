import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { explanationProblems } from '../orchestrator/dispatch.js';
import type { TraceRecord } from '../trace/TraceStore.js';
import type { TraceStep } from '../trace/Trace.js';
import { QueryTrace, anthropicUsage, type TraceSink } from '../trace/Trace.js';

// ===========================================================================
// FOLLOW-UP QUESTIONS — explain-only.
//
// A reader who has a result in front of them can ask about it: "why didn't
// the safe-storage bill count?", "what does co-sponsoring mean here?", "which
// vote decided this?". The answer comes from the run's own trace — the same
// gate-by-gate record the log sheet renders — and nothing else.
//
// ── THE RULE ───────────────────────────────────────────────────────────────
// The model EXPLAINS the result it is handed. It never produces a new
// verdict, never re-weighs the evidence, never reaches outside this run. A
// question that needs new retrieval ("what about his votes on abortion?")
// gets "that is a new question — run it", not an answer. That keeps the one
// architectural rule intact: the model interprets and explains; code decides.
//
// ── COST AND SCOPE ─────────────────────────────────────────────────────────
// One non-streamed model call per question on the explain model, with a
// compact context (~10–15k tokens) built from the trace's parsed outputs —
// never the raw prompts, which would be ~40k tokens of relevance messages.
// Rate-limited as a query. Nothing is persisted: the exchange lives in the
// reader's tab, and the only record is a trace run of its own, so a bad
// answer can be walked back like any other.
//
// The answer passes through the same wording guard as the explanation
// (no statistics vocabulary, no motive, no contradiction of the verdict,
// statement-type vocabulary). A draft that fails is sent back once with the
// problems; a second failure is refused rather than rendered.
// ===========================================================================

export const FOLLOWUP_MAX_TOKENS = 1500;
export const FOLLOWUP_PROMPT_VERSION = 'followup-v1';

export const FOLLOWUP_SYSTEM_PROMPT = `You are answering a follow-up question from a person who is looking at a finished result from Receipts, a tool that checks a senator's legislative record against a statement the person typed.

You are given the record of how that result was reached: what the person asked, how it was classified, what the search returned, which bills were judged relevant and why, which way each bill pushes the goal and why, what the senator did on each, how it was scored, and what the second-opinion review did. You answer ONLY from that record.

## WHAT YOU DO
- Explain the result. Point at the specific bill, vote, gate or rule the answer turns on, and quote the reasoning the record holds for it.
- Say plainly when the record does not contain the answer. "The record does not say" is a good answer.
- If the question would need a new search, a different senator, a different statement, or a re-scoring — say that it is a new question and that the person should run it as one. Do not guess.

## WHAT YOU NEVER DO
- NEVER produce, change, or second-guess a verdict, a band, a weight, or any number. The result is fixed. If asked "should this be Kept?", explain what the record shows and say the verdict is computed by code from that record, not by you.
- NEVER speculate about the senator's motive, intent, strategy, or beliefs. Describe what was done.
- NEVER use the words score, modifier, points, similarity, threshold, or confidence band.
- USE THE VOCABULARY THE RECORD GIVES YOU. A "Policy Position" is a stated view, not a pledge: the record is consistent with it or runs counter to it, and it is never kept or broken. Only a "Campaign Promise" may be kept or broken.
- Do not invent bills, votes, dates, or provisions that are not in the record.

## VOICE
Plain, conversational, direct. Address the reader. Refer to the senator by surname. Two to five sentences; more only if the question genuinely needs it. No headings, no bullet lists unless listing bills.`;

/** One prior exchange, as the client keeps it. Never persisted server-side. */
export interface FollowupTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface FollowupRequest {
  record: TraceRecord;
  question: string;
  history?: FollowupTurn[];
}

export interface FollowupAnswer {
  answer: string;
  /** True when the model could not phrase an answer within the rules after a retry. */
  refused: boolean;
  /** The run id of the follow-up's own trace, for the reader's trace link. */
  followup_run_id: string;
}

// ---------------------------------------------------------------------------
// Context — the trace, compacted to what an answer can turn on.
// ---------------------------------------------------------------------------

const S = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

function stepsOf(record: TraceRecord, stage: string): TraceStep[] {
  return record.steps.filter((s) => s.stage === stage);
}
function stepOf(record: TraceRecord, stage: string): TraceStep | undefined {
  return stepsOf(record, stage)[0];
}
const out = (s: TraceStep | undefined): Record<string, unknown> =>
  (s?.output && typeof s.output === 'object' ? (s.output as Record<string, unknown>) : {});
const inp = (s: TraceStep | undefined): Record<string, unknown> =>
  (s?.input && typeof s.input === 'object' ? (s.input as Record<string, unknown>) : {});

/**
 * Build the context the model answers from.
 *
 * Parsed outputs and labels only. The raw model prompts in the trace are the
 * bulk of its size and are the evaluators' inputs, not findings; the
 * findings are in the parsed fields, and those are what a reader's question
 * is about.
 */
export function buildFollowupContext(record: TraceRecord): string {
  const { run } = record;
  const lines: string[] = [];

  lines.push(`# The run`, `Run id: ${run.run_id}`, `Senator id: ${run.politician_id}`, `Statement, in the person's words: "${run.promise_text}"`, `Concluded as: ${run.status}`, '');

  const classify = out(stepOf(record, 'CLASSIFY'));
  if (classify.interpretation) {
    const i = classify.interpretation as Record<string, unknown>;
    lines.push(`# How the statement was read`);
    lines.push(`Statement type: ${S(i.statement_type)} (vocabulary: ${S(i.statement_type) === 'Policy Position' ? 'consistent with / runs counter to — never kept or broken' : 'kept / broke'})`);
    lines.push(`Stance: ${S(i.stance)} · Issue: ${S(i.primary_issue)} / ${S(i.sub_issue)} · Promise type: ${S(i.promise_type)} · Evaluable: ${S(i.is_evaluable)}`);
    lines.push(`Paraphrase: ${S(i.restated)}`);
    lines.push(`Key terms: ${Array.isArray(i.key_policy_terms) ? (i.key_policy_terms as unknown[]).join(', ') : ''}`);
    const dis = classify.disagreements as unknown[] | undefined;
    if (dis?.length) lines.push(`Classifier disagreements: ${dis.join(' | ')}`);
    lines.push('');
  }

  const scope = out(stepOf(record, 'SCOPE_CLASSIFY'));
  if (Object.keys(scope).length) {
    lines.push(`# Scope`, `Speech act: ${S(scope.speech_act)} · Scope: ${S(scope.scope)} · Valid until: ${S(scope.valid_until) || 'n/a'} · Anchor: ${S(scope.anchor_entity) || 'none'} · Role condition: ${S(scope.role_condition)}`, '');
  }

  const halt = stepOf(record, 'HALT');
  if (halt) lines.push(`# Halted before retrieval`, halt.label, JSON.stringify(halt.output), '');

  const retrieve = out(stepOf(record, 'RETRIEVE'));
  if (retrieve.candidates) {
    lines.push(`# What the search returned (${S(retrieve.returned)} returned, ${S(retrieve.above_floor)} above the floor, ${S(retrieve.below_floor)} below)`);
    for (const c of retrieve.candidates as Array<Record<string, unknown>>) {
      lines.push(`- ${S(c.bill_id)} (${S(c.bill_number)}) "${S(c.title)}" — sponsor ${S(c.is_sponsor)}, co-sponsor ${S(c.is_cosponsor)}, vote ${S(c.vote)}, cloture ${S(c.cloture_vote)}, passage ${S(c.passage_vote)}, area ${S(c.primary_issue)} / ${S(c.sub_issue)}`);
    }
    const near = retrieve.near_misses as Array<Record<string, unknown>> | undefined;
    if (near?.length) lines.push(`Related but below the floor, never evaluated: ${near.map((n) => `${S(n.bill_id)} "${S(n.title)}"`).join('; ')}`);
    lines.push('');
  }

  const relevance = stepsOf(record, 'RELEVANCE');
  if (relevance.length) {
    lines.push(`# Relevance — is each bill really about the statement? (one evaluator call per bill)`);
    for (const s of relevance) {
      const p = (out(s).parsed ?? {}) as Record<string, unknown>;
      lines.push(`- ${s.label.split(' → ')[0]}: ${S(p.verdict)} (action type ${S(p.action_type)}; topic ${S(p.topic_relevant)}, action ${S(p.action_relevant)}, effort ${S(p.effort_relevant)}, specificity ${S(p.specificity_match)}). Reasoning: ${S(p.reasoning)}`);
    }
    lines.push('');
  }

  const gate = stepOf(record, 'EVIDENCE_GATE');
  if (gate) {
    const g = out(gate);
    lines.push(`# Evidence gate — ${gate.label}${gate.status !== 'ok' ? ` [${gate.status}]` : ''}`);
    if (g.admitted) lines.push(`Admitted: ${(g.admitted as unknown[]).join(', ')}`);
    if (g.dropped) lines.push(`Dropped by reason: ${JSON.stringify(g.dropped)}`);
    lines.push('');
  }

  const gates = stepsOf(record, 'PRE_EVALUATOR_GATE');
  if (gates.length) {
    lines.push(`# Pre-evaluator gates (rules that can close an action before it is read)`);
    for (const s of gates) {
      const o = out(s);
      const ctx = (o.context ?? {}) as Record<string, unknown>;
      lines.push(`- ${s.label}. Senator role then: ${S(ctx.senator_role)}; action date: ${S(ctx.action_date)}${Array.isArray(ctx.vote_flags) && (ctx.vote_flags as string[]).includes('ACTION_DATE_PROXY') ? ' (a stand-in: first day of the Congress, exact date not in the record)' : ''}; bill class: ${S(ctx.bill_class)}`);
    }
    lines.push('');
  }

  const fulfillment = stepsOf(record, 'FULFILLMENT');
  if (fulfillment.length) {
    lines.push(`# Bill effect — which way does each bill push the goal? (one evaluator call per bill; the verdict follows from this plus the senator's action)`);
    for (const s of fulfillment) {
      const p = (out(s).parsed ?? {}) as Record<string, unknown>;
      if (s.status === 'skipped') { lines.push(`- ${s.label}`); continue; }
      lines.push(`- ${s.label.split(' → ')[0]}: effect ${S(p.bill_effect)}${p.same_object === false ? ' (same object: NO — same policy lane, different thing)' : ''}; evaluator's own alignment ${S(p.alignment)}. Reasoning: ${S(p.reasoning)}`);
    }
    lines.push('');
  }

  const score = stepOf(record, 'SCORE');
  if (score) {
    const o = out(score);
    const i = inp(score);
    lines.push(`# The scorer (pure code, no model) — ${score.label}`);
    if (i.effect_disagreements && (i.effect_disagreements as unknown[]).length) lines.push(`Orchestrator vs evaluator disagreements (evaluator governs): ${(i.effect_disagreements as unknown[]).join(' | ')}`);
    const receipt = (o.receipt ?? {}) as Record<string, unknown>;
    if (Array.isArray(receipt.trace)) lines.push(`Gate and dial trace: ${(receipt.trace as unknown[]).join(' ')}`);
    for (const e of (o.evidence ?? []) as Array<Record<string, unknown>>) {
      lines.push(`- ${S(e.bill_id)}: effect ${S(e.bill_effect)} → outcome ${S(e.outcome)} (${S(e.direction)}); evidence ${S(e.evidence_type)} / ${S(e.action_tier)} / ${S(e.vote_pattern)}; governing ${S(e.vote_governing)}; flags ${Array.isArray(e.vote_flags) ? (e.vote_flags as string[]).join(',') : ''}`);
    }
    lines.push('');
  }

  const judge = stepOf(record, 'JUDGE');
  if (judge) {
    lines.push(`# Second-opinion review — ${judge.label}${judge.status !== 'ok' ? ` [${judge.status}]` : ''}`);
    const o = out(judge);
    const v = (o.judge_verdict ?? null) as Record<string, unknown> | null;
    if (v) lines.push(`Grade ${S(v.grade)}${S(v.failed_test) ? ` on ${S(v.failed_test)} (${S(v.failure_class)})` : ''}. Critique: ${S(v.critique)}. Senator's strongest counterargument: ${S(v.senator_counterargument) || 'none recorded'}`);
    lines.push('');
  }

  const explain = stepsOf(record, 'EXPLAIN_CHECK').at(-1);
  if (explain) {
    const o = out(explain);
    lines.push(`# The explanation the person was shown`, S(o.why));
    const conn = (o.connectors ?? {}) as Record<string, string>;
    for (const [uid, line] of Object.entries(conn)) lines.push(`- ${uid}: ${line}`);
    lines.push('');
  }

  const result = out(stepOf(record, 'RESULT'));
  const scored = (result.scored ?? {}) as Record<string, unknown>;
  if (scored.verdict) {
    lines.push(`# The result`, `Verdict bucket: ${S(scored.verdict)} · band ${S(scored.band) || 'none'} · mode ${S(scored.mode)}${S(scored.nd_reason) ? ` · reason ${S(scored.nd_reason)}` : ''}`);
    const cov = (result.coverage ?? null) as Record<string, unknown> | null;
    if (cov) lines.push(`Coverage searched: Congresses ${JSON.stringify(cov.congresses ?? cov.observed)}`);
    const gated = (result.gated ?? []) as Array<Record<string, unknown>>;
    for (const g of gated) lines.push(`Gated (never read): ${S(g.bill_id)} — ${S(g.reason)}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The call.
// ---------------------------------------------------------------------------

export interface FollowupFetch {
  (system: string, messages: Anthropic.MessageParam[]): Promise<{
    text: string;
    usage?: unknown;
    stop_reason?: string | null;
  }>;
}

export function liveFollowupFetch(): FollowupFetch {
  return async (system, messages) => {
    const client = new Anthropic({ apiKey: config.anthropic.apiKey });
    const msg = await client.messages.create({
      model: config.models.explain,
      max_tokens: FOLLOWUP_MAX_TOKENS,
      system,
      messages,
    });
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return { text, usage: msg.usage, stop_reason: msg.stop_reason };
  };
}

const REFUSAL =
  'I could not phrase an answer to that within the rules this tool holds itself to — no numbers, no guessing at motive, and no second-guessing the verdict. The evidence cards and "How we got here" are the record; the trace link under the steps has every detail.';

/** The verdict and statement type the guard checks against, from the trace. */
function guardInputs(record: TraceRecord): { verdict: string; statementType: string } {
  const result = out(stepOf(record, 'RESULT'));
  const scored = (result.scored ?? {}) as Record<string, unknown>;
  const interp = (result.interpretation ?? {}) as Record<string, unknown>;
  return {
    verdict: S(scored.verdict) || 'NOT_DETERMINABLE',
    statementType: S(interp.statement_type) || 'Policy Position',
  };
}

export async function answerFollowup(
  req: FollowupRequest,
  deps: { fetch?: FollowupFetch; sinks?: readonly TraceSink[] } = {},
): Promise<FollowupAnswer> {
  const fetch = deps.fetch ?? liveFollowupFetch();
  const { record } = req;
  const question = req.question.trim();
  const history = (req.history ?? []).slice(-10);

  // Its own trace run, pointing at the run it is about.
  const trace = new QueryTrace(deps.sinks ?? [], {
    politicianId: record.run.politician_id,
    promiseText: record.run.promise_text,
    meta: { followup_of: record.run.run_id, model: config.models.explain },
  });
  trace.record({
    stage: 'REQUEST', kind: 'control',
    label: `follow-up on ${record.run.run_id}: "${question.slice(0, 80)}${question.length > 80 ? '…' : ''}"`,
    input: { question, history_turns: history.length },
  });

  const context = buildFollowupContext(record);
  const system = `${FOLLOWUP_SYSTEM_PROMPT}\n\n---\n\n## THE RECORD\n\n${context}`;
  const messages: Anthropic.MessageParam[] = [
    ...history.map((h) => ({ role: h.role, content: h.text }) as Anthropic.MessageParam),
    { role: 'user', content: question },
  ];
  const { verdict, statementType } = guardInputs(record);

  let answer = '';
  let refused = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const end = trace.begin();
    let res: Awaited<ReturnType<FollowupFetch>>;
    try {
      res = await fetch(system, messages);
    } catch (err) {
      end({
        stage: 'FOLLOWUP', kind: 'model', status: 'error', label: `attempt ${attempt + 1} failed`,
        model: config.models.explain, prompt_version: FOLLOWUP_PROMPT_VERSION, prompt_text: system,
        input: { question, history_turns: history.length }, error: err instanceof Error ? err.message : String(err),
      });
      await trace.close('error');
      throw err;
    }
    const problems = explanationProblems(res.text, verdict, statementType);
    end({
      stage: 'FOLLOWUP', kind: 'model',
      status: problems.length ? 'rejected' : 'ok',
      label: problems.length ? `attempt ${attempt + 1} rejected: ${problems.join('; ')}` : `attempt ${attempt + 1} accepted`,
      model: config.models.explain, prompt_version: FOLLOWUP_PROMPT_VERSION, prompt_text: system,
      usage: anthropicUsage(res.usage),
      input: { question, history_turns: history.length, context_chars: context.length },
      output: { raw_text: res.text, stop_reason: res.stop_reason ?? null, problems },
    });
    if (!problems.length) {
      answer = res.text;
      break;
    }
    if (attempt === 0) {
      messages.push({ role: 'assistant', content: res.text });
      messages.push({
        role: 'user',
        content: `That answer breaks these rules: ${problems.join('; ')}. Rewrite it within the rules. Same question.`,
      });
    } else {
      refused = true;
      answer = REFUSAL;
    }
  }

  trace.record({ stage: 'DONE', kind: 'control', label: refused ? 'refused after two attempts' : 'answered', output: { refused } });
  await trace.close('result');
  return { answer, refused, followup_run_id: trace.runId };
}
