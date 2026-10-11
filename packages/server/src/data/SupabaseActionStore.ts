import pg from 'pg';
import { fail, ok, type Envelope } from '@receipts/shared';
import type { ActionStore, SearchParams, SearchResult } from './ActionStore.js';
import { searchResultOf, toMatchedAction } from './PineconeActionStore.js';
import { config } from '../config.js';

const { Pool } = pg;

// ===========================================================================
// Bill search against schema `core` (docs/v2/plan.md, Phase 2). Chosen by
// ACTION_STORE=supabase; the default stays Pinecone.
//
// One vector per BILL, ranked for one member by core.match_member_bills: exact
// cosine over that member's bills, no approximate index. Like the Pinecone
// store it searches vectors the pipeline already produced and never embeds or
// re-analyses a bill (ADR-005).
//
// SAME FIELDS, SAME RULES. Each row is turned into a record keyed exactly as
// the bill-embedding workflow (WF6) keys Pinecone metadata, then handed to the
// Pinecone store's own converter and result builder. So the floor, the counts,
// the near misses, the vote casing and the missing-field rules are one piece of
// code for both stores, and a difference between them is a difference in the
// DATA — which is what gate G2 measures.
//
// What does differ, on purpose: votes come from core.member_bill_actions, which
// derives them from the roll calls. Pinecone metadata holds the votes as they
// stood when each vector was embedded, including the five sheet errors listed
// in docs/v2/reference/vote-slot-rules.md.
//
// Today's Action UIDs are kept (core.action_uids), so stored queries, traces
// and reused answers still line up.
// ===========================================================================

/** One row of the search, as SQL returns it. */
interface Row {
  action_uid: string;
  bill_id: string;
  similarity: number;
  vote: string | null;
  cloture_vote: string | null;
  passage_vote: string | null;
  is_sponsor: boolean;
  is_cosponsor: boolean;
  action_type: string | null;
  congress: number | null;
  bill_type: string | null;
  bill_number: number | null;
  title: string | null;
  summary: string | null;
  intended_effects: string | null;
  mechanisms: string | null;
  primary_issue: string | null;
  sub_issue: string | null;
  keywords: string | null;
  stakeholders: Array<{ stakeholder_uid?: string | null; group?: string | null; positive?: string | null; negative?: string | null }> | null;
}

const SQL = `
  select r.action_uid, r.bill_id, r.similarity,
         a.vote, a.cloture_vote, a.passage_vote, a.is_sponsor, a.is_cosponsor, a.action_type,
         b.congress, b.bill_type, b.bill_number,
         i.title, i.summary, i.intended_effects, i.mechanisms, i.primary_issue, i.sub_issue,
         i.keywords, i.stakeholders
    from core.match_member_bills($1, $2::extensions.vector, $3) r
    join core.member_bill_actions a on a.member_id = $1 and a.action_uid = r.action_uid
    join core.bills b on b.bill_id = r.bill_id
    join core.bill_impacts i on i.impact_id = r.impact_id`;

/** WF6 upper-cases votes and writes 'NA' for "no such vote". */
const voteOf = (v: string | null): string => (v ? v.toUpperCase() : 'NA');

/**
 * A row in WF6's metadata shape.
 *
 * `affected_stakeholders` is the JSON string WF6 writes: the sheet's own key
 * names, in its order. The evaluator receives this string verbatim, so its
 * shape is part of the prompt and is reproduced exactly.
 */
export function metadataOf(r: Row): Record<string, unknown> {
  return {
    bill_id: r.bill_id,
    congress: r.congress,
    bill_type: r.bill_type,
    bill_number: r.bill_number,
    title: r.title,
    summary: r.summary,
    intended_effects: r.intended_effects,
    mechanisms: r.mechanisms,
    affected_stakeholders: JSON.stringify(
      (r.stakeholders ?? []).map((s) => ({
        'Stakeholder UID': s.stakeholder_uid ?? '',
        'Stakeholder Group': s.group ?? '',
        'Positive Impacts': s.positive ?? '',
        'Negative Impacts': s.negative ?? '',
      })),
    ),
    action_type: r.action_type,
    is_sponsor: r.is_sponsor,
    is_cosponsor: r.is_cosponsor,
    vote: voteOf(r.vote),
    cloture_vote: voteOf(r.cloture_vote),
    passage_vote: voteOf(r.passage_vote),
    bill_keywords: r.keywords,
    primary_issue: r.primary_issue,
    sub_issue: r.sub_issue,
  };
}

export class SupabaseActionStore implements ActionStore {
  readonly kind = 'supabase' as const;

  private readonly pool: pg.Pool | null;

  constructor(connectionString: string = config.database.url) {
    this.pool = connectionString
      ? new Pool({
          connectionString,
          ssl: { rejectUnauthorized: false },
          max: 5,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 10_000,
        })
      : null;
    this.pool?.on('error', (err) => console.error('[retrieval] idle client error (non-fatal):', err.message));
  }

  async search(params: SearchParams): Promise<Envelope<SearchResult>> {
    if (!this.pool) {
      return fail({
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'ACTION_STORE=supabase needs DATABASE_URL.',
        recoverable: false,
      });
    }

    let rows: Row[];
    try {
      // The vector travels as a bound parameter in pgvector's text form.
      const res = await this.pool.query<Row>(SQL, [params.politicianId, `[${params.vector.join(',')}]`, params.topK]);
      rows = res.rows;
    } catch (err) {
      return fail({
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Could not search the record in Supabase.',
        recoverable: true,
        details: { cause: err instanceof Error ? err.message : String(err) },
      });
    }

    const all = rows.map((r) => toMatchedAction(r.action_uid, Number(r.similarity), metadataOf(r)));
    return ok(searchResultOf(all, `core:${params.politicianId}`, params.topK));
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }
}
