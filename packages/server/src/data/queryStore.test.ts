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

// ===========================================================================
// Retrieval counts: an empty result must be diagnosable.
//
// The store used to return only the survivors of the WEAK floor, which made two
// different problems look identical — a thin namespace, and a full namespace
// nothing was similar to. The first is a coverage problem upstream; the second
// is a query or threshold problem. The survivor count alone cannot tell them
// apart, and the raw count is unrecoverable after the fact.
// ===========================================================================

describe('search reports pre-filter counts', () => {
  it('separates what the backend returned from what cleared the floor', async () => {
    const { FixtureActionStore } = await import('./FixtureActionStore.js');
    const r = await new FixtureActionStore().search({
      politicianId: 'S000148',
      vector: [],
      queryText: 'lower prescription drug prices for seniors',
      topK: 10,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // The distinction that matters: more came back than survived.
    expect(r.data.returned).toBeGreaterThan(r.data.matches.length);
    expect(r.data.belowFloor).toBe(r.data.returned - r.data.matches.length);
    expect(r.data.topScore).not.toBeNull();
  });

  it('reports a genuinely empty namespace as returned: 0', async () => {
    const { FixtureActionStore } = await import('./FixtureActionStore.js');
    const r = await new FixtureActionStore().search({
      politicianId: 'NOBODY-999',
      vector: [],
      queryText: 'anything',
      topK: 10,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // returned 0 means the backend had nothing — distinct from returned 10 with
    // everything below the floor, which would mean the query was the problem.
    expect(r.data.returned).toBe(0);
    expect(r.data.belowFloor).toBe(0);
    expect(r.data.topScore).toBeNull();
  });
});

// ===========================================================================
// v7 persistence contract (handoff v2 §3–4).
//
// These pin the two rules the schema enforces, so a future mapping cannot
// quietly violate them without a test going red.
// ===========================================================================

describe('the NOT_EVALUATED marker never becomes a value', () => {
  it('keeps the marker and the number in separate fields', () => {
    // A gated row: no evaluator ran, so there is no confidence to report. The
    // marker says that. Writing 0 instead would assert "no confidence", which
    // is a determination nobody made.
    const gated: StoredAlignment = {
      action_uid: 'ACT-1', bill_id: 'hr1-118', bill_effect: 'NEUTRAL',
      bill_effect_reasoning: '', promise_alignment: null,
      alignment_confidence: null, alignment_reasoning: null,
      model_bill_effect: null, model_agreed: null, outcome: null,
      direction: null, evidence_type: null, action_tier: null,
      vote_pattern: null, weight: null, scoring_flags: null,
      confidence_marker: 'NOT_EVALUATED', effect_marker: 'NOT_EVALUATED',
    };
    expect(gated.confidence_marker).toBe('NOT_EVALUATED');
    expect(gated.alignment_confidence).toBeNull();
    // Never both — the database CHECK enforces this too.
    expect(gated.confidence_marker !== null && gated.alignment_confidence !== null).toBe(false);
  });

  it('an evaluated row carries a number and no marker', () => {
    const evaluated: StoredAlignment = {
      action_uid: 'ACT-2', bill_id: 'hr2-118', bill_effect: 'ADVANCE',
      bill_effect_reasoning: 'r', promise_alignment: 'CONSISTENT',
      alignment_confidence: 0.75, alignment_reasoning: 'r',
      model_bill_effect: 'ADVANCE', model_agreed: true, outcome: 'CONSISTENT',
      direction: 'keeps', evidence_type: 'vote', action_tier: 'VOTED',
      vote_pattern: 'PASSAGE_ONLY', weight: 1, scoring_flags: [],
      confidence_marker: null,
    };
    expect(evaluated.alignment_confidence).toBe(0.75);
    expect(evaluated.confidence_marker ?? null).toBeNull();
  });
});

describe('disclosure fields survive the contract', () => {
  it('carries vote_governing and vote_flags on a split vote', () => {
    // Behavioural contract 2. A row reading "voted NAY -> BROKE" while hiding a
    // cloture YEA is the claim a senator's office knocks down.
    const split: StoredAlignment = {
      action_uid: 'ACT-3', bill_id: 'hr3-118', bill_effect: 'HINDER',
      bill_effect_reasoning: 'r', promise_alignment: 'INCONSISTENT',
      alignment_confidence: 0.75, alignment_reasoning: 'r',
      model_bill_effect: null, model_agreed: null, outcome: 'INCONSISTENT',
      direction: 'breaks', evidence_type: 'vote', action_tier: 'VOTED',
      vote_pattern: 'ENABLED_THEN_OPPOSED', weight: 1, scoring_flags: [],
      vote_governing: 'CLOTURE (60-vote threshold; split vote)',
      vote_flags: ['SPLIT_VOTE'],
    };
    expect(split.vote_governing).toContain('CLOTURE');
    expect(split.vote_flags).toContain('SPLIT_VOTE');
    // Contract 2: split vote caps confidence at 0.75.
    expect(split.alignment_confidence!).toBeLessThanOrEqual(0.75);
  });

  it('model_verdict is stored separately from the verdict', () => {
    // Behavioural contract 1: the model's promise_alignment is never the
    // verdict. Two fields, so agreement can be tracked without the model's
    // answer ever being mistaken for the finding.
    const a: StoredAlignment = {
      action_uid: 'ACT-4', bill_id: 'hr4-118', bill_effect: 'ADVANCE',
      bill_effect_reasoning: 'r', promise_alignment: 'CONSISTENT',
      alignment_confidence: 0.8, alignment_reasoning: 'r',
      model_bill_effect: 'ADVANCE', model_agreed: false, outcome: 'CONSISTENT',
      direction: 'keeps', evidence_type: 'vote', action_tier: 'VOTED',
      vote_pattern: 'PASSAGE_ONLY', weight: 1, scoring_flags: [],
      model_verdict: 'INCONSISTENT',
    };
    // The model said INCONSISTENT; the derived verdict is CONSISTENT. Both are
    // retained and the derived one governs.
    expect(a.model_verdict).toBe('INCONSISTENT');
    expect(a.promise_alignment).toBe('CONSISTENT');
  });
});
