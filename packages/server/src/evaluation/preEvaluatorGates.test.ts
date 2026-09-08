import { describe, expect, it } from 'vitest';
import {
  NULL_GATE_REFS,
  congressOf,
  normaliseClotureResult,
  preEvaluatorGates,
  type GateRefs,
  type GateRow,
  type GateStatementMeta,
} from './preEvaluatorGates.js';

// ===========================================================================
// The pre-evaluator gates. Each rule here maps to a specific false accusation
// in the 79-row audit, so the tests are written per-rule rather than per-branch.
// ===========================================================================

const row = (over: Partial<GateRow> = {}): GateRow => ({
  politician_id: 'T000250',
  bill_id: 'hr1-119',
  promise_text: 'I will fight to lower prescription drug costs.',
  bill_title: 'A bill to lower prescription drug costs',
  ...over,
});

const meta = (over: Partial<GateStatementMeta> = {}): GateStatementMeta => ({
  scope: 'STANDING',
  speechAct: 'COMMITMENT',
  roleCondition: 'NONE',
  ...over,
});

const refs = (over: Partial<GateRefs> = {}): GateRefs => ({
  roleAt: () => 'NONE',
  clotureResult: () => '',
  rollCallHasResult: true,
  ...over,
});

describe('a clean row passes and still carries context', () => {
  it('is scorable with no hits', () => {
    const r = preEvaluatorGates(row(), meta(), refs());
    expect(r.scorable).toBe(true);
    expect(r.hits).toHaveLength(0);
    expect(r.hit).toBeNull();
  });

  // The context is produced whether or not a gate fired: evaluator v7's prompt
  // expects these fields, and a gated row still needs them for the audit trail.
  it('produces evaluator context either way', () => {
    const r = preEvaluatorGates(row(), meta(), refs());
    expect(r.context.bill_congress).toBe('119');
    expect(r.context.bill_class).toBe('TARGETED');
    expect(r.context.senator_role).toBe('NONE');
  });
});

describe('G1d — speech acts no vote can settle', () => {
  it.each(['OPERATIONAL', 'CREDIT_CLAIM', 'RHETORIC'])('gates %s as NOT_APPLICABLE', (act) => {
    const r = preEvaluatorGates(row(), meta({ speechAct: act }), refs());
    expect(r.scorable).toBe(false);
    expect(r.hit?.verdict).toBe('NOT_APPLICABLE');
  });

  it('lets a COMMITMENT through', () => {
    expect(preEvaluatorGates(row(), meta({ speechAct: 'COMMITMENT' }), refs()).scorable).toBe(true);
  });
});

describe('G1a — bounded window', () => {
  it('gates an action after the window closed', () => {
    const r = preEvaluatorGates(
      row({ passage_vote_date: '2026-03-01' }),
      meta({ scope: 'BOUNDED', validUntil: new Date('2025-01-20'), anchor: 'President Biden' }),
      refs(),
    );
    expect(r.hit?.verdict).toBe('NOT_APPLICABLE_EXPIRED');
    expect(r.hit?.reason).toContain('2025-01-20');
  });

  it('lets an action inside the window through', () => {
    const r = preEvaluatorGates(
      row({ passage_vote_date: '2024-06-01' }),
      meta({ scope: 'BOUNDED', validUntil: new Date('2025-01-20') }),
      refs(),
    );
    expect(r.scorable).toBe(true);
  });

  // UNKNOWN is not the same as absent: bounded-but-unresolvable cannot be
  // tested, and saying so is a different claim from saying it expired.
  it('gates an unresolvable window as NOT_DETERMINABLE, not EXPIRED', () => {
    const r = preEvaluatorGates(
      row(),
      meta({ scope: 'BOUNDED', validUntilRaw: 'UNKNOWN' }),
      refs(),
    );
    expect(r.hit?.verdict).toBe('NOT_DETERMINABLE');
  });

  // The proxy under-fires rather than over-fires, and says so.
  it('uses the Congress start as a proxy action date and discloses it', () => {
    const r = preEvaluatorGates(
      row({ bill_id: 'hr1-119' }),
      meta({ scope: 'BOUNDED', validUntil: new Date('2024-01-01') }),
      refs(),
    );
    expect(r.hit?.reason).toContain('proxy');
    expect(r.context.vote_flags).toContain('ACTION_DATE_PROXY');
  });
});

describe('G1b — administration anchor', () => {
  it('gates a Biden promise against a Trump-era bill', () => {
    const r = preEvaluatorGates(
      row({ promise_text: "I will oppose President Biden's judicial nominees.", bill_id: 'hr1-119' }),
      meta(),
      refs(),
    );
    expect(r.hit?.verdict).toBe('NOT_APPLICABLE_EXPIRED');
    expect(r.hit?.reason).toContain('BIDEN');
  });

  it('leaves a matching administration alone', () => {
    const r = preEvaluatorGates(
      row({ promise_text: "I will oppose President Biden's judicial nominees.", bill_id: 'hr1-118' }),
      meta(),
      refs(),
    );
    expect(r.scorable).toBe(true);
  });
});

describe('G1c — role precondition', () => {
  it('gates a leader-only statement when the senator was not leader', () => {
    const r = preEvaluatorGates(
      row(),
      meta({ roleCondition: 'MAJORITY_LEADER' }),
      refs({ roleAt: () => 'NONE' }),
    );
    expect(r.hit?.verdict).toBe('NOT_APPLICABLE_EXPIRED');
  });

  it('lets it through when they were', () => {
    const r = preEvaluatorGates(
      row(),
      meta({ roleCondition: 'MAJORITY_LEADER' }),
      refs({ roleAt: () => 'MAJORITY_LEADER' }),
    );
    expect(r.scorable).toBe(true);
  });
});

describe('G2 — vote pairing', () => {
  it('gates cloture dated after passage as two different bill versions', () => {
    const r = preEvaluatorGates(
      row({ cloture_vote_date: '2025-06-01', passage_vote_date: '2025-05-01' }),
      meta(),
      refs(),
    );
    expect(r.hit?.verdict).toBe('NOT_DETERMINABLE');
    expect(r.hit?.gate).toBe('G2_split_vote');
  });
});

// The gate that accounted for 15 of the 79 false positives.
describe('G3 — floor leader reconsideration switch', () => {
  const leaderNay = row({ cloture_vote: 'NAY', party_whip_vote: 'YEA', cloture_vote_id: 's1-119' });

  it('reads a leader NAY against the whip as PROCEDURAL_SWITCH', () => {
    const r = preEvaluatorGates(
      leaderNay,
      meta(),
      refs({ roleAt: () => 'MAJORITY_LEADER', clotureResult: () => 'REJECTED' }),
    );
    expect(r.hit?.verdict).toBe('PROCEDURAL_SWITCH');
    expect(r.hit?.reason).toContain('Rule XIII');
  });

  // Fails OPEN toward firing: reading a Rule XIII manoeuvre as opposition is
  // the error that matters, so an unknown outcome still gates — and discloses.
  it('still fires when the cloture result is unknown, and says so', () => {
    const r = preEvaluatorGates(
      leaderNay,
      meta(),
      refs({ roleAt: () => 'MAJORITY_LEADER', clotureResult: () => '', rollCallHasResult: false }),
    );
    expect(r.hit?.verdict).toBe('PROCEDURAL_SWITCH');
    expect(r.hit?.reason).toContain('unverified');
  });

  it('does not fire when cloture was agreed — no motion to preserve', () => {
    const r = preEvaluatorGates(
      leaderNay,
      meta(),
      refs({ roleAt: () => 'MAJORITY_LEADER', clotureResult: () => 'AGREED' }),
    );
    expect(r.scorable).toBe(true);
  });

  it('does not fire for a senator who is not in leadership', () => {
    const r = preEvaluatorGates(leaderNay, meta(), refs({ roleAt: () => 'NONE' }));
    expect(r.scorable).toBe(true);
  });

  it('does not fire when the whip voted the same way', () => {
    const r = preEvaluatorGates(
      row({ cloture_vote: 'NAY', party_whip_vote: 'NAY' }),
      meta(),
      refs({ roleAt: () => 'MAJORITY_LEADER' }),
    );
    expect(r.scorable).toBe(true);
  });
});

describe('G4 — broad vehicle with generic stakeholders', () => {
  const omnibus = row({
    bill_title: 'Consolidated Appropriations Act, 2024',
    stakeholder_groups: ['Federal agencies'],
  });

  it('gates an omnibus whose stakeholders are all generic', () => {
    const r = preEvaluatorGates(omnibus, meta(), refs());
    expect(r.hit?.verdict).toBe('NOT_DETERMINABLE');
    expect(r.context.bill_class).toBe('BROAD_VEHICLE');
  });

  // A broad vehicle that names the promised thing IS evidence.
  it('lets a broad vehicle through when a specific stakeholder is named', () => {
    const r = preEvaluatorGates(
      { ...omnibus, stakeholder_groups: ['Rural hospitals in South Dakota'] },
      meta(),
      refs(),
    );
    expect(r.scorable).toBe(true);
  });

  it('classifies a repeal as REVERSAL', () => {
    const r = preEvaluatorGates(
      row({ bill_title: 'A joint resolution disapproving the rule submitted by the EPA' }),
      meta(),
      refs(),
    );
    expect(r.context.bill_class).toBe('REVERSAL');
  });
});

describe('fail-open behaviour', () => {
  // The whole design: a missing input costs one wasted evaluation, never a
  // silently dropped statement.
  it('passes everything when no reference data is available', () => {
    const r = preEvaluatorGates(
      row({ cloture_vote: 'NAY', party_whip_vote: 'YEA' }),
      meta({ scope: undefined, speechAct: undefined, roleCondition: undefined }),
      { roleAt: () => 'NONE', clotureResult: () => '' },
    );
    expect(r.scorable).toBe(true);
    expect(r.context.scope).toBe('UNKNOWN');
    expect(r.context.role_condition).toBe('UNKNOWN');
    expect(r.context.cloture_result).toBe('UNKNOWN');
  });

  // NULL_GATE_REFS still resolves the two MVP senators from the hardcoded
  // table, because that is the source's own fallback rather than an absence.
  it('NULL_GATE_REFS still knows the floor leaders', () => {
    expect(NULL_GATE_REFS.roleAt('T000250', '119')).toBe('MAJORITY_LEADER');
    expect(NULL_GATE_REFS.roleAt('S000148', '119')).toBe('MINORITY_LEADER');
    expect(NULL_GATE_REFS.roleAt('X000001', '119')).toBe('NONE');
  });
});

describe('helpers', () => {
  it('extracts the Congress from a bill id', () => {
    expect(congressOf('hr3746-118')).toBe('118');
    expect(congressOf('sjres7-119')).toBe('119');
    expect(congressOf('nonsense')).toBe('');
  });

  it('normalises roll-call results to the two outcomes G3 tests', () => {
    expect(normaliseClotureResult('Cloture Motion Rejected')).toBe('REJECTED');
    expect(normaliseClotureResult('Resolution Agreed to')).toBe('AGREED');
    expect(normaliseClotureResult('Cloture Motion Not Invoked')).toBe('REJECTED');
    expect(normaliseClotureResult('')).toBe('');
  });
});

describe('split-vote disclosure travels with the row', () => {
  it('flags a split regardless of whether a gate fired', () => {
    const r = preEvaluatorGates(
      row({ cloture_vote: 'YEA', passage_vote: 'NAY' }),
      meta(),
      refs(),
    );
    expect(r.scorable).toBe(true);
    expect(r.context.vote_flags).toContain('SPLIT_VOTE');
  });

  it('does not call an abstention a split', () => {
    const r = preEvaluatorGates(
      row({ cloture_vote: 'Not Voting', passage_vote: 'NAY' }),
      meta(),
      refs(),
    );
    expect(r.context.vote_flags).not.toContain('SPLIT_VOTE');
  });
});
