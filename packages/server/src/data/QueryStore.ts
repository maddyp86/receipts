import type { Interpretation, QueryResult } from '@receipts/shared';

// ===========================================================================
// The product-storage seam: user queries and sessions.
//
// Same shape as ActionStore — one interface, a local implementation now, a
// Supabase implementation when credentials exist, chosen in services.ts by
// credential presence.
//
// ── THE RULE THIS SEAM ENFORCES IN ITS SHAPE ───────────────────────────────
// A stored user query is NEVER evidence about a senator.
//
// So there is deliberately no method here that reads app data in aggregate:
// no getPriorVerdicts, no getSimilarQueries, no countQueriesFor(senator). The
// only read is by id, to render a shared result back to the person who made it.
//
// That is not an oversight to be filled in later. The moment this interface can
// answer "what has anyone else asked about this senator", it becomes possible
// to let that answer influence a verdict — and the influence would look like an
// ordinary feature in review. Postgres grants stop the trust index reading app
// data (see docs/supabase-schema-proposal.md); this interface stops the app
// building the query in the first place.
//
// NOTE this constrains the REQUEST PATH, not analysis. Querying app_queries
// directly — for training, for "what do people ask", for prompt evaluation — is
// the intended use of that table and needs no method here. The rule is only
// that nothing on the way to a verdict can read it. Usage counts and funnels
// live in PostHog; see docs/analytics-posthog-proposal.md.
// ===========================================================================

/**
 * One retrieved candidate — admitted or not.
 *
 * Mirrors W7B's `Promise Matches` + `Unmatched Promises` pair, collapsed into
 * one shape with an `admitted` flag. The rejected rows are the point: they are
 * how "retrieval found nothing" is told apart from "the gate rejected
 * everything", which are identical from the parent row alone.
 */
export interface StoredMatch {
  action_uid: string;
  bill_id: string;
  bill_title: string;
  bill_summary: string;
  bill_primary_issue: string;
  bill_sub_issue: string;
  similarity_score: number | null;
  match_strength: string | null;
  match_rank: number | null;
  match_direction: string | null;
  vote: string | null;
  cloture_vote: string | null;
  passage_vote: string | null;
  is_sponsor: string | null;
  is_cosponsor: string | null;
  action_type: string | null;
  relevance_verdict: string | null;
  topic_relevant: string | null;
  action_relevant: string | null;
  effort_relevant: string | null;
  specificity_match: string | null;
  no_vote_available: boolean | null;
  confidence: number | null;
  composite_score: number | null;
  evaluation_status: string | null;
  terminal_status: string | null;
  llm_reasoning: string | null;
  admitted: boolean;
  partial_subtype: string | null;
  /** The gate's own vocabulary, e.g. 'PARTIAL/DIRECTIONAL'. Null when admitted. */
  exclusion_reason: string | null;
}

/**
 * One admitted match that went through fulfillment — the KEPT/BROKE half.
 *
 * Mirrors WF10A's `Promise Alignment - Matches`, minus the enrichment columns
 * the app does not fetch (donor, party whip, reversal target, stakeholder
 * impacts). Those are omitted rather than written empty: a null would suggest
 * the data was sought and absent, which is not the same as never asked for.
 */
export interface StoredAlignment {
  action_uid: string;
  bill_id: string;
  bill_effect: string;
  bill_effect_reasoning: string;
  promise_alignment: string | null;
  alignment_confidence: number | null;
  alignment_reasoning: string | null;
  /** WF10A's Model Verdict / Model Agreed — the orchestrator's cross-check. */
  model_bill_effect: string | null;
  model_agreed: boolean | null;
  outcome: string | null;
  direction: string | null;
  evidence_type: string | null;
  action_tier: string | null;
  vote_pattern: string | null;
  weight: number | null;
  scoring_flags: string[] | null;
}

/**
 * What a completed query is worth persisting.
 *
 * This is the training/analysis record, not a log line. `promise_text` sitting
 * alongside the classification, the retrieval outcome and the verdict is the
 * whole point: it is the only dataset that can answer "what do people actually
 * ask, and did we answer it well".
 */
export interface StoredQuery {
  id: string;
  session_id: string;
  politician_id: string;
  /**
   * The user's text, verbatim.
   *
   * Captured deliberately, and stored HERE rather than in analytics so it can
   * be joined and queried with SQL. It sits behind the corpus firewall — the
   * scorer holds no privilege on this schema — so storing it does not weaken
   * the guarantee that a user's query can never become evidence about a
   * senator. See docs/supabase-schema-proposal.md.
   */
  promise_text: string;
  interpretation: Interpretation;
  /** The frozen result, stored whole so a shared link renders what the user saw. */
  result: QueryResult | null;
  /**
   * Persisted attribution. When the Campaign Promise vocabulary came from the
   * user asserting the premise, that must survive every read-back — a share
   * link that drops it silently converts their claim into ours.
   */
  user_asserted_premise: boolean;
  /** Operational context: which models ran, and whether any leg was degraded. */
  models_used?: Record<string, string>;
  degraded?: Record<string, unknown>;
  /** Every retrieved candidate, admitted or not. */
  matches?: StoredMatch[];
  /** Every admitted match that went through fulfillment. */
  alignments?: StoredAlignment[];
}

export interface QueryStore {
  readonly kind: 'local' | 'supabase';

  /** Open (or touch) a session. */
  startSession(meta: { userAgent?: string; clientHash?: string }): Promise<string>;

  /** Persist a completed query. Failure must never fail the user's query. */
  saveQuery(query: Omit<StoredQuery, 'id'>): Promise<string>;

  /**
   * Read one stored query back, by id, for a share link.
   *
   * By id ONLY. There is no list, no search, no filter by senator — see the
   * note at the top of this file.
   */
  getQuery(id: string): Promise<StoredQuery | null>;
}

/**
 * The no-persistence implementation.
 *
 * Used until Supabase credentials exist. It is honest about being a no-op:
 * `getQuery` returns null rather than a plausible reconstruction, and `saveQuery`
 * returns an id that resolves to nothing. A share link built on it will report
 * "not found", which is true — it is not a stub that pretends the write landed.
 */
export class NullQueryStore implements QueryStore {
  readonly kind = 'local' as const;

  /** Warn once, not per query — a log line per request is noise, not signal. */
  private warned = false;

  private warnOnce(): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(
      '[persist] DATABASE_URL is not set — queries are NOT being stored. ' +
        'The app answers normally; app_queries stays empty and share links 404.',
    );
  }

  async startSession(_meta: { userAgent?: string; clientHash?: string } = {}): Promise<string> {
    return crypto.randomUUID();
  }

  async saveQuery(_query: Omit<StoredQuery, 'id'>): Promise<string> {
    // Nothing is written. Callers must treat persistence as best-effort and
    // never gate the user's result on it.
    this.warnOnce();
    return crypto.randomUUID();
  }

  async getQuery(_id: string): Promise<StoredQuery | null> {
    return null;
  }
}
