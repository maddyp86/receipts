import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import type { TraceRun, TraceSink, TraceStep } from './Trace.js';

// ===========================================================================
// Where a trace goes, and how it is read back.
//
// Two sinks, both best effort, both optional, selected in services.ts:
//
//   FileTraceSink      one JSONL file per run under TRACE_DIR. This is the
//                      one that works with DATABASE_URL blank — which is how
//                      local verification runs, because a local DATABASE_URL
//                      writes to production. Pruned to TRACE_MAX_FILES.
//
//   SupabaseTraceSink  two tables, app.app_query_trace_runs and
//                      app.app_query_trace_steps (migration 009). Written in
//                      one transaction at the end of the run. A missing table
//                      is reported once and does not stop the file sink.
//
// Reading is BY RUN ID ONLY, like share links. No list, no search, no filter
// by senator: the trace is a repair tool, not a dataset, and the QueryStore
// rule — nothing on the way to a verdict may read what anyone else asked —
// applies here by construction because nothing on the request path reads it.
// ===========================================================================

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TraceRecord {
  run: TraceRun;
  steps: TraceStep[];
}

export interface TraceReader {
  readonly kind: string;
  get(runId: string): Promise<TraceRecord | null>;
}

// ---------------------------------------------------------------------------
// File sink — JSONL, one file per run.
//
// Line 1 is the run header, then one line per step. The file name carries the
// start time so a directory listing reads chronologically, and the run id so
// a lookup is a glob rather than a scan.
// ---------------------------------------------------------------------------

export class FileTraceSink implements TraceSink, TraceReader {
  readonly kind = 'file' as const;

  constructor(
    readonly dir: string,
    private readonly maxFiles: number = 200,
  ) {}

  private fileFor(run: TraceRun): string {
    const stamp = run.started_at.replace(/[:.]/g, '-');
    return resolve(this.dir, `${stamp}_${run.run_id}.jsonl`);
  }

  async write(run: TraceRun, steps: TraceStep[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'run', ...run }),
      ...steps.map((s) => JSON.stringify({ type: 'step', ...s })),
    ];
    await writeFile(this.fileFor(run), `${lines.join('\n')}\n`, 'utf8');
    await this.prune();
  }

  /** Oldest first, by name — the name starts with the ISO start time. */
  private async prune(): Promise<void> {
    if (!Number.isFinite(this.maxFiles) || this.maxFiles <= 0) return;
    const names = (await readdir(this.dir)).filter((n) => n.endsWith('.jsonl')).sort();
    const excess = names.length - this.maxFiles;
    for (let i = 0; i < excess; i += 1) {
      await unlink(resolve(this.dir, names[i]!)).catch(() => {
        /* already gone; nothing to do */
      });
    }
  }

  async get(runId: string): Promise<TraceRecord | null> {
    if (!UUID.test(runId)) return null;
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return null;
    }
    const name = names.find((n) => n.endsWith(`_${runId.toLowerCase()}.jsonl`));
    if (!name) return null;
    const path = resolve(this.dir, name);
    if (!(await stat(path)).isFile()) return null;
    return parseJsonl(await readFile(path, 'utf8'));
  }
}

/** Parse a trace file. Exported for the log-sheet tool's tests. */
export function parseJsonl(text: string): TraceRecord | null {
  let run: TraceRun | null = null;
  const steps: TraceStep[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // a torn line at the end of a file is not a reason to lose the rest
    }
    const { type, ...rest } = row;
    if (type === 'run') run = rest as unknown as TraceRun;
    else if (type === 'step') steps.push(rest as unknown as TraceStep);
  }
  if (!run) return null;
  steps.sort((a, b) => a.seq - b.seq);
  return { run, steps };
}

// ---------------------------------------------------------------------------
// Supabase sink — same connection discipline as SupabaseQueryStore: `pg`, as
// receipts_app, through the transaction pooler, no named statements.
// ---------------------------------------------------------------------------

export class SupabaseTraceSink implements TraceSink, TraceReader {
  readonly kind = 'supabase' as const;
  private readonly pool: pg.Pool;
  /** Reported once. Every query after a missing-table error would say the same thing. */
  private schemaMissing = false;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    this.pool.on('error', (err) => {
      console.error('[trace] idle client error (non-fatal):', err.message);
    });
  }

  async write(run: TraceRun, steps: TraceStep[]): Promise<void> {
    if (this.schemaMissing) return;
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into app.app_query_trace_runs (
           run_id, started_at, ended_at, status, politician_id, promise_text, query_id, meta
         ) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          run.run_id,
          run.started_at,
          run.ended_at,
          run.status,
          run.politician_id,
          run.promise_text,
          run.query_id,
          JSON.stringify(run.meta ?? {}),
        ],
      );
      for (const s of steps) {
        await client.query(
          `insert into app.app_query_trace_steps (
             run_id, seq, at, duration_ms, stage, kind, status, subject, label,
             model, prompt_version, prompt_sha256, usage, input, output, error
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            s.run_id, s.seq, s.at, s.duration_ms, s.stage, s.kind, s.status, s.subject, s.label,
            s.model, s.prompt_version, s.prompt_sha256,
            s.usage ? JSON.stringify(s.usage) : null,
            JSON.stringify(s.input ?? null),
            JSON.stringify(s.output ?? null),
            s.error,
          ],
        );
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => {
        /* connection already broken; the original error is what matters */
      });
      if (isUndefinedTable(err)) {
        this.schemaMissing = true;
        console.error(
          '[trace] app.app_query_trace_* tables are missing — run ' +
            'docs/supabase-migration-009-query-trace-log.sql. Traces still go to the file sink.',
        );
        return;
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async get(runId: string): Promise<TraceRecord | null> {
    if (!UUID.test(runId) || this.schemaMissing) return null;
    try {
      const { rows } = await this.pool.query(
        `select run_id, started_at, ended_at, status, politician_id, promise_text, query_id, meta
           from app.app_query_trace_runs where run_id = $1`,
        [runId],
      );
      if (!rows.length) return null;
      const r = rows[0]!;
      const run: TraceRun = {
        run_id: r.run_id,
        started_at: toIso(r.started_at),
        ended_at: r.ended_at ? toIso(r.ended_at) : null,
        status: r.status,
        politician_id: r.politician_id,
        promise_text: r.promise_text,
        query_id: r.query_id ?? null,
        meta: r.meta ?? {},
      };
      const { rows: stepRows } = await this.pool.query(
        `select run_id, seq, at, duration_ms, stage, kind, status, subject, label,
                model, prompt_version, prompt_sha256, usage, input, output, error
           from app.app_query_trace_steps where run_id = $1 order by seq`,
        [runId],
      );
      const steps: TraceStep[] = stepRows.map((s) => ({
        run_id: s.run_id,
        seq: Number(s.seq),
        at: toIso(s.at),
        duration_ms: s.duration_ms === null ? null : Number(s.duration_ms),
        stage: s.stage,
        kind: s.kind,
        status: s.status,
        subject: s.subject ?? null,
        label: s.label,
        model: s.model ?? null,
        prompt_version: s.prompt_version ?? null,
        prompt_sha256: s.prompt_sha256 ?? null,
        usage: s.usage ?? null,
        input: s.input ?? null,
        output: s.output ?? null,
        error: s.error ?? null,
      }));
      return { run, steps };
    } catch (err) {
      if (isUndefinedTable(err)) {
        this.schemaMissing = true;
        return null;
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Postgres 42P01: relation does not exist. */
function isUndefinedTable(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === '42P01');
}

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

// ---------------------------------------------------------------------------

/** Read from the first reader that has the run. */
export class CompositeTraceReader implements TraceReader {
  readonly kind = 'composite' as const;
  constructor(private readonly readers: readonly TraceReader[]) {}

  async get(runId: string): Promise<TraceRecord | null> {
    for (const r of this.readers) {
      try {
        const hit = await r.get(runId);
        if (hit) return hit;
      } catch (err) {
        console.error(`[trace] ${r.kind} read failed (non-fatal):`, err instanceof Error ? err.message : err);
      }
    }
    return null;
  }
}

/** In-memory sink for tests. Keeps every run it is given. */
export class MemoryTraceSink implements TraceSink, TraceReader {
  readonly kind = 'memory' as const;
  readonly runs = new Map<string, TraceRecord>();

  async write(run: TraceRun, steps: TraceStep[]): Promise<void> {
    this.runs.set(run.run_id, { run: { ...run }, steps: steps.map((s) => ({ ...s })) });
  }

  async get(runId: string): Promise<TraceRecord | null> {
    return this.runs.get(runId) ?? null;
  }
}
