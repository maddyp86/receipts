import { describe, expect, it } from 'vitest';
import {
  evaluateRelevance,
  type EvaluationObservation,
  type RelevanceCandidate,
  type RelevanceResult,
} from './relevance.js';
import { evaluateFulfillment, type FulfillmentCandidate } from './fulfillment.js';
import { fixtureEnvelope, fixtureResponsesFetcher } from './responsesFetcher.js';

// ===========================================================================
// The trace hook on the two OpenAI legs.
//
// Both drivers run candidates in parallel and correlate results positionally,
// so the observer is the ONLY place the request, the raw response and the
// parsed result for one candidate exist together. It has to fire once per
// candidate whether the call succeeded, returned garbage, or threw — and it
// must never be able to change the evaluation.
// ===========================================================================

const relevanceCandidate = (over: Partial<RelevanceCandidate> = {}): RelevanceCandidate => ({
  promise_uid: 'QUERY',
  promise_text: 'Lower prescription drug prices.',
  promise_stance: 'In Favor',
  promise_type: 'policy',
  promise_primary_issue: 'Health Care',
  promise_sub_issue: 'Prescription Drugs',
  key_policy_terms: 'insulin',
  promise_date: '',
  bill_id: 'hr1-118',
  bill_title: 'A Bill',
  bill_summary: 'Caps insulin copays.',
  bill_primary_issue: 'Health Care',
  bill_sub_issue: 'Prescription Drugs',
  action_uid: 'ACT-1',
  is_sponsor: 'FALSE',
  is_cosponsor: 'FALSE',
  vote: 'YEA',
  vote_id: '1',
  similarity_score: 0.7,
  match_direction: 'promise_to_bill',
  match_rank: 1,
  ...over,
});

const fulfillmentCandidate = (over: Partial<FulfillmentCandidate> = {}): FulfillmentCandidate => ({
  statement_type: 'Policy Position',
  promise_uid: 'QUERY',
  promise_text: 'Lower prescription drug prices.',
  promise_stance: 'In Favor',
  promise_primary_issue: 'Health Care',
  promise_sub_issue: 'Prescription Drugs',
  bill_id: 'hr1-118',
  action_uid: 'ACT-1',
  bill_title: 'A Bill',
  bill_summary: 'Caps insulin copays.',
  bill_primary_issue: 'Health Care',
  bill_sub_issue: 'Prescription Drugs',
  vote: 'YEA',
  is_sponsor: 'FALSE',
  is_cosponsor: 'FALSE',
  ...over,
});

describe('evaluateRelevance observer', () => {
  // The shared fixture fetcher keys on the v7 fulfillment template ("- Bill
  // ID:"); the relevance template writes "**Bill ID:**". A direct fetcher is
  // the honest stand-in here — what is under test is the hook, not the lookup.
  it('sees the request, the raw text and the parse for a good call', async () => {
    const fetcher = async () =>
      fixtureEnvelope({
        verdict: 'TRUE_POSITIVE', action_type: 'VOTE', topic_relevant: 'Yes',
        action_relevant: 'Yes', effort_relevant: 'NA', specificity_match: 'Yes', confidence: 0.9,
      });
    const seen: unknown[] = [];
    await evaluateRelevance([relevanceCandidate()], fetcher, { observe: (o) => seen.push(o) });
    expect(seen).toHaveLength(1);
    const o = seen[0] as EvaluationObservation<RelevanceCandidate, RelevanceResult>;
    expect(o.candidate.action_uid).toBe('ACT-1');
    expect(o.request.input.find((m) => m.role === 'user')?.content).toContain('**Bill ID:** hr1-118');
    expect(o.rawText).toContain('TRUE_POSITIVE');
    expect(o.result.verdict).toBe('TRUE_POSITIVE');
    expect(o.error).toBeNull();
    expect(o.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('still fires when the call throws, with the error and the ERROR result', async () => {
    const fetcher = fixtureResponsesFetcher({}); // no envelope for this bill -> throws
    const seen: Array<{ error: string | null; result: { verdict: string }; envelope: unknown }> = [];
    const out = await evaluateRelevance([relevanceCandidate()], fetcher, { observe: (o) => seen.push(o) });
    expect(out[0]!.relevance.verdict).toBe('ERROR');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.error).toMatch(/no fixture envelope/);
    expect(seen[0]!.envelope).toBeNull();
    expect(seen[0]!.result.verdict).toBe('ERROR');
  });

  it('cannot disturb the evaluation by throwing', async () => {
    const fetcher = async () => fixtureEnvelope({ verdict: 'FALSE_POSITIVE', confidence: 0.8 });
    const out = await evaluateRelevance([relevanceCandidate()], fetcher, {
      observe: () => { throw new Error('observer bug'); },
    });
    expect(out[0]!.relevance.verdict).toBe('FALSE_POSITIVE');
  });
});

describe('evaluateFulfillment observer', () => {
  it('fires once per candidate with raw text and parse', async () => {
    const fetcher = fixtureResponsesFetcher({
      'hr1-118': fixtureEnvelope({ bill_effect: 'ADVANCE', promise_alignment: 'CONSISTENT', confidence: 0.8 }),
    });
    const seen: Array<{ rawText: string | null; result: { bill_effect: string } }> = [];
    await evaluateFulfillment([fulfillmentCandidate()], fetcher, { observe: (o) => seen.push(o) });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.rawText).toContain('ADVANCE');
    expect(seen[0]!.result.bill_effect).toBe('ADVANCE');
  });

  it('runs unchanged with no observer', async () => {
    const fetcher = fixtureResponsesFetcher({
      'hr1-118': fixtureEnvelope({ bill_effect: 'HINDER', promise_alignment: 'INCONSISTENT', confidence: 0.8 }),
    });
    const out = await evaluateFulfillment([fulfillmentCandidate()], fetcher);
    expect(out[0]!.result.bill_effect).toBe('HINDER');
  });
});
