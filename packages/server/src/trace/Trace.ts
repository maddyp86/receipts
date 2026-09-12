import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';

// ===========================================================================
// THE QUERY TRACE — one row per gate the context passes through.
//
// The UI shows the end of the pipeline. The database stores the parsed
// outcome of each stage. Neither shows what actually went IN to a model call
// and what came OUT of it, in order, with the decision each step took — so
// when a verdict looks wrong there is no way to say which gate bent it.
//
// This records exactly that: for every step of one run, the input it was
// given, the output it produced, the one-line decision it made, and — for a
// model call — the model, the prompt version, the token usage and the raw
// text before parsing. Deterministic steps record their inputs and outputs
// too, so a wrong verdict can be walked back from the result to the request.
//
// ── WHAT THIS IS NOT ──────────────────────────────────────────────────────
// Not the verdict audit log (migration 004). That is the artefact for a
// journalist: every DECISION that changed a verdict, append-only. This is the
// artefact for the person repairing the pipeline: every STEP, including the
// ones that changed nothing. They complement each other and neither replaces
// the other.
//
// Not evidence about a senator, and never read on the request path. There is
// no aggregate read here — a trace is fetched by its own opaque run id, and
// nothing on the way to a verdict consults one.
//
// ── HOW IT IS WIRED ───────────────────────────────────────────────────────
// A trace is opened per run and made available through AsyncLocalStorage, so
// a model-call site three modules down can record its raw request and
// response with `currentTrace()?.record(...)` and no signature change. Outside
// a run — every existing unit test — `currentTrace()` is undefined and every
// helper is a no-op. Recording is synchronous into memory; sinks are flushed
// at the end of the run and are best effort, like persistence: a trace that
// fails to write must never turn an answered query into an error.
// ===========================================================================

/**
 * Where in the pipeline a step happened. Named after the gate, not the tool,
 * so a trace reads as the flow diagram rather than as a call log.
 */
export type TraceStage =
  | 'REQUEST'
  | 'CACHE_REPLAY'
  | 'SCOPE_MODEL'
  | 'SCOPE_CLASSIFY'
  | 'HALT'
  | 'ORCHESTRATOR_TURN'
  | 'CLASSIFY_MODEL'
  | 'CLASSIFY'
  | 'INTERPRET'
  | 'RESOLVE_SENATOR'
  | 'QUEUE_SENATOR'
  | 'UNCACHED'
  | 'EMBED'
  | 'RETRIEVE'
  | 'RELEVANCE'
  | 'EVIDENCE_GATE'
  | 'SEARCH'
  | 'ENRICHMENT'
  | 'PRE_EVALUATOR_GATE'
  | 'FULFILLMENT'
  | 'SCORE'
  | 'EVALUATE_EFFECTS'
  | 'JUDGE_GATES'
  | 'JUDGE_MODEL'
  | 'JUDGE'
  | 'EXPLAIN_CHECK'
  | 'EXPLAIN'
  | 'RESULT'
  | 'ERROR'
  | 'PERSIST'
  | 'DONE';

export type TraceKind = 'model' | 'deterministic' | 'io' | 'control';

/**
 * `rejected` is for a model output the code refused and sent back for another
 * attempt (the explanation wording checks). It is not an error — the loop
 * continues — but it is exactly the kind of bend that is invisible in the UI.
 */
export type TraceStatus = 'ok' | 'error' | 'skipped' | 'rejected';

export interface TraceUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
  reasoning_tokens?: number;
}

export interface TraceStep {
  run_id: string;
  /** Order within the run. Wall-clock ties on sub-millisecond steps. */
  seq: number;
  /** ISO timestamp of when the step ENDED (when it was recorded). */
  at: string;
  duration_ms: number | null;
  stage: TraceStage;
  kind: TraceKind;
  status: TraceStatus;
  /** The action_uid or bill_id a per-candidate step is about. */
  subject: string | null;
  /** The one-line decision: "admitted 3 of 10", "G2_LEADER fired", "BROKE → withheld". */
  label: string;
  model: string | null;
  prompt_version: string | null;
  /** sha256 of the system prompt, so a later reader can check which text ran. */
  prompt_sha256: string | null;
  usage: TraceUsage | null;
  /** What the step was given. JSON; long strings are truncated with a marker. */
  input: unknown;
  /** What the step produced. For a model call: the raw text AND the parsed value. */
  output: unknown;
  error: string | null;
}

export interface TraceRun {
  run_id: string;
  started_at: string;
  ended_at: string | null;
  /** How the run concluded, in the stream's own vocabulary. */
  status: 'running' | 'result' | 'halt' | 'uncached' | 'error' | 'replay';
  politician_id: string;
  promise_text: string;
  /** The app_queries row this run was persisted as, when one was written. */
  query_id: string | null;
  /** Mode and model tags, so a trace says what produced it. */
  meta: Record<string, unknown>;
}

export interface TraceSink {
  readonly kind: string;
  /** Called once per run, at the end, with every step. Best effort. */
  write(run: TraceRun, steps: TraceStep[]): Promise<void>;
}

/** What a caller passes to `record`. Everything else is filled in. */
export type StepInput = {
  stage: TraceStage;
  kind: TraceKind;
  label: string;
  status?: TraceStatus;
  subject?: string | null;
  model?: string | null;
  prompt_version?: string | null;
  /** Hashed, never stored. Pass the system prompt text. */
  prompt_text?: string | null;
  usage?: TraceUsage | null;
  input?: unknown;
  output?: unknown;
  error?: string | null;
  duration_ms?: number | null;
};

// ---------------------------------------------------------------------------
// Bounding. A trace must not be able to blow up a row or a file: a bill
// summary is a few KB and a system prompt is 32 KB, but a runaway model
// response could be anything. Strings are cut at MAX_STRING with a marker
// that says how much was dropped, so a truncated field is never mistaken for
// a short one.
// ---------------------------------------------------------------------------

export const MAX_STRING = 32_000;

export function bound(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    if (value.length <= MAX_STRING) return value;
    return `${value.slice(0, MAX_STRING)}…[truncated ${value.length - MAX_STRING} chars]`;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth > 12) return '[depth limit]';
  if (Array.isArray(value)) return value.map((v) => bound(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = bound(v, depth + 1);
  }
  return out;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// ---------------------------------------------------------------------------

export class QueryTrace {
  readonly runId: string;
  readonly startedAt: string;
  readonly steps: TraceStep[] = [];
  private seq = 0;
  private closed = false;
  private readonly run: TraceRun;

  constructor(
    private readonly sinks: readonly TraceSink[],
    init: { politicianId: string; promiseText: string; meta?: Record<string, unknown>; runId?: string },
  ) {
    this.runId = init.runId ?? randomUUID();
    this.startedAt = new Date().toISOString();
    this.run = {
      run_id: this.runId,
      started_at: this.startedAt,
      ended_at: null,
      status: 'running',
      politician_id: init.politicianId,
      promise_text: init.promiseText,
      query_id: null,
      meta: init.meta ?? {},
    };
  }

  /** Record one completed step. Synchronous; never throws. */
  record(step: StepInput): TraceStep {
    const row: TraceStep = {
      run_id: this.runId,
      seq: this.seq++,
      at: new Date().toISOString(),
      duration_ms: step.duration_ms ?? null,
      stage: step.stage,
      kind: step.kind,
      status: step.status ?? 'ok',
      subject: step.subject ?? null,
      label: step.label,
      model: step.model ?? null,
      prompt_version: step.prompt_version ?? null,
      prompt_sha256: step.prompt_text ? sha256(step.prompt_text) : null,
      usage: step.usage ?? null,
      input: bound(step.input ?? null),
      output: bound(step.output ?? null),
      error: step.error ?? null,
    };
    this.steps.push(row);
    return row;
  }

  /**
   * Time a step. Returns a function that records it with the measured
   * duration; call it exactly once when the step ends, however it ended.
   */
  begin(): (step: StepInput) => TraceStep {
    const t0 = Date.now();
    return (step) => this.record({ ...step, duration_ms: step.duration_ms ?? Date.now() - t0 });
  }

  /** Set once persistence has (or has not) produced a query row. */
  setQueryId(queryId: string | null): void {
    this.run.query_id = queryId;
  }

  /** Flush to every sink. Each sink fails independently and loudly. */
  async close(status: TraceRun['status']): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.run.status = status;
    this.run.ended_at = new Date().toISOString();
    for (const sink of this.sinks) {
      try {
        await sink.write(this.run, this.steps);
      } catch (err) {
        console.error(
          `[trace] ${sink.kind} sink failed for run ${this.runId} (non-fatal):`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  /** The run header as it stands. Exposed for tests and sinks. */
  snapshot(): TraceRun {
    return { ...this.run };
  }
}

// ---------------------------------------------------------------------------
// Ambient access.
//
// Model-call sites (classify, scope, judge) record their raw request and
// response here rather than being handed a trace through three signatures.
// Outside a run there is no trace and every call is a no-op — which is what
// keeps every existing unit test unchanged.
// ---------------------------------------------------------------------------

const storage = new AsyncLocalStorage<QueryTrace>();

export function withTrace<T>(trace: QueryTrace, fn: () => Promise<T>): Promise<T> {
  return storage.run(trace, fn);
}

export function currentTrace(): QueryTrace | undefined {
  return storage.getStore();
}

/** Record against the ambient trace, if any. Never throws. */
export function traceStep(step: StepInput): TraceStep | undefined {
  try {
    return currentTrace()?.record(step);
  } catch (err) {
    console.error('[trace] record failed (non-fatal):', err instanceof Error ? err.message : err);
    return undefined;
  }
}

/** Time a step against the ambient trace. No-op ender when there is none. */
export function traceBegin(): (step: StepInput) => TraceStep | undefined {
  const trace = currentTrace();
  if (!trace) return () => undefined;
  const end = trace.begin();
  return (step) => {
    try {
      return end(step);
    } catch (err) {
      console.error('[trace] record failed (non-fatal):', err instanceof Error ? err.message : err);
      return undefined;
    }
  };
}

/**
 * Anthropic usage → the shared shape. Cached tokens come from the
 * cache_read field; the SDK types differ by version so this reads loosely.
 */
export function anthropicUsage(usage: unknown): TraceUsage | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' ? v : undefined);
  const out: TraceUsage = {};
  if (n(u.input_tokens) !== undefined) out.input_tokens = n(u.input_tokens);
  if (n(u.output_tokens) !== undefined) out.output_tokens = n(u.output_tokens);
  if (n(u.cache_read_input_tokens) !== undefined) out.cached_tokens = n(u.cache_read_input_tokens);
  return Object.keys(out).length ? out : null;
}

/** Anthropic content blocks → something a reader can scan. Thinking is noted, not dumped. */
export function anthropicContent(
  content: unknown,
): Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }> {
  if (!Array.isArray(content)) return [];
  return content.map((b) => {
    const block = (b ?? {}) as Record<string, unknown>;
    const type = String(block.type ?? 'unknown');
    if (type === 'text') return { type, text: String(block.text ?? '') };
    if (type === 'tool_use') {
      return { type, id: String(block.id ?? ''), name: String(block.name ?? ''), input: block.input };
    }
    if (type === 'thinking' || type === 'redacted_thinking') {
      const t = typeof block.thinking === 'string' ? block.thinking : '';
      return { type, text: t ? `[thinking, ${t.length} chars]` : '[thinking]' };
    }
    return { type };
  });
}
