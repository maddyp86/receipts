import pg from 'pg';
import { config } from '../config.js';
import type { QueryStore, StoredQuery } from './QueryStore.js';

// ===========================================================================
// The real QueryStore, over a plain Postgres connection.
//
// `pg`, deliberately, NOT @supabase/supabase-js. The Supabase JS client speaks
// PostgREST and authenticates with the anon or service_role key — and
// service_role bypasses RLS *and* bypasses the point of the three custom roles.
// The corpus firewall is built out of those roles: `receipts_trust` being
// locked out of the `app` schema only means something if the app connects as
// `receipts_app`. A raw connection string is what lets us BE that role.
//
// ── CONNECT AS receipts_app. NOT postgres, NOT service_role. ───────────────
// This is checked at startup (see `verifyConnection`) and logged loudly if
// wrong, because a connection as a blanket-privilege role turns the firewall
// into decoration while everything still appears to work.
//
// ── TRANSACTION-MODE POOLER (port 6543) ────────────────────────────────────
// A persistent server wants the pooler, not a direct 5432 connection. Two
// consequences this file has to respect:
//   * NO named prepared statements. Transaction mode hands out a different
//     backend per transaction, so a statement prepared on one is absent on the
//     next. `pg` uses unnamed portals for parameterised queries unless you pass
//     `name`, so simply never pass `name`.
//   * NO session-level state — no SET, no LISTEN, no advisory locks held
//     across statements.
// ===========================================================================

const { Pool } = pg;

export class SupabaseQueryStore implements QueryStore {
  readonly kind = 'supabase' as const;

  private readonly pool: pg.Pool;

  constructor(connectionString: string = config.database.url) {
    this.pool = new Pool({
      connectionString,
      // Supabase terminates TLS with a cert this chain does not verify by
      // default. The connection is still encrypted; certificate pinning is not
      // what protects this data - the role's privileges are.
      ssl: { rejectUnauthorized: false },
      // Small: the pooler is already the multiplexer. A large client-side pool
      // just holds pooler slots hostage.
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

    // A pool-level error must never take the process down. Postgres closing an
    // idle connection is routine, especially through a pooler.
    this.pool.on('error', (err) => {
      console.error('[querystore] idle client error (non-fatal):', err.message);
    });
  }

  /**
   * Confirms the connection opens and reports WHICH ROLE it opened as.
   *
   * Never throws to the caller — persistence is best-effort and must not gate
   * the app booting. But it says plainly what it found, because the failure
   * this guards against is silent: a working connection as the wrong role
   * looks identical to a correct one until someone audits the firewall.
   */
  async verifyConnection(): Promise<
    { ok: true; role: string; database: string; firewallIntact: boolean } | { ok: false; error: string }
  > {
    try {
      const { rows } = await this.pool.query<{
        role: string;
        database: string;
        can_see_app: boolean;
      }>(
        `select current_user as role,
                current_database() as database,
                has_schema_privilege(current_user, 'app', 'USAGE') as can_see_app`,
      );
      const row = rows[0]!;
      return {
        ok: true,
        role: row.role,
        database: row.database,
        // The app SHOULD see the app schema. What matters is that it is
        // receipts_app doing the seeing, not a superuser.
        firewallIntact: row.role === 'receipts_app',
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async startSession(meta: { userAgent?: string; clientHash?: string } = {}): Promise<string> {
    // clientHash is accepted by the interface but deliberately NOT persisted:
    // app_sessions has no such column, by design. Anything resembling a durable
    // per-person identifier stays out of this schema.
    const { rows } = await this.pool.query<{ id: string }>(
      `insert into app.app_sessions (user_agent) values ($1) returning id`,
      [meta.userAgent ?? null],
    );
    return rows[0]!.id;
  }

  async saveQuery(query: Omit<StoredQuery, 'id'>): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `insert into app.app_queries (
         session_id, politician_id, promise_text, classification,
         corrections_applied, statement_type, provenance, user_asserted_premise,
         result, verdict, band, models_used, degraded
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       returning id`,
      [
        query.session_id,
        query.politician_id,
        query.promise_text,
        JSON.stringify(query.interpretation),
        query.interpretation.corrections_applied
          ? JSON.stringify(query.interpretation.corrections_applied)
          : null,
        query.interpretation.statement_type,
        query.interpretation.provenance,
        query.user_asserted_premise,
        query.result ? JSON.stringify(query.result) : null,
        // verdict/band are denormalised out of the frozen result so they are
        // filterable in SQL without unpacking jsonb on every analysis query.
        query.result?.scored.verdict ?? null,
        query.result?.scored.band ?? null,
        query.models_used ? JSON.stringify(query.models_used) : null,
        query.degraded ? JSON.stringify(query.degraded) : null,
      ],
    );
    return rows[0]!.id;
  }

  /**
   * By id ONLY — see the note at the top of QueryStore.ts. There is no list, no
   * search, no filter by senator. The absence is the design.
   */
  async getQuery(id: string): Promise<StoredQuery | null> {
    // A malformed id must not reach Postgres as a cast error; treat it as a
    // miss, which is what it is.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return null;
    }

    const { rows } = await this.pool.query(
      `select id, session_id, politician_id, promise_text, classification,
              user_asserted_premise, result, models_used, degraded
         from app.app_queries
        where id = $1`,
      [id],
    );
    if (!rows.length) return null;

    const r = rows[0]!;
    return {
      id: r.id,
      session_id: r.session_id,
      politician_id: r.politician_id,
      promise_text: r.promise_text,
      // jsonb comes back already parsed from `pg`.
      interpretation: r.classification,
      result: r.result ?? null,
      user_asserted_premise: r.user_asserted_premise,
      models_used: r.models_used ?? undefined,
      degraded: r.degraded ?? undefined,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
