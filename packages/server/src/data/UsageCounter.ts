import pg from 'pg';

// ===========================================================================
// The global daily count, for the spend cap (rateLimit.ts).
//
// One number per UTC day: paid requests admitted past the per-IP limits.
// Persisted in app.app_usage_daily (migration 011) because Render's free tier
// sleeps and restarts the service — an in-memory count would reset with every
// restart and bound spend per process lifetime, not per day.
//
// FAILS TO MEMORY, NOT OPEN. If the table is missing or the database is
// unreachable, the count carries on in memory, and the database is tried again
// after five minutes. Meanwhile the cap bounds the process rather than the
// day — weaker, and logged so it is visible — but it never disappears.
// Failing open would remove the one control that bounds total spend at
// exactly the moment the infrastructure is misbehaving.
//
// The memory count runs alongside the database count always, and the larger
// is returned. After an outage the database has missed the requests counted
// in memory; taking the larger never under-counts what this process saw.
//
// Same pooler contract as SupabaseQueryStore: unnamed statements only, no
// session state.
// ===========================================================================

const { Pool } = pg;

/** How long to stay on the memory fallback before trying the database again. */
const RETRY_AFTER_MS = 5 * 60 * 1000;

/** 'YYYY-MM-DD' for the UTC day containing `at`. */
export function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

export interface UsageCounter {
  readonly kind: 'supabase' | 'memory';
  /** Add one to `day`'s count and return the new count. Never throws. */
  increment(day: string): Promise<number>;
}

/** In-process count. The fallback, and the store when there is no database. */
export class MemoryUsageCounter implements UsageCounter {
  readonly kind = 'memory' as const;
  private counts = new Map<string, number>();

  async increment(day: string): Promise<number> {
    // Only today's key is ever needed; dropping the rest keeps this bounded.
    for (const k of this.counts.keys()) if (k !== day) this.counts.delete(k);
    const next = (this.counts.get(day) ?? 0) + 1;
    this.counts.set(day, next);
    return next;
  }
}

export class SupabaseUsageCounter implements UsageCounter {
  readonly kind = 'supabase' as const;
  private readonly pool: pg.Pool;
  private readonly fallback = new MemoryUsageCounter();
  /** While set and in the future, the database is not tried. */
  private retryAt = 0;
  private readonly now: () => number;

  constructor(connectionString: string, poolOverride?: pg.Pool, now: () => number = Date.now) {
    this.now = now;
    this.pool =
      poolOverride ??
      new Pool({
        connectionString,
        ssl: { rejectUnauthorized: false },
        max: 2,
        idleTimeoutMillis: 30_000,
        // Short: this sits on the request path of every paid query. A slow
        // database must cost a few seconds once, then the fallback takes over.
        connectionTimeoutMillis: 3_000,
      });
    // An idle client erroring must not crash the process.
    this.pool.on('error', (err) => console.error('[usage] idle client error:', err.message));
  }

  async increment(day: string): Promise<number> {
    const local = await this.fallback.increment(day);
    if (this.now() >= this.retryAt) {
      try {
        const { rows } = await this.pool.query<{ queries: number }>(
          `insert into app.app_usage_daily (day, queries, updated_at)
             values ($1::date, 1, now())
           on conflict (day) do update
             set queries = app.app_usage_daily.queries + 1, updated_at = now()
           returning queries`,
          [day],
        );
        const n = Number(rows[0]?.queries);
        if (Number.isFinite(n)) {
          if (this.retryAt) console.info('[usage] daily count back on the database.');
          this.retryAt = 0;
          return Math.max(n, local);
        }
        throw new Error('no count returned');
      } catch (err) {
        // Not retried on every request: that would add the connection timeout
        // to every paid query while the database is down. Tried again after a
        // pause; the memory count carries the gap.
        if (!this.retryAt) {
          console.error(
            '[usage] daily count unavailable — the global cap now counts per process, not per day. ' +
              'Is migration 011 applied? ' +
              (err instanceof Error ? err.message : String(err)),
          );
        }
        this.retryAt = this.now() + RETRY_AFTER_MS;
      }
    }
    return local;
  }

  /** True while the count is on the in-memory fallback. */
  get isDegraded(): boolean {
    return this.retryAt > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
