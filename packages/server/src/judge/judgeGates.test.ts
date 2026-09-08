import { describe, expect, it } from 'vitest';
import { judgeGates, type JudgeGateRow } from './judgeGates.js';

// ===========================================================================
// The judge's deterministic layer. It assigns NO verdict — it reports what a
// reviewer should dispute. These tests pin that distinction as much as the
// rules themselves: a hit is a question, not an answer.
// ===========================================================================

const row = (over: Partial<JudgeGateRow> = {}): JudgeGateRow => ({
  promise_alignment: 'BROKE',
  bill_effect: 'ADVANCE',
  alignment_confidence: 0.6,
  politician_id: 'T000250',
  bill_id: 'hr1-119',
  promise_text: 'I will fight to lower prescription drug costs.',
  bill_title: 'A bill to lower prescription drug costs',
  ...over,
});

const classes = (r: ReturnType<typeof judgeGates>) => r.fired.map((f) => f.class);

describe('grading', () => {
  it('an accusation with no hit is PENDING_LLM — the judge decides, not this layer', () => {
    const r = judgeGates(row());
    expect(r.fired).toHaveLength(0);
    expect(r.deterministic_grade).toBe('PENDING_LLM');
  });

  it('a non-accusation with no hit is PASS', () => {
    expect(judgeGates(row({ promise_alignment: 'KEPT' })).deterministic_grade).toBe('PASS');
  });

  it('any hit is FAIL', () => {
    const r = judgeGates(row({ promise_text: 'Our senators will fight for us.' }));
    expect(r.deterministic_grade).toBe('FAIL');
  });
});

describe('G0 — statement integrity', () => {
  it('flags first-person plural that does not fit one senator speaking', () => {
    expect(classes(judgeGates(row({ promise_text: 'Our senators will fight for us.' })))).toContain(
      'STATEMENT_EXTRACTION',
    );
  });
});

describe('G1 — scope', () => {
  it('flags an action after a bounded window closed', () => {
    const r = judgeGates(
      row({ scope: 'BOUNDED', valid_until: '2025-01-20', action_date: '2026-03-01' }),
    );
    expect(classes(r)).toContain('BOUNDED_PROMISE');
  });

  // Without scope columns, bounded language plus no date is a question to ask,
  // not a finding — hence the separate UNVERIFIED class.
  it('flags bounded language with no statement date as UNVERIFIED', () => {
    const r = judgeGates(row({ promise_text: 'I will vote for this bill next week.' }));
    expect(classes(r)).toContain('BOUNDED_PROMISE_UNVERIFIED');
  });

  it('flags a promise naming the wrong administration', () => {
    const r = judgeGates(
      row({ promise_text: "I will confirm President Biden's judicial nominees.", bill_id: 'hr1-119' }),
    );
    expect(classes(r)).toContain('ADMIN_MISMATCH');
  });

  it('reports scope coverage so a blind gate is visible', () => {
    expect(judgeGates(row()).coverage.scope_fields).toBe(false);
    expect(judgeGates(row({ scope: 'STANDING' })).coverage.scope_fields).toBe(true);
  });
});

describe('G2 — split votes', () => {
  const split = { cloture_vote: 'YEA', passage_vote: 'NAY' };

  it('flags a split the reasoning never disclosed', () => {
    const r = judgeGates(row({ ...split, alignment_reasoning: 'He voted against it.' }));
    expect(classes(r)).toContain('SPLIT_VOTE');
  });

  it('accepts a split that named both votes and stayed within the cap', () => {
    const r = judgeGates(
      row({
        ...split,
        vote_flags: ['SPLIT_VOTE'],
        alignment_confidence: 0.7,
        alignment_reasoning: 'He voted YEA on cloture and NAY on passage; cloture governs.',
      }),
    );
    expect(classes(r)).not.toContain('SPLIT_VOTE');
  });

  // Contract 2 read from the other side: disclosure alone is not enough if the
  // confidence exceeds what a split supports.
  it('flags a properly disclosed split that is still overconfident', () => {
    const r = judgeGates(
      row({
        ...split,
        vote_flags: ['SPLIT_VOTE'],
        alignment_confidence: 0.9,
        alignment_reasoning: 'Cloture and passage diverge; cloture governs.',
      }),
    );
    expect(classes(r)).toContain('SPLIT_VOTE');
  });

  it('flags cloture dated after passage', () => {
    const r = judgeGates(
      row({ cloture_vote_date: '2025-06-01', passage_vote_date: '2025-05-01' }),
    );
    expect(classes(r)).toContain('VOTE_PAIRING_ERROR');
  });
});

describe('G3 — leader switch and sponsor NAY', () => {
  it('flags a leader NAY against the whip that was not called PROCEDURAL_SWITCH', () => {
    const r = judgeGates(
      row({ senator_role: 'MAJORITY_LEADER', cloture_vote: 'NAY', party_whip_vote: 'YEA' }),
    );
    expect(classes(r)).toContain('LEADER_SWITCH');
  });

  it('does not flag it once the verdict already says PROCEDURAL_SWITCH', () => {
    const r = judgeGates(
      row({
        promise_alignment: 'PROCEDURAL_SWITCH',
        senator_role: 'MAJORITY_LEADER',
        cloture_vote: 'NAY',
        party_whip_vote: 'YEA',
      }),
    );
    expect(classes(r)).not.toContain('LEADER_SWITCH');
  });

  it('resolves the role from the hardcoded table when the row does not carry one', () => {
    const r = judgeGates(
      row({ politician_id: 'T000250', bill_id: 'hr1-119', cloture_vote: 'NAY', party_whip_vote: 'YEA' }),
    );
    expect(classes(r)).toContain('LEADER_SWITCH');
  });

  it('flags a sponsor who voted NAY and was not called PROCEDURAL_SWITCH', () => {
    const r = judgeGates(row({ is_sponsor: true, passage_vote: 'NAY' }));
    expect(classes(r)).toContain('SPONSOR_NAY_NOT_SWITCH');
  });
});

describe('G4 — vehicle and object', () => {
  it('flags a broad vehicle with a generic stakeholder', () => {
    const r = judgeGates(
      row({ bill_title: 'Consolidated Appropriations Act, 2024', stakeholder_group: 'Federal agencies' }),
    );
    expect(classes(r)).toContain('BROAD_VEHICLE');
  });

  it('flags a confident accusation across a different issue and sub-issue', () => {
    const r = judgeGates(
      row({
        alignment_confidence: 0.8,
        promise_primary_issue: 'Health Care',
        promise_sub_issue: 'Prescription Drugs',
        bill_primary_issue: 'Defense',
        bill_sub_issue: 'Procurement',
      }),
    );
    expect(classes(r)).toContain('OBJECT_MISMATCH_OVERCONFIDENT');
  });

  // §8: this bill's direction IS the partisan dispute, so a directional effect
  // on it is a finding the tool is not entitled to make.
  it('flags a directional effect on a known contested bill', () => {
    const r = judgeGates(row({ bill_id: 's3386-119', bill_effect: 'HINDER' }));
    expect(classes(r)).toContain('CONTESTED_DIRECTION');
  });

  it('accepts CONTESTED or NEUTRAL on that same bill', () => {
    expect(classes(judgeGates(row({ bill_id: 's3386-119', bill_effect: 'CONTESTED' })))).not.toContain(
      'CONTESTED_DIRECTION',
    );
  });
});

describe('G5 — HINDER by omission', () => {
  // v7 states the rule; this catches the model asserting it anyway.
  it('flags HINDER justified by a bill lacking a provision', () => {
    const r = judgeGates(
      row({
        bill_effect: 'HINDER',
        bill_effect_reasoning: 'The bill does not provide funding for the program.',
      }),
    );
    expect(classes(r)).toContain('HINDER_BY_OMISSION');
  });
});

describe('G6 — confidence policy', () => {
  it('flags a high-confidence accusation on partial evidence', () => {
    const r = judgeGates(row({ alignment_confidence: 0.9, match_verdict: 'PARTIAL' }));
    expect(classes(r)).toContain('OVERCONFIDENT');
  });

  it('leaves a high-confidence accusation on clean evidence alone', () => {
    const r = judgeGates(row({ alignment_confidence: 0.9, match_verdict: 'TRUE_POSITIVE' }));
    expect(classes(r)).not.toContain('OVERCONFIDENT');
  });

  // Asymmetric by design: this layer exists to challenge accusations.
  it('never flags a KEPT verdict for overconfidence', () => {
    const r = judgeGates(
      row({ promise_alignment: 'KEPT', alignment_confidence: 0.99, match_verdict: 'PARTIAL' }),
    );
    expect(classes(r)).not.toContain('OVERCONFIDENT');
  });
});

describe('NOT_EVALUATED confidence (handoff v2 §3)', () => {
  // The column can legitimately hold a marker rather than a number, so every
  // threshold must be written so a non-number never satisfies it.
  it('does not treat an unreadable confidence as clearing any threshold', () => {
    const r = judgeGates(
      row({ alignment_confidence: null, match_verdict: 'PARTIAL', bill_title: 'omnibus' }),
    );
    expect(classes(r)).not.toContain('OVERCONFIDENT');
    expect(classes(r)).not.toContain('OBJECT_MISMATCH_OVERCONFIDENT');
  });
});
