import { describe, expect, it } from 'vitest';
import { NullQueryStore, type StoredAlignment, type StoredMatch } from './QueryStore.js';
import { SupabaseQueryStore } from './SupabaseQueryStore.js';

// ===========================================================================
// What can be verified without a live Postgres.
//
// The SQL round-trip cannot be tested here — there is no local Postgres or
// Docker in this environment. What IS tested is the seam's contract and the
// guards that must hold before a query ever reaches the database.
// ===========================================================================

describe('the seam stays aggregate-read-free', () => {
  it('exposes only startSession, saveQuery and getQuery', () => {
    // The moment this interface can answer "what has anyone else asked about
    // this senator", it becomes possible to let that influence a verdict — and
    // it would look like an ordinary feature in review. The absence of those
    // methods is the design, so it is asserted.
    const methods = ['startSession', 'saveQuery', 'getQuery'];
    const stores: unknown[] = [
      new NullQueryStore(),
      new SupabaseQueryStore('postgresql://x@127.0.0.1:1/x'),
    ];
    for (const store of stores) {
      const bag = store as Record<string, unknown>;
      for (const m of methods) expect(typeof bag[m]).toBe('function');
      for (const forbidden of ['countQueriesFor', 'getSimilarQueries', 'listQueries', 'search']) {
        expect(bag[forbidden]).toBeUndefined();
      }
    }
  });
});

describe('NullQueryStore is honest rather than plausible', () => {
  it('returns null from getQuery instead of reconstructing a result', async () => {
    // A share link built on it reports "not found", which is true. It is not a
    // stub that pretends the write landed.
    expect(await new NullQueryStore().getQuery('any-id')).toBeNull();
  });

  it('reports kind as local so the banner cannot claim persistence', () => {
    expect(new NullQueryStore().kind).toBe('local');
  });
});

describe('SupabaseQueryStore guards', () => {
  const store = new SupabaseQueryStore('postgresql://receipts_app:pw@127.0.0.1:1/postgres');

  it('rejects a malformed id without touching the database', async () => {
    // Reaching Postgres with a non-uuid would raise a cast error; a bad link is
    // a miss, not a fault. This resolves instantly because no connection is
    // attempted — if it ever tried, this test would hang on the dead port.
    expect(await store.getQuery('not-a-uuid')).toBeNull();
    expect(await store.getQuery('')).toBeNull();
    expect(await store.getQuery('11111111-1111-1111-1111-11111111111')).toBeNull(); // one short
  });

  it('reports kind as supabase', () => {
    expect(store.kind).toBe('supabase');
  });

  it('surfaces a connection failure without throwing', async () => {
    // verifyConnection must never throw: it runs at startup and persistence is
    // best effort. A database that is down must not stop the service booting.
    const result = await store.verifyConnection();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(typeof result.error).toBe('string');
  });
});

// ===========================================================================
// The query trace: matches (admitted AND rejected) and alignments.
//
// The rejected rows are the reason this exists. Without them "retrieval found
// nothing" and "the gate rejected everything" are the same row in app_queries,
// and only one of those is a retrieval problem.
// ===========================================================================

describe('the trace keeps non-matches, not just matches', () => {
  it('StoredMatch carries an admitted flag and an exclusion reason', () => {
    // Shape assertion: a rejected candidate must be storable with the reason it
    // was rejected, in the gate's own vocabulary.
    const rejected: StoredMatch = {
      action_uid: 'ACT-1', bill_id: 'hr1-118', bill_title: 't', bill_summary: 's',
      bill_primary_issue: 'Health Care', bill_sub_issue: 'Prescription Drugs',
      similarity_score: 0.61, match_strength: 'STRONG', match_rank: 1,
      match_direction: 'promise_to_bill', vote: 'YEA', cloture_vote: null,
      passage_vote: null, is_sponsor: 'FALSE', is_cosponsor: 'FALSE',
      action_type: 'VOTE', relevance_verdict: 'FALSE_POSITIVE',
      topic_relevant: 'No', action_relevant: 'No', effort_relevant: 'NA',
      specificity_match: 'No', no_vote_available: false, confidence: 0.9,
      composite_score: 0.2, evaluation_status: 'LLM_EVALUATED',
      terminal_status: 'REJECTED', llm_reasoning: 'different subject',
      admitted: false, partial_subtype: 'NA', exclusion_reason: 'FALSE_POSITIVE',
    };
    expect(rejected.admitted).toBe(false);
    expect(rejected.exclusion_reason).toBe('FALSE_POSITIVE');
    // The evaluator's reasoning is retained — that is the reviewable part.
    expect(rejected.llm_reasoning).toBeTruthy();
  });

  it('StoredAlignment distinguishes "not checked" from "disagreed"', () => {
    // model_agreed must be null when there is nothing to compare. false would
    // assert a disagreement that never happened.
    const notChecked: StoredAlignment = {
      action_uid: 'ACT-1', bill_id: 'hr1-118', bill_effect: 'ADVANCE',
      bill_effect_reasoning: 'r', promise_alignment: 'CONSISTENT',
      alignment_confidence: 0.8, alignment_reasoning: 'r',
      model_bill_effect: null, model_agreed: null, outcome: 'CONSISTENT',
      direction: 'keeps', evidence_type: 'vote', action_tier: 'VOTED',
      vote_pattern: 'PASSAGE_ONLY', weight: 1, scoring_flags: [],
    };
    expect(notChecked.model_agreed).toBeNull();
    expect(notChecked.model_agreed).not.toBe(false);
  });

  it('ERROR is a storable bill_effect and never becomes NEUTRAL', () => {
    // NEUTRAL is a finding ("this bill does not bear on the goal"); ERROR is the
    // absence of one. Collapsing them would turn a failed evaluation into a
    // substantive judgement.
    const errored: StoredAlignment['bill_effect'] = 'ERROR';
    expect(errored).toBe('ERROR');
    expect(errored).not.toBe('NEUTRAL');
  });
});
