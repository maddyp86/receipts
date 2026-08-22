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

export interface ActionStore {
  /** Identifies the backing implementation for logging and the UI mode banner. */
  readonly kind: 'fixture' | 'pinecone';
  /**
   * Returns matches ordered by descending similarity, already filtered to the
   * WEAK floor. Never throws — an unreachable backend is a structured error.
   */
  search(params: SearchParams): Promise<Envelope<MatchedAction[]>>;
}
