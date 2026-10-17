import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import { config } from '../config.js';

// ===========================================================================
// Demand capture for uncached senators (ADR-004, docs/adr/README.md).
//
// An unanswered query is not a failure — it is the signal that tells us where to
// spend analysis budget next. So it is recorded rather than discarded.
//
// MVP scope is deliberately a local append-only log: no queue infrastructure, no
// email capture, no orchestrator trigger. When this graduates, the same
// interface points at Supabase and the n8n per-senator orchestrator run.
// ===========================================================================

export interface QueueRequest {
  politician_id: string;
  senator_name: string;
  promise_text: string;
  requested_at: string;
  /** False for a request made on a preview/test site (migration 022). Absent means live. */
  livemode?: boolean;
}

export interface QueueStore {
  record(request: QueueRequest): Promise<void>;
}

export class FileQueueStore implements QueueStore {
  constructor(private readonly path = resolve(process.cwd(), '.data/queue.log')) {}

  async record(request: QueueRequest): Promise<void> {
    const line = JSON.stringify(request);
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${line}\n`, 'utf8');
    } catch (err) {
      // Losing a demand signal must never break the user's query — they still
      // get the honest uncached state. Log loudly and carry on.
      console.warn('[queue] could not persist request:', err);
    }
    console.info('[queue]', line);
  }
}

/**
 * app.member_requests (migration 018): the same signal, kept past a deploy.
 * Insert-only for the app. Best effort, like the file: a failure is logged and
 * the reader still gets the honest uncached state.
 */
export class SupabaseQueueStore implements QueueStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string, private readonly file: QueueStore = new FileQueueStore()) {
    this.pool = new pg.Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 1,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    this.pool.on('error', (err) => console.error('[queue] idle client error:', err.message));
  }

  async record(request: QueueRequest): Promise<void> {
    await this.file.record(request);
    try {
      // The livemode column is named only for a test request, so a live one
      // still stores if migration 022 has not been run yet.
      const test = request.livemode === false;
      await this.pool.query(
        test
          ? `insert into app.member_requests (member_id, member_name, promise_text, requested_at, livemode)
             values ($1, $2, $3, $4, false)`
          : `insert into app.member_requests (member_id, member_name, promise_text, requested_at)
             values ($1, $2, $3, $4)`,
        [request.politician_id, request.senator_name, request.promise_text.slice(0, 2000), request.requested_at],
      );
    } catch (err) {
      console.warn('[queue] not stored in app.member_requests (has migration 018 run?):', err instanceof Error ? err.message : err);
    }
  }
}

export const queueStore: QueueStore =
  config.database.url && config.database.persistQueries ? new SupabaseQueueStore(config.database.url) : new FileQueueStore();
