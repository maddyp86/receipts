import { describe, expect, it } from 'vitest';
import { preEvaluatorGates, type GateRefs, type GateRow } from '../evaluation/preEvaluatorGates.js';
import { buildFulfillmentUserMessage, type FulfillmentCandidate } from '../evaluation/fulfillment.js';
import { deriveAlignment } from './deriveAlignment.js';

// ===========================================================================
// A YEA IS NEVER A PROCEDURAL SWITCH (2026-10-10, eval case 15).
//
// The exemption is for a NO vote only: a sponsor voting NAY, or a floor leader
// voting NAY on a failing cloture motion while the party whip voted YEA — both
// to keep the motion to reconsider. Case 15: Thune, majority leader, voted YEA
// on cloture for s5271-119; the v7 evaluator read that as a leader's switch and
// marked the bill NEUTRAL, so the vote counted for nothing.
//
// The two rules in code were already NAY-only, and these tests pin that. The
// model can no longer apply the rule at all: v8 never shows it the vote.
// ===========================================================================

const ADVANCE = 'ADVANCE' as const;

describe('deriveAlignment: the sponsor exemption is NAY-only', () => {
  it.each([
    ['cloture YEA', { cloture_vote: 'YEA', passage_vote: 'NA' }],
    ['passage YEA', { cloture_vote: 'NA', passage_vote: 'YEA' }],
    ['both YEA', { cloture_vote: 'YEA', passage_vote: 'YEA' }],
  ])('a sponsor with %s counts as support', (_n, votes) => {
    const r = deriveAlignment({ bill_effect: ADVANCE, vote: 'YEA', is_sponsor: 'TRUE', is_cosponsor: 'FALSE', ...votes }, 'Policy Position');
    expect(r.verdict).toBe('CONSISTENT');
  });

  it('a sponsor voting NAY is still the switch', () => {
    const r = deriveAlignment({ bill_effect: ADVANCE, vote: 'NAY', cloture_vote: 'NAY', passage_vote: 'NA', is_sponsor: 'TRUE', is_cosponsor: 'FALSE' }, 'Policy Position');
    expect(r.verdict).toBe('PROCEDURAL_SWITCH');
  });

  // Case 15's row exactly: majority leader, cloture YEA on a motion that
  // failed, party whip NAY, not a sponsor.
  it('case 15: a leader YEA on a failed cloture motion counts as support', () => {
    const r = deriveAlignment({ bill_effect: ADVANCE, vote: 'YEA', cloture_vote: 'YEA', passage_vote: 'NA', is_sponsor: 'FALSE', is_cosponsor: 'FALSE' }, 'Policy Position');
    expect(r.verdict).toBe('CONSISTENT');
  });
});

describe('G3: the leader exemption is NAY-only', () => {
  const row = (over: Partial<GateRow>): GateRow => ({
    politician_id: 'T000250', bill_id: 's5271-119', promise_text: 'Require proof of citizenship and photo ID to vote.',
    bill_title: 'A bill', cloture_vote_id: 'v1', ...over,
  });
  const leader: GateRefs = { roleAt: () => 'MAJORITY_LEADER', clotureResult: () => 'REJECTED', rollCallHasResult: true };
  const meta = { scope: 'STANDING', speechAct: 'COMMITMENT', roleCondition: 'NONE' } as const;

  it('case 15: leader YEA, whip NAY, motion rejected — scorable, no switch', () => {
    const r = preEvaluatorGates(row({ cloture_vote: 'YEA', party_whip_vote: 'NAY' }), meta, leader);
    expect(r.hits.map((h) => h.gate)).not.toContain('G3_leader_switch');
    expect(r.scorable).toBe(true);
  });

  it('leader YEA with the whip YEA — no switch', () => {
    const r = preEvaluatorGates(row({ cloture_vote: 'YEA', party_whip_vote: 'YEA' }), meta, leader);
    expect(r.hits.map((h) => h.gate)).not.toContain('G3_leader_switch');
  });

  it('leader NAY, whip YEA, motion rejected — the switch', () => {
    const r = preEvaluatorGates(row({ cloture_vote: 'NAY', party_whip_vote: 'YEA' }), meta, leader);
    expect(r.hits.map((h) => h.gate)).toContain('G3_leader_switch');
  });
});

describe('the evaluator cannot apply it: it never sees the vote', () => {
  it('case 15 as the evaluator receives it: no role, no vote, no whip', () => {
    const msg = buildFulfillmentUserMessage({
      statement_type: 'Policy Position', promise_uid: 'QUERY', promise_text: 'Require proof of citizenship and photo ID to vote.',
      promise_stance: 'In Favor', promise_primary_issue: 'Civil Rights & Liberties', promise_sub_issue: 'Elections & Voting Rights',
      bill_id: 's5271-119', bill_title: 'A bill', bill_summary: 'S.', bill_primary_issue: 'x', bill_sub_issue: 'y',
      vote: 'YEA', cloture_vote: 'YEA', cloture_result: 'REJECTED', party_whip_vote: 'NAY', senator_role: 'MAJORITY_LEADER',
      is_sponsor: 'FALSE', is_cosponsor: 'FALSE', vote_flags: 'FLOOR_LEADER',
    } as FulfillmentCandidate);
    for (const s of ['YEA', 'NAY', 'REJECTED', 'MAJORITY_LEADER', 'whip', 'FLOOR_LEADER']) expect(msg).not.toContain(s);
  });
});
