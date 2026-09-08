import { describe, expect, it } from 'vitest';
import type { DirectedAction, ScoredResult } from '@receipts/shared';
import { buildAlignments } from './loop.js';
import type { QuerySession } from './dispatch.js';
import type { FulfillmentResult } from '../evaluation/fulfillment.js';

// ===========================================================================
// What gets PERSISTED, not what gets rendered.
//
// These pin two bugs that were live on main: the stored `promise_alignment`
// held the model's answer instead of the derived verdict, and the stored
// confidence bypassed the split-vote cap. Both are behavioural contracts, and
// both were invisible in the UI — the screen showed the right thing while the
// database recorded the wrong one, which is the worst shape for a tool whose
// product is its audit trail.
// ===========================================================================

const evidence = (over: Partial<DirectedAction> = {}): DirectedAction =>
  ({
    action_uid: 'ACT-1',
    bill_id: 'hr1-118',
    bill_number: 'H.R.1',
    title: 'A Bill',
    summary: 'Summary.',
    intended_effects: '',
    mechanisms: '',
    action_type: 'voted',
    is_sponsor: false,
    is_cosponsor: false,
    vote: 'NA',
    cloture_vote: 'NA',
    passage_vote: 'NA',
    bill_keywords: [],
    primary_issue: 'Health Care',
    sub_issue: 'Prescription Drugs',
    source_url: '',
    score: 0.7,
    strength: 'STRONG',
    missing_fields: [],
    bill_effect: 'ADVANCE',
    bill_effect_reasoning: 'It advances the goal.',
    outcome: 'KEPT',
    direction: 'keeps',
    evidence_type: 'vote',
    action_tier: 'VOTED',
    vote_pattern: 'PASSAGE_ONLY',
    weight: 0.7,
    scoring_flags: [],
    vote_governing: 'PASSAGE (no cloture vote)',
    vote_flags: [],
    alignment_confidence: 0.8,
    ...over,
  }) as DirectedAction;

const fulfillment = (over: Partial<FulfillmentResult> = {}): FulfillmentResult => ({
  bill_effect: 'ADVANCE',
  alignment: 'KEPT',
  reasoning: 'Because.',
  confidence: 0.8,
  flags: [],
  ...over,
});

const session = (e: DirectedAction, f: FulfillmentResult): QuerySession =>
  ({
    politicianId: 'S000148',
    promiseText: 'A promise.',
    uncached: false,
    queued: false,
    scored: { evidence: [e] } as unknown as ScoredResult,
    fulfillment: { [e.action_uid]: f },
    orchestratorEffects: {},
  }) as QuerySession;

describe('buildAlignments — contract 1: the model never supplies the verdict', () => {
  // The stored column of this name must mean what WF10A's column of this name
  // means: the DERIVED verdict. It previously held the model's own answer, so
  // anyone reading it for parity got the opposite of what they expected.
  it('stores the derived outcome as promise_alignment, not the model’s answer', () => {
    const [row] = buildAlignments(
      session(evidence({ outcome: 'KEPT' }), fulfillment({ alignment: 'NOT_DETERMINABLE' })),
    );
    expect(row!.promise_alignment).toBe('KEPT');
  });

  it('keeps the model’s answer, but only as model_verdict', () => {
    const [row] = buildAlignments(
      session(evidence({ outcome: 'KEPT' }), fulfillment({ alignment: 'NOT_DETERMINABLE' })),
    );
    expect(row!.model_verdict).toBe('NOT_DETERMINABLE');
  });

  // The disagreement is the point of storing both: if they were the same field
  // there would be nothing to audit.
  it('records a disagreement rather than resolving it', () => {
    const [row] = buildAlignments(
      session(evidence({ outcome: 'BROKE' }), fulfillment({ alignment: 'KEPT' })),
    );
    expect(row!.promise_alignment).not.toBe(row!.model_verdict);
  });
});

describe('buildAlignments — contract 2: the split-vote cap survives persistence', () => {
  // scoreMatches applies the 0.75 cap and puts the result on the evidence row.
  // Reading the evaluator's raw confidence here stored an uncapped number while
  // the UI showed the capped one.
  it('stores the capped confidence, not the evaluator’s raw value', () => {
    const [row] = buildAlignments(
      session(
        evidence({ alignment_confidence: 0.75, vote_flags: ['SPLIT_VOTE'] }),
        fulfillment({ confidence: 0.95 }),
      ),
    );
    expect(row!.alignment_confidence).toBe(0.75);
  });

  it('carries null through rather than inventing a zero', () => {
    const [row] = buildAlignments(
      session(evidence({ alignment_confidence: null }), fulfillment({ confidence: 0.9 })),
    );
    expect(row!.alignment_confidence).toBeNull();
  });
});

describe('buildAlignments — disclosure fields', () => {
  it('stores which vote governed', () => {
    const [row] = buildAlignments(
      session(evidence({ vote_governing: 'CLOTURE (60-vote threshold; split vote)' }), fulfillment()),
    );
    expect(row!.vote_governing).toContain('CLOTURE');
  });

  it('stores SPLIT_VOTE, and null rather than an empty list', () => {
    const [split] = buildAlignments(
      session(evidence({ vote_flags: ['SPLIT_VOTE'] }), fulfillment()),
    );
    expect(split!.vote_flags).toEqual(['SPLIT_VOTE']);

    const [clean] = buildAlignments(session(evidence({ vote_flags: [] }), fulfillment()));
    expect(clean!.vote_flags).toBeNull();
  });

  // These rows reached the evaluator, so nothing about them was "not
  // evaluated". Writing the marker here would assert a gating that never
  // happened — handoff v2 §3, the rule that a marker is never replaced by a
  // value from the column's own vocabulary, read in the other direction.
  it('leaves the gated-row markers absent until the gates are wired', () => {
    const [row] = buildAlignments(session(evidence(), fulfillment()));
    expect(row!.confidence_marker).toBeUndefined();
    expect(row!.effect_marker).toBeUndefined();
  });
});
