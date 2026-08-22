import type { Envelope, MatchedAction } from '@receipts/shared';

// ===========================================================================
// The data seam.
//
// Every read of a senator's legislative record goes through this interface, so
// today's Pinecone (and the fixture stand-in) can become Supabase later without
// touching a single call site. ADR-009 (docs/adr/README.md).
// ===========================================================================

export interface SearchParams {
  politicianId: string;
  /** The query embedding, built with the same template as the batch pipeline. */
  vector: number[];
  /**
   * The exact text that produced `vector`. Live retrieval ignores it; the
   * fixture store scores against it lexically so the demo behaves sensibly
   * without an embeddings key.
   */
  queryText: string;
  topK: number;
}

/**
 * A search result, with the counts that make an empty one diagnosable.
 *
 * `matches` is already filtered to the WEAK floor, which used to be the only
 * number anyone saw — and it made two very different situations look identical:
 * a namespace with almost nothing in it, and a namespace full of vectors that
 * simply are not similar to this query. The first is a coverage problem; the
 * second is a query or threshold problem. Reporting only the survivors made
 * that distinction unrecoverable after the fact.
 */
export interface SearchResult {
  /** Above the WEAK floor, ordered by descending similarity. */
  matches: MatchedAction[];
  /** How many vectors the backend actually returned, BEFORE the floor. */
  returned: number;
  /** How many of those fell below the WEAK floor and were dropped. */
  belowFloor: number;
  /** The best score seen, floor or no floor. Null when nothing came back. */
  topScore: number | null;
}

export interface ActionStore {
  /** Identifies the backing implementation for logging and the UI mode banner. */
  readonly kind: 'fixture' | 'pinecone';
  /**
   * Returns matches ordered by descending similarity, already filtered to the
   * WEAK floor, plus the pre-filter counts. Never throws — an unreachable
   * backend is a structured error.
   */
  search(params: SearchParams): Promise<Envelope<SearchResult>>;
}
