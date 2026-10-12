import { describe, expect, it } from 'vitest';
import type { Interpretation, MatchedAction } from '@receipts/shared';
import { dispatchTool, newSession } from './dispatch.js';
import { fixtureEnvelope } from '../evaluation/responsesFetcher.js';

// ===========================================================================
// The near-miss review's second pass (2026-10-11). Case 51, run 34e21977: one
// loosely related bill was admitted (s441-118, a savings-account bill), the
// reader found it neutral, the answer was "doesn't settle it", and the 2025
// tax law at 0.483 was never looked at — the search only reviews near misses
// when the relevance check admits nothing. Now, when nothing admitted counts,
// the near misses are reviewed and read, once, after the first pass.
// ===========================================================================

const interpretation = {
  raw: 'promised not to raise income taxes on individuals', statement_type: 'Policy Position', provenance: 'default',
  restated: 'x', primary_issue: 'Tax Reform', sub_issue: 'Individual Income Taxes', stance: 'Opposed',
  promise_type: 'policy', key_policy_terms: [], is_evaluable: true,
} as unknown as Interpretation;

const match = (bill: string, score: number, over: Partial<MatchedAction> = {}): MatchedAction =>
  ({
    action_uid: `ACT-${bill}-S000148`, bill_id: bill, title: `Bill ${bill}`, summary: 's', intended_effects: 'e',
    mechanisms: 'm', action_type: 'voted', is_sponsor: false, is_cosponsor: false, vote: 'Nay', cloture_vote: 'NA',
    passage_vote: 'Nay', bill_keywords: [], primary_issue: 'Tax Reform', sub_issue: 'Individual Income Taxes',
    source_url: 'https://www.congress.gov/x', score, strength: 'WEAK', missing_fields: [], ...over,
  }) as MatchedAction;

const billOf = (body: { input: Array<{ role: string; content: unknown }> }) =>
  /Bill ID:\s*\**\s*(\S+?)[\s*(]/.exec(String(body.input.find((m) => m.role === 'user')?.content ?? ''))?.[1] ?? '?';

function setup(readings: Record<string, string>, relevant: Record<string, string>) {
  const session = newSession('S000148', interpretation.raw);
  session.interpretation = interpretation;
  session.scope = { scope: 'STANDING' } as never;
  session.matches = [match('s441-118', 0.52, { is_cosponsor: true, vote: 'NA', passage_vote: 'NA' })];
  session.evaluated = [];
  session.reviewable = [match('hr1-119', 0.483), match('s1992-118', 0.493)];
  const read: string[] = [];
  const checked: string[] = [];
  session.fulfillmentFetcher = async (body) => {
    const bill = billOf(body);
    read.push(bill);
    return fixtureEnvelope({ bill_effect: readings[bill] ?? 'NEUTRAL', alignment: 'NA', confidence: 0.85, same_object: true });
  };
  session.relevanceFetcher = async (body) => {
    const bill = billOf(body);
    checked.push(bill);
    return fixtureEnvelope({
      verdict: relevant[bill] ?? 'FALSE_POSITIVE', action_type: 'VOTE', topic_relevant: 'Yes', action_relevant: 'Yes',
      effort_relevant: 'NA', specificity_match: 'NA', confidence: 0.95, reasoning: 'r',
    });
  };
  return { session, read, checked };
}

describe('when nothing admitted counts', () => {
  it('reviews the near misses, reads what they admit, and reads each bill only once', async () => {
    const { session, read, checked } = setup({ 'hr1-119': 'ADVANCE' }, { 'hr1-119': 'TRUE_POSITIVE' });
    await dispatchTool(session, 'evaluate_effects', {});

    expect(checked.sort()).toEqual(['hr1-119', 's1992-118']);
    expect(read.filter((b) => b === 's441-118')).toHaveLength(1);
    expect(read.filter((b) => b === 'hr1-119')).toHaveLength(1);
    expect(read).not.toContain('s1992-118');
    expect(session.nearMissReview).toBe(true);
    expect(session.scored!.evidence.map((e) => e.bill_id)).toContain('hr1-119');
    expect(session.scored!.nd_reason).not.toBe('ALL_NEUTRAL');
  });

  it('a review that admits nothing leaves the first answer as it was', async () => {
    const { session, read } = setup({}, {});
    await dispatchTool(session, 'evaluate_effects', {});
    expect(session.scored!.nd_reason).toBe('ALL_NEUTRAL');
    expect(read).toEqual(['s441-118']);
  });
});

describe('when it does not run', () => {
  it('an answer where an admitted bill counts', async () => {
    const { session, checked } = setup({ 's441-118': 'HINDER' }, { 'hr1-119': 'TRUE_POSITIVE' });
    await dispatchTool(session, 'evaluate_effects', {});
    expect(checked).toEqual([]);
    expect(session.scored!.evidence.map((e) => e.bill_id)).not.toContain('hr1-119');
  });

  it('a run whose near misses were already reviewed at search time', async () => {
    const { session, checked } = setup({}, { 'hr1-119': 'TRUE_POSITIVE' });
    session.nearMissReview = true;
    await dispatchTool(session, 'evaluate_effects', {});
    expect(checked).toEqual([]);
  });
});
