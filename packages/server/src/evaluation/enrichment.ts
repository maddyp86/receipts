import pg from 'pg';
import { config } from '../config.js';
import { FLOOR_LEADERS_FALLBACK, normaliseClotureResult, type GateRefs } from './preEvaluatorGates.js';
import type { VersionMirrorRow } from './textVersions.js';

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

/**
 * What the pipeline records about a senator's sponsorship of one bill.
 *
 * WF2c `Extract Progress & Effort` writes these ten columns onto
 * `Politician Bill Actions`. They describe the RECORD, not effort: a tier of
 * SPONSOR_ADVANCED says the bill moved past referral, never that the sponsor
 * pushed it there. Nothing here may reach a numeric score — see
 * `scoring/effortSignal.ts` for why (the sponsorship double-count).
 *
 * Every field is optional and absence means UNKNOWN, never a negative. A row
 * from before WF2c ran, or a mirror that is behind, must degrade the narrative
 * rather than assert that a senator did nothing.
 */
export interface SponsorshipEnrichment {
  /** SPONSOR_ADVANCED · SPONSOR_STALLED · ORIGINAL_COSPONSOR · LATE_COSPONSOR · UNRESOLVED · NA_VOTE_ONLY */
  sponsor_tier?: string | null;
  /**
   * The date the senator actually joined the bill.
   *
   * LOAD-BEARING, and the reason this field exists. The ingestion workflow
   * stamps every cosponsorship row's `Action Date` with the bill's
   * INTRODUCTION date, so `Action Date` is wrong for late cosponsors —
   * measured on the live mirror: 171 of 172 LATE_COSPONSOR rows disagree with
   * it, by up to 659 days. Any date test about a cosponsorship reads this.
   */
  cosponsored_at?: string | null;
  original_cosponsor?: boolean | null;
  /** Position among cosponsors ordered by join date. Null for a sponsor. */
  cosponsor_ordinal?: number | null;
  /** All cosponsors including withdrawn. */
  cosponsor_total?: number | null;
  days_after_introduction?: number | null;
  /** Date the name was removed. DISCLOSE ONLY — never scored, never weighted. */
  withdrawn_at?: string | null;
  /**
   * TRUE · FALSE · NO_COMMITTEE · NA_PRIOR_CONGRESS · UNAVAILABLE.
   *
   * Kept as the raw marker rather than a boolean: NA_PRIOR_CONGRESS (membership
   * is computed for the current Congress only) and UNAVAILABLE (the roster
   * fetch failed) are both "we do not know", and a boolean would turn either
   * into "he does not sit on it".
   */
  committee_member?: string | null;
  /** Committees the bill was referred to AND the senator sits on. */
  committee_member_of?: string[];
  progress_checked_at?: string | null;
}

/** Everything the gates and evaluator v7 need about one candidate action. */
export interface ActionEnrichment extends SponsorshipEnrichment {
  cloture_vote?: string | null;
  cloture_vote_id?: string | null;
  cloture_vote_date?: string | null;
  passage_vote?: string | null;
  passage_vote_date?: string | null;
  action_date?: string | null;
  party_whip_vote?: string | null;
  /**
   * The roll call's own description of the cloture vote — "Motion to Invoke
   * Cloture on the Motion to Proceed to H.R. 5334". Read so the text selector
   * can tell cloture on taking up a bill from cloture on the bill itself.
   */
  cloture_vote_question?: string | null;
  stakeholder_groups?: string[];
  intended_effects?: string | null;
  mechanisms?: string | null;
}

/**
 * How far a bill got and how it ended, from `Bills Master` via WF2c.
 *
 * PRESENTATION ONLY. Progress may change how a finding is worded — "did not
 * advance past committee" is a fact a reader deserves — but it may never flip a
 * verdict and never enter a numeric score. The vocabulary is deliberately about
 * the record: a bill that reached IN_COMMITTEE was given a hearing or reported,
 * which says nothing about who moved it there.
 */
export interface BillEnrichment {
  /** INTRODUCED → REFERRED → IN_COMMITTEE → … → ENACTED / VETOED. */
  progress_stage?: string | null;
  /** ACTIVE · ENACTED · VETOED · FAILED · PROV_KILL · AGREED_TO · DIED_AT_<stage>. */
  progress_outcome?: string | null;
  progress_stage_at?: string | null;
  last_action_at?: string | null;
  last_action_text?: string | null;
  /** e.g. 'SSCM: Referred To, Reported By'. The citable form of the tier. */
  committee_activity?: string | null;
  referred_committees?: string[];
  /** Active (non-withdrawn) cosponsors. */
  cosponsor_count?: number | null;
  /**
   * 'SELF', or the bill whose enactment carried this text.
   *
   * A bill that "died" whose text became law under another number is a kept
   * promise the current output misses entirely. Null when unknown.
   */
  enacted_via?: string | null;
}

/**
 * What a bill's BILL-LEVEL impact statement records about the policy it
 * reverses (mirror.mirror_impact_statements). The evaluator's v7 prompt reads
 * these to decide direction on a reversal — a disapproval resolution,
 * typically — and treats an absent value as "false" / "N/A".
 *
 * Strings, as the prompt prints them. Null when the statement has none.
 */
export interface BillStatement {
  reverses_existing_policy: string | null;
  target_name: string | null;
  target_source: string | null;
  target_effect: string | null;
  /**
   * The sheet's `Flagged For Review` column: this summary is under review
   * and its direction is not to be trusted (evaluation/summaryReview.ts).
   * True only for a JSON true or the string "true"; blank is not flagged.
   */
  flagged_for_review: boolean;
}

/** The reversal fields of one bill-level statement row. */
export function billStatementOf(row: Record<string, unknown>): BillStatement {
  const v = (k: string) => S(pickRow(row, k)) || null;
  return {
    reverses_existing_policy: v('Reverses Existing Policy'),
    target_name: v('Target Name'),
    target_source: v('Target Source'),
    target_effect: v('Target Effect'),
    flagged_for_review: S(pickRow(row, 'Flagged For Review')).toLowerCase() === 'true',
  };
}

/** The reader-facing grouping of each read, for the notice on the result. */
export const ENRICHMENT_GAP_OF: Record<EnrichmentPart, import('@receipts/shared').EnrichmentGap> = {
  actions: 'vote_records',
  roles: 'roll_call_context',
  cloture_results: 'roll_call_context',
  whip_votes: 'roll_call_context',
  cloture_questions: 'roll_call_context',
  bill_progress: 'bill_progress',
  text_versions: 'text_versions',
  bill_statements: 'bill_statements',
};

/** One read the reader makes. Each fails independently and fails open. */
export type EnrichmentPart =
  | 'roles'
  | 'cloture_results'
  | 'actions'
  | 'whip_votes'
  | 'cloture_questions'
  | 'bill_progress'
  | 'text_versions'
  | 'bill_statements';

/**
 * Told about a read that failed, for THIS request.
 *
 * A callback rather than state on the reader, because the reader is one
 * shared instance serving concurrent requests: a failure recorded on it would
 * be reported on whichever request asked next. Every read still fails open —
 * this only makes the failure visible to the run that suffered it.
 */
export type EnrichmentReport = (part: EnrichmentPart, message: string) => void;

export interface EnrichmentSource {
  readonly kind: 'mirror' | 'null';
  /** Reference lookups for the gates. */
  refs(report?: EnrichmentReport): Promise<GateRefs>;
  /** Per-action enrichment, keyed by action_uid. */
  forActions(actionUids: string[], report?: EnrichmentReport): Promise<Map<string, ActionEnrichment>>;
  /** Per-bill progress, keyed by bill_id. */
  forBills(billIds: string[], report?: EnrichmentReport): Promise<Map<string, BillEnrichment>>;
  /**
   * Every per-version impact statement for these bills, keyed by bill_id.
   * A bill with none is simply absent from the map — the normal case.
   */
  forVersions(billIds: string[], report?: EnrichmentReport): Promise<Map<string, VersionMirrorRow[]>>;
  /** Bill-level impact statements' reversal fields, keyed by bill_id. */
  forBillStatements(billIds: string[], report?: EnrichmentReport): Promise<Map<string, BillStatement>>;
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
  async forBills() {
    return new Map();
  },
  async forVersions() {
    return new Map();
  },
  async forBillStatements() {
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

  async refs(report?: EnrichmentReport): Promise<GateRefs> {
    // Roles and cloture results are small (538 and 220 rows) and every
    // candidate needs them, so they are loaded once per request rather than
    // per row.
    const [roles, results] = await Promise.all([this.loadRoles(report), this.loadClotureResults(report)]);

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
  private async loadRoles(report?: EnrichmentReport): Promise<Map<string, string>> {
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
      report?.('roles', describe(err));
      return new Map();
    }
  }

  /** vote_id -> normalised cloture outcome. */
  private async loadClotureResults(report?: EnrichmentReport): Promise<Map<string, string>> {
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
      report?.('cloture_results', describe(err));
      return new Map();
    }
  }

  async forActions(actionUids: string[], report?: EnrichmentReport): Promise<Map<string, ActionEnrichment>> {
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
          ...sponsorshipOf(j),
        });
      }
    } catch (err) {
      console.error('[enrichment] bill actions unavailable:', describe(err));
      report?.('actions', describe(err));
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
        report?.('whip_votes', describe(err));
      }

      // What each cloture vote was ON. Question first; the Result string says
      // "Cloture on the Motion to Proceed Agreed to" too, so it stands in when
      // the question is blank.
      try {
        const { rows } = await this.pool.query<{ vote_id: string; question: string | null }>(
          `select vote_id, coalesce(nullif(row->>'Question', ''), row->>'Result') as question
             from mirror.mirror_roll_call_votes
            where vote_id = any($1::text[])`,
          [clotureIds],
        );
        const questions = new Map<string, string>();
        for (const r of rows) if (S(r.question)) questions.set(S(r.vote_id), S(r.question));
        for (const [uid, e] of out) {
          const q = questions.get(S(e.cloture_vote_id));
          if (q) out.set(uid, { ...e, cloture_vote_question: q });
        }
      } catch (err) {
        console.error('[enrichment] cloture vote questions unavailable — text dated by cloture:', describe(err));
        report?.('cloture_questions', describe(err));
      }
    }

    return out;
  }

  /**
   * Bill progress, batched by bill_id exactly as `forActions` batches by
   * action_uid — the candidates are already down to the 2–4 the evidence gate
   * admitted, so this is one query per request rather than one per row.
   *
   * A bill with no row here returns nothing, and every consumer treats that as
   * "we do not know how far it got" rather than "it went nowhere".
   */
  async forBills(billIds: string[], report?: EnrichmentReport): Promise<Map<string, BillEnrichment>> {
    const ids = [...new Set(billIds.map((b) => S(b)).filter(Boolean))];
    if (!ids.length) return new Map();

    const out = new Map<string, BillEnrichment>();
    try {
      const { rows } = await this.pool.query<{
        bill_id: string;
        row: Record<string, unknown>;
      }>(
        `select bill_id, row
           from mirror.mirror_bills_master
          where bill_id = any($1::text[])`,
        [ids],
      );
      for (const r of rows) out.set(S(r.bill_id), billProgressOf(r.row ?? {}));
    } catch (err) {
      // Same posture as every other reader here: a missing table or a renamed
      // column costs the narrative its progress clause, never the verdict.
      console.error('[enrichment] bill progress unavailable:', describe(err));
      report?.('bill_progress', describe(err));
    }
    return out;
  }

  /**
   * Per-version impact statements, batched by bill_id.
   *
   * Returns the rows as stored. Choosing among them — and refusing a
   * `Version Mismatch` row — is `selectTextVersion`'s job, so the rule lives in
   * one tested place rather than half in SQL.
   */
  async forVersions(billIds: string[], report?: EnrichmentReport): Promise<Map<string, VersionMirrorRow[]>> {
    const ids = [...new Set(billIds.map((b) => S(b)).filter(Boolean))];
    if (!ids.length) return new Map();

    const out = new Map<string, VersionMirrorRow[]>();
    try {
      const { rows } = await this.pool.query<VersionMirrorRow>(
        `select impact_version_uid, bill_id, text_version_code, text_version_date, row
           from mirror.mirror_impact_statement_versions
          where bill_id = any($1::text[])`,
        [ids],
      );
      for (const r of rows) {
        const id = S(r.bill_id);
        if (!out.has(id)) out.set(id, []);
        out.get(id)!.push(r);
      }
    } catch (err) {
      // A missing or unreadable table means every bill is evaluated against
      // its latest summary — today's behaviour — rather than failing the query.
      console.error('[enrichment] text versions unavailable — using latest summaries:', describe(err));
      report?.('text_versions', describe(err));
    }
    return out;
  }

  /**
   * The bill-level impact statement's reversal fields, batched by bill_id.
   *
   * Read for the evaluator's fallback: when no usable text version applies,
   * the candidate is the bill-level summary, and without these the prompt
   * printed "Reverses Existing Policy: false" even for a disapproval
   * resolution. A selected version still supplies its own (applyTextVersion).
   */
  async forBillStatements(billIds: string[], report?: EnrichmentReport): Promise<Map<string, BillStatement>> {
    const ids = [...new Set(billIds.map((b) => S(b)).filter(Boolean))];
    if (!ids.length) return new Map();

    const out = new Map<string, BillStatement>();
    try {
      const { rows } = await this.pool.query<{ bill_id: string; row: Record<string, unknown> }>(
        `select bill_id, row
           from mirror.mirror_impact_statements
          where bill_id = any($1::text[])`,
        [ids],
      );
      for (const r of rows) out.set(S(r.bill_id), billStatementOf(r.row ?? {}));
    } catch (err) {
      // Fails open to today's prompt (reversal fields absent), and says so:
      // this read feeds the evaluator's direction, so its failure is decisive.
      console.error('[enrichment] bill-level statements unavailable — reversal fields absent:', describe(err));
      report?.('bill_statements', describe(err));
    }
    return out;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * The ten WF2c columns, read from the verbatim source row.
 *
 * Exported for the tests, which pin the parse against real mirror rows rather
 * than against a live database.
 */
export function sponsorshipOf(row: Record<string, unknown>): SponsorshipEnrichment {
  const committees = pickRow(row, 'Committee Member Of');
  return {
    sponsor_tier: pickRow(row, 'Sponsor Tier'),
    cosponsored_at: pickRow(row, 'Cosponsored At'),
    original_cosponsor: boolOf(pickRow(row, 'Original Cosponsor')),
    cosponsor_ordinal: intOf(pickRow(row, 'Cosponsor Ordinal')),
    cosponsor_total: intOf(pickRow(row, 'Cosponsor Total')),
    days_after_introduction: intOf(pickRow(row, 'Days After Introduction')),
    withdrawn_at: pickRow(row, 'Withdrawn At'),
    // NOT run through pickRow's NA-to-null rule alone: NO_COMMITTEE,
    // NA_PRIOR_CONGRESS and UNAVAILABLE are meaningful markers and must survive
    // as themselves. Plain 'NA' (a vote-only row) still becomes null.
    committee_member: pickRow(row, 'Committee Member'),
    committee_member_of: committees
      ? committees.split(';').map((c) => c.trim()).filter(Boolean)
      : undefined,
    progress_checked_at: pickRow(row, 'Progress Checked At'),
  };
}

/** The `Bills Master` progress columns, read from the verbatim source row. */
export function billProgressOf(row: Record<string, unknown>): BillEnrichment {
  const referred = pickRow(row, 'Referred Committees');
  return {
    progress_stage: pickRow(row, 'Progress Stage'),
    progress_outcome: pickRow(row, 'Progress Outcome'),
    progress_stage_at: pickRow(row, 'Progress Stage At'),
    last_action_at: pickRow(row, 'Last Action At'),
    last_action_text: pickRow(row, 'Last Action Text'),
    committee_activity: pickRow(row, 'Committee Activity'),
    referred_committees: referred
      ? referred.split(';').map((c) => c.trim()).filter(Boolean)
      : undefined,
    cosponsor_count: intOf(pickRow(row, 'Cosponsor Count')),
    enacted_via: pickRow(row, 'Enacted Via'),
  };
}

/**
 * Sheet booleans, which arrive as 'TRUE' / 'true' / true.
 *
 * Null rather than false when absent: `Original Cosponsor` is 'NA' on sponsor
 * and vote-only rows, and reading that as "not an original cosponsor" would
 * describe a bill's own author as a latecomer.
 */
function boolOf(v: string | null): boolean | null {
  if (v === null) return null;
  const t = v.toUpperCase();
  if (t === 'TRUE' || t === 'YES' || t === 'Y' || t === '1') return true;
  if (t === 'FALSE' || t === 'NO' || t === 'N' || t === '0') return false;
  return null;
}

/** Sheet integers. Null on 'NA', blank, or anything non-numeric. */
function intOf(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
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
