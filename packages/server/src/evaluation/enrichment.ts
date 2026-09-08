import pg from 'pg';
import { config } from '../config.js';
import { FLOOR_LEADERS_FALLBACK, normaliseClotureResult, type GateRefs } from './preEvaluatorGates.js';

// ===========================================================================
// ENRICHMENT — the reference data the gates need, from the Supabase mirror.
//
// SOURCE: docs/fix/08_query_tool_pipeline.md step 4 ("Enrichment from the
// evidence layer, mirrors WF10A's joins"). There is no code to port for this —
// fix/08 describes what must be exposed, not how — so this is written against
// the mirror schema rather than transcribed.
//
// ── WHY THIS EXISTS AT ALL ────────────────────────────────────────────────
// Pinecone metadata carries the votes but not the CONTEXT around them: no vote
// dates, no whip vote, no cloture outcome, no role at the action date. Without
// those, G1a, G2 and G3 all fail open — and G3 alone accounted for 15 of the 79
// false positives, because both senators in the cohort are floor leaders. The
// gates were faithfully ported long before this file existed; they simply could
// not fire.
//
// ── READS ONLY THE MIRROR, AND ONLY THE ENRICHMENT TABLES ─────────────────
// There is deliberately NO reader here for mirror_promise_alignment_matches or
// mirror_decision_scores. fix/08: the query tool runs a FRESH evaluation and
// must not inherit a corpus verdict. Those tables are also not synced and
// migration 005 revokes SELECT on them, so the guarantee rests on three
// independent things — no reader, no rows, no privilege — rather than on this
// comment.
//
// Connects as `receipts_app` through the same pooler contract as
// SupabaseQueryStore: no named prepared statements, no session state.
// ===========================================================================

const { Pool } = pg;

const S = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

/** Everything the gates and evaluator v7 need about one candidate action. */
export interface ActionEnrichment {
  cloture_vote?: string | null;
  cloture_vote_id?: string | null;
  cloture_vote_date?: string | null;
  passage_vote?: string | null;
  passage_vote_date?: string | null;
  action_date?: string | null;
  party_whip_vote?: string | null;
  stakeholder_groups?: string[];
  intended_effects?: string | null;
  mechanisms?: string | null;
}

export interface EnrichmentSource {
  readonly kind: 'mirror' | 'null';
  /** Reference lookups for the gates. */
  refs(): Promise<GateRefs>;
  /** Per-action enrichment, keyed by action_uid. */
  forActions(actionUids: string[]): Promise<Map<string, ActionEnrichment>>;
  close?(): Promise<void>;
}

/**
 * No enrichment available.
 *
 * Every reference-dependent gate then fails open, which is the source's own
 * intent — but `roleAt` still uses the hardcoded floor-leader table, because
 * that is fix/03's documented fallback rather than an absence of data.
 */
export const nullEnrichmentSource: EnrichmentSource = {
  kind: 'null',
  async refs() {
    return {
      roleAt: (politicianId, congress) =>
        FLOOR_LEADERS_FALLBACK[congress]?.[politicianId] ?? 'NONE',
      clotureResult: () => '',
      rollCallHasResult: false,
    };
  },
  async forActions() {
    return new Map();
  },
};

/**
 * Reads the `mirror` schema.
 *
 * DEFENSIVE ABOUT COLUMNS. The mirror's typed columns and the Sheets tabs do
 * not always agree — `mirror_roll_call_votes` is modelled per (vote, politician)
 * while the sheet is per vote, and the live schema has changed under a running
 * sync at least once. So every read prefers the `row` jsonb, which holds the
 * source row verbatim, and treats the typed columns as a convenience. A renamed
 * or dropped typed column then degrades a gate rather than throwing.
 */
export class MirrorEnrichmentSource implements EnrichmentSource {
  readonly kind = 'mirror' as const;

  private readonly pool: pg.Pool;

  constructor(connectionString: string = config.database.url) {
    this.pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    this.pool.on('error', (err) => {
      console.error('[enrichment] idle client error (non-fatal):', err.message);
    });
  }

  async refs(): Promise<GateRefs> {
    // Roles and cloture results are small (538 and 220 rows) and every
    // candidate needs them, so they are loaded once per request rather than
    // per row.
    const [roles, results] = await Promise.all([this.loadRoles(), this.loadClotureResults()]);

    return {
      roleAt: (politicianId, congress) => {
        // "MINORITY_WHIP:118;MAJORITY_LEADER:119" — role at THAT Congress, not
        // the senator's current one. Reading the current role would test a
        // statement's precondition against the wrong term.
        const raw = roles.get(politicianId);
        if (raw) {
          for (const part of raw.split(';')) {
            const [role, c] = part.split(':').map((x) => S(x));
            if (c === congress && role) return role.toUpperCase();
          }
        }
        return FLOOR_LEADERS_FALLBACK[congress]?.[politicianId] ?? 'NONE';
      },
      clotureResult: (voteId) => results.get(S(voteId)) ?? '',
      rollCallHasResult: results.size > 0,
    };
  }

  /** politician_id -> the raw Role cell. */
  private async loadRoles(): Promise<Map<string, string>> {
    try {
      const { rows } = await this.pool.query<{ politician_id: string; role: string | null }>(
        `select politician_id, row->>'Role' as role from mirror.mirror_politicians`,
      );
      const out = new Map<string, string>();
      for (const r of rows) if (S(r.role)) out.set(S(r.politician_id), S(r.role));
      return out;
    } catch (err) {
      // Fails open to the hardcoded table. Logged, because a silent fallback
      // would make G1c and G3 quietly stop distinguishing leaders.
      console.error('[enrichment] roles unavailable, using fallback table:', describe(err));
      return new Map();
    }
  }

  /** vote_id -> normalised cloture outcome. */
  private async loadClotureResults(): Promise<Map<string, string>> {
    try {
      const { rows } = await this.pool.query<{ vote_id: string; result: string | null }>(
        `select vote_id,
                coalesce(row->>'Result', row->>'Results', row->>'Vote Result', row->>'Outcome') as result
           from mirror.mirror_roll_call_votes`,
      );
      const out = new Map<string, string>();
      for (const r of rows) {
        const norm = normaliseClotureResult(r.result);
        if (norm) out.set(S(r.vote_id), norm);
      }
      return out;
    } catch (err) {
      console.error('[enrichment] cloture results unavailable:', describe(err));
      return new Map();
    }
  }

  async forActions(actionUids: string[]): Promise<Map<string, ActionEnrichment>> {
    const uids = actionUids.map((u) => S(u)).filter(Boolean);
    if (!uids.length) return new Map();

    const out = new Map<string, ActionEnrichment>();

    // Enrich AFTER the evidence gate, so this reads the 2–4 admitted
    // candidates rather than all 10 — the mitigation data/sheets.ts calls for
    // and the reason this is keyed by action_uid rather than by senator.
    try {
      const { rows } = await this.pool.query<{
        action_uid: string;
        row: Record<string, unknown>;
      }>(
        `select action_uid, row
           from mirror.mirror_politician_bill_actions
          where action_uid = any($1::text[])`,
        [uids],
      );
      for (const r of rows) {
        const j = r.row ?? {};
        out.set(S(r.action_uid), {
          cloture_vote: pickRow(j, 'Cloture Vote'),
          cloture_vote_id: pickRow(j, 'Cloture Vote ID'),
          cloture_vote_date: pickRow(j, 'Cloture Vote Date'),
          passage_vote: pickRow(j, 'Passage Vote'),
          passage_vote_date: pickRow(j, 'Passage Vote Date'),
          action_date: pickRow(j, 'Action Date'),
        });
      }
    } catch (err) {
      console.error('[enrichment] bill actions unavailable:', describe(err));
    }

    // The whip's vote lives in the 'Vote' column of Party Vote Positions —
    // there is no 'Party Alignment' column on that tab, so the mirror's typed
    // column of that name is null by design. G3 needs the vote, not a label.
    const clotureIds = [...out.values()].map((e) => S(e.cloture_vote_id)).filter(Boolean);
    if (clotureIds.length) {
      try {
        const { rows } = await this.pool.query<{ vote_id: string; vote: string | null }>(
          `select vote_id, row->>'Vote' as vote
             from mirror.mirror_party_vote_positions
            where vote_id = any($1::text[])`,
          [clotureIds],
        );
        const whip = new Map<string, string>();
        for (const r of rows) if (S(r.vote)) whip.set(S(r.vote_id), S(r.vote));
        for (const [uid, e] of out) {
          const v = whip.get(S(e.cloture_vote_id));
          if (v) out.set(uid, { ...e, party_whip_vote: v });
        }
      } catch (err) {
        console.error('[enrichment] whip votes unavailable — G3 will fail open:', describe(err));
      }
    }

    return out;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Case-insensitive read from the verbatim source row. */
function pickRow(row: Record<string, unknown>, name: string): string | null {
  const target = name.toLowerCase();
  for (const k of Object.keys(row)) {
    if (k.trim().toLowerCase() === target) {
      const v = S(row[k]);
      // 'NA' is the upstream marker for "no such vote was recorded". It is not
      // a date and not a vote, so it becomes null here rather than travelling
      // as a string the gates would try to parse.
      return !v || v === 'NA' || v === 'N/A' ? null : v;
    }
  }
  return null;
}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Chosen by credential presence, exactly like the other stores.
 *
 * No DATABASE_URL means no mirror, which means the gates fail open — reported
 * at startup rather than discovered when a gate silently never fires.
 */
export const enrichmentSource: EnrichmentSource = config.database.url
  ? new MirrorEnrichmentSource()
  : nullEnrichmentSource;
