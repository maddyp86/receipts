import pg from 'pg';
import { config } from '../config.js';
import type {
  AuditEvent,
  QueryStore,
  StoredAlignment,
  StoredMatch,
  StoredQuery,
} from './QueryStore.js';

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

  /**
   * Writes the parent row and its full trace in ONE transaction.
   *
   * All-or-nothing on purpose: a query row with half its matches missing is
   * worse than no row, because it looks complete. Anyone later asking "how many
   * candidates did retrieval return" would get a number that is quietly wrong
   * rather than absent.
   */
  async saveQuery(query: Omit<StoredQuery, 'id'>): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');

      const { rows } = await client.query<{ id: string }>(
        `insert into app.app_queries (
           session_id, politician_id, promise_text, classification,
           corrections_applied, statement_type, provenance, user_asserted_premise,
           result, verdict, band, models_used, degraded,
           speech_act, scope, valid_until, anchor_entity, role_condition,
           scope_confidence, scope_reasoning, scope_model
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                   $14,$15,$16,$17,$18,$19,$20,$21)
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
          // Denormalised out of the frozen result so they are filterable in SQL
          // without unpacking jsonb on every analysis query.
          query.result?.scored.verdict ?? null,
          query.result?.scored.band ?? null,
          query.models_used ? JSON.stringify(query.models_used) : null,
          query.degraded ? JSON.stringify(query.degraded) : null,
          // Scope. Absent when classification was unavailable — recorded as
          // absent rather than defaulted, because a guessed scope changes
          // whether the statement is testable at all.
          query.scope?.speech_act ?? null,
          query.scope?.scope ?? null,
          query.scope?.valid_until ?? null,
          query.scope?.anchor_entity ?? null,
          query.scope?.role_condition ?? null,
          query.scope?.confidence ?? null,
          query.scope?.reasoning ?? null,
          query.scope?.model ?? null,
        ],
      );
      const queryId = rows[0]!.id;

      // action_uid -> match row id, so alignments can point back at the
      // candidate they came from.
      const matchIdByAction = new Map<string, string>();

      for (const m of query.matches ?? []) {
        const { rows: mr } = await client.query<{ id: string }>(
          `insert into app.app_query_matches (
             query_id, action_uid, bill_id, bill_title, bill_summary,
             bill_primary_issue, bill_sub_issue, similarity_score, match_strength,
             match_rank, match_direction, vote, cloture_vote, passage_vote,
             is_sponsor, is_cosponsor, action_type, relevance_verdict,
             topic_relevant, action_relevant, effort_relevant, specificity_match,
             no_vote_available, confidence, composite_score, evaluation_status,
             terminal_status, llm_reasoning, admitted, partial_subtype,
             exclusion_reason
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                     $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
           returning id`,
          [
            queryId, m.action_uid, m.bill_id, m.bill_title, m.bill_summary,
            m.bill_primary_issue, m.bill_sub_issue, m.similarity_score, m.match_strength,
            m.match_rank, m.match_direction, m.vote, m.cloture_vote, m.passage_vote,
            m.is_sponsor, m.is_cosponsor, m.action_type, m.relevance_verdict,
            m.topic_relevant, m.action_relevant, m.effort_relevant, m.specificity_match,
            m.no_vote_available, m.confidence, m.composite_score, m.evaluation_status,
            m.terminal_status, m.llm_reasoning, m.admitted, m.partial_subtype,
            m.exclusion_reason,
          ],
        );
        if (m.action_uid) matchIdByAction.set(m.action_uid, mr[0]!.id);
      }

      for (const a of query.alignments ?? []) {
        await client.query(
          `insert into app.app_query_alignments (
             query_id, match_id, action_uid, bill_id, bill_effect,
             bill_effect_reasoning, promise_alignment, alignment_confidence,
             alignment_reasoning, model_bill_effect, model_agreed, outcome,
             direction, evidence_type, action_tier, vote_pattern, weight,
             scoring_flags,
             vote_governing, vote_flags, model_verdict, confidence_marker,
             effect_marker, grade, gate_hits, senator_role, role_condition,
             cloture_result, promise_date, scope, valid_until, anchor_entity,
             bill_class
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                     $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)`,
          [
            queryId,
            matchIdByAction.get(a.action_uid) ?? null,
            a.action_uid, a.bill_id, a.bill_effect, a.bill_effect_reasoning,
            a.promise_alignment, a.alignment_confidence, a.alignment_reasoning,
            a.model_bill_effect, a.model_agreed, a.outcome, a.direction,
            a.evidence_type, a.action_tier, a.vote_pattern, a.weight,
            a.scoring_flags ? JSON.stringify(a.scoring_flags) : null,
            a.vote_governing ?? null,
            // ';'-joined rather than an array: the pipeline writes it that way
            // and one wire format is better than two that must be kept in step.
            a.vote_flags?.length ? a.vote_flags.join(';') : null,
            a.model_verdict ?? null,
            // The DB has a CHECK that only one of confidence_marker /
            // alignment_confidence is present. Passing both would raise, which
            // is the intended outcome — a marker beside a number means the
            // caller collapsed a "not evaluated" into a value.
            a.confidence_marker ?? null,
            a.effect_marker ?? null,
            a.grade ?? null,
            a.gate_hits ?? null,
            a.senator_role ?? null,
            a.role_condition ?? null,
            a.cloture_result ?? null,
            a.promise_date ?? null,
            a.scope ?? null,
            a.valid_until ?? null,
            a.anchor_entity ?? null,
            a.bill_class ?? null,
          ],
        );
      }

      // ---- audit trail ----------------------------------------------------
      // Written inside the SAME transaction as the row it describes. A verdict
      // that committed without its trace would be exactly the unexplained
      // assertion the log exists to prevent.
      const events = [...(query.audit_events ?? [])];

      // Contract 3 is the one rule live today, and nothing calls into the audit
      // writer yet. Derive its event from the frozen result so the withholding
      // is traced now rather than when a call site gets around to it. Skipped
      // when the caller already supplied one, so wiring it explicitly later
      // does not double-write.
      const withheld =
        query.result?.scored.nd_reason === 'WITHHELD_LOW_CONFIDENCE' &&
        !events.some((e) => e.stage === 'WITHHOLDING');

      if (withheld) {
        events.push({
          seq: events.length + 1,
          stage: 'WITHHOLDING',
          rule: 'CONTRACT_3',
          disposition: 'WITHHELD',
          verdict_before: 'BROKE',
          verdict_after: 'NOT_DETERMINABLE',
          reason:
            'Accusation below the 0.7 confidence floor with no counterargument on ' +
            'the record. The evidence is shown; the conclusion is withheld.',
          detail: { derived_by: 'SupabaseQueryStore', floor: 0.7 },
        });
      }

      for (const e of events) {
        await client.query(
          `insert into app.app_verdict_audit_log (
             query_id, alignment_id, seq, stage, rule, disposition,
             verdict_before, verdict_after, confidence_before, confidence_after,
             marker, reason, senator_counterargument, critique,
             model, prompt_version, detail
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [
            queryId, e.alignment_id ?? null, e.seq, e.stage, e.rule ?? null,
            e.disposition, e.verdict_before ?? null, e.verdict_after ?? null,
            e.confidence_before ?? null, e.confidence_after ?? null,
            e.marker ?? null, e.reason ?? null, e.senator_counterargument ?? null,
            e.critique ?? null, e.model ?? null, e.prompt_version ?? null,
            e.detail ? JSON.stringify(e.detail) : null,
          ],
        );
      }

      await client.query('commit');
      return queryId;
    } catch (err) {
      await client.query('rollback').catch(() => {
        /* the connection is already broken; the original error is what matters */
      });
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Append decision events. One statement per event, one transaction for the
   * batch — a half-written trace is worse than none, because it reads as the
   * complete reasoning.
   *
   * INSERT only. The database revokes UPDATE and DELETE from receipts_app, so
   * append-only is enforced by privilege rather than by this method being
   * careful. If a correction is needed it is a new event with a later `seq`.
   */
  async appendAuditEvents(events: AuditEvent[]): Promise<void> {
    if (!events.length) return;

    const client = await this.pool.connect();
    try {
      await client.query('begin');
      for (const e of events) {
        await client.query(
          `insert into app.app_verdict_audit_log (
             query_id, alignment_id, seq, stage, rule, disposition,
             verdict_before, verdict_after, confidence_before, confidence_after,
             marker, reason, senator_counterargument, critique,
             model, prompt_version, detail
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [
            e.query_id,
            e.alignment_id ?? null,
            e.seq,
            e.stage,
            e.rule ?? null,
            e.disposition,
            e.verdict_before ?? null,
            e.verdict_after ?? null,
            e.confidence_before ?? null,
            e.confidence_after ?? null,
            e.marker ?? null,
            e.reason ?? null,
            e.senator_counterargument ?? null,
            e.critique ?? null,
            e.model ?? null,
            e.prompt_version ?? null,
            e.detail ? JSON.stringify(e.detail) : null,
          ],
        );
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => {
        /* connection already broken; the original error is what matters */
      });
      throw err;
    } finally {
      client.release();
    }
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
