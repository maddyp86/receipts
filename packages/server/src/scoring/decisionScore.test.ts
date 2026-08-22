import { describe, expect, it } from 'vitest';
import {
  computeDecisionScore,
  summariseScores,
  type DecisionScoreInput,
} from './decisionScore.js';
import { effortSignals } from './effortSignal.js';
import { billOutcome, isTerminal, statusWithAsOf } from './billOutcome.js';

const input = (over: Partial<DecisionScoreInput> = {}): DecisionScoreInput => ({
  alignment: 'KEPT',
  statement_type: 'Campaign Promise',
  action_tier: 'VOTED',
  vote_pattern: 'PASSAGE_ONLY',
  party_alignment: 'WITH_PARTY',
  donor_alignment: 'NO_DATA',
  donor_pro_count: 0,
  platform_alignment: 'NO_DATA',
  alignment_confidence: 0.95,
  is_sponsor: false,
  is_cosponsor: false,
  ...over,
});

// ===========================================================================
// Decision score — the WF11 port
// ===========================================================================

describe('computeDecisionScore', () => {
  it('reproduces the method spec worked example', () => {
    // Promise "oppose any bill that cuts SNAP"; bill HINDERS; cloture NAY, no
    // passage vote -> DECISIVE_BLOCK, opposed -> KEPT.
    // base 0.9 (KEPT, with party, no donor data) + 0.05 confidence, × 1.15.
    const r = computeDecisionScore(
      input({ vote_pattern: 'DECISIVE_BLOCK', alignment_confidence: 0.92 }),
    );
    expect(r.base_score).toBe(0.9);
    expect(r.total_modifier).toBe(0.05);
    expect(r.pattern_multiplier).toBe(1.15);
    expect(r.decision_score).toBeCloseTo(1.0925, 3);
    expect(r.outcome_label).toBe('Upheld, With Party — Blocked at Cloture');
    expect(r.scorable).toBe(true);
  });

  // The whole point of the null contract.
  it('freezes non-directional outcomes as null, never 0.0', () => {
    for (const alignment of ['NOT_DETERMINABLE', 'PROCEDURAL_SWITCH', 'ERROR'] as const) {
      const r = computeDecisionScore(input({ alignment }));
      expect(r.decision_score).toBeNull();
      expect(r.decision_score).not.toBe(0);
      expect(r.scorable).toBe(false);
      expect(r.base_score).toBeNull();
    }
  });

  it('labels a procedural switch as not scored', () => {
    const r = computeDecisionScore(input({ alignment: 'PROCEDURAL_SWITCH' }));
    expect(r.outcome_label).toBe('Procedural Switch — Not Scored');
    expect(r.scoring_flags).toContain('PROCEDURAL_SWITCH');
  });

  it('flags a verdict with no action rather than inventing a base row', () => {
    const r = computeDecisionScore(input({ action_tier: 'NONE' }));
    expect(r.scorable).toBe(false);
    expect(r.scoring_flags).toContain('VERDICT_WITHOUT_ACTION');
  });

  // Added upstream 2026-08-14.
  it('handles the PROCEDURAL party alignment without pretending whip data is missing', () => {
    const r = computeDecisionScore(input({ party_alignment: 'PROCEDURAL' }));
    expect(r.scoring_flags).toContain('PARTY_PROCEDURAL_SWITCH');
    expect(r.scoring_flags).not.toContain('PARTY_WHIP_DATA_MISSING');
    expect(r.base_score).toBe(0.9); // fell back to WITH_PARTY
  });

  it('flags missing whip data instead of silently scoring as if compared', () => {
    const r = computeDecisionScore(input({ party_alignment: 'NA' }));
    expect(r.scoring_flags).toContain('PARTY_WHIP_DATA_MISSING');
  });

  it('scopes legislative effort to the VOTED tier', () => {
    const voted = computeDecisionScore(input({ is_sponsor: true }));
    expect(voted.modifiers_applied.some((m) => String(m.modifier).includes('Legislative Effort'))).toBe(
      true,
    );

    // On the sponsor tier the base row already IS the sponsorship.
    const sponsorTier = computeDecisionScore(
      input({ action_tier: 'SPONSOR', is_sponsor: true }),
    );
    expect(
      sponsorTier.modifiers_applied.some((m) => String(m.modifier).includes('Legislative Effort')),
    ).toBe(false);
  });

  it('penalises a self-authored contradiction rather than crediting it', () => {
    const r = computeDecisionScore(input({ alignment: 'BROKE', is_sponsor: true }));
    expect(r.total_modifier).toBeLessThan(0);
    expect(r.outcome_label).toContain('Self-Authored');
  });

  it('applies donor thresholds, not a bare donor flag', () => {
    const below = computeDecisionScore(input({ donor_alignment: 'ALIGNED', donor_pro_count: 9 }));
    const at = computeDecisionScore(input({ donor_alignment: 'ALIGNED', donor_pro_count: 10 }));
    expect(below.modifiers_applied.some((m) => String(m.modifier).includes('Donor'))).toBe(false);
    expect(at.modifiers_applied.some((m) => String(m.modifier).includes('Donor'))).toBe(true);
  });

  it('treats a null confidence as low, not as high', () => {
    const r = computeDecisionScore(input({ alignment_confidence: null }));
    expect(r.modifiers_applied.some((m) => m.adjustment === '×0.8')).toBe(true);
  });

  it('applies the specificity discount multiplicatively', () => {
    const plain = computeDecisionScore(input());
    const discounted = computeDecisionScore(input({ partial_subtype: 'SPECIFICITY' }));
    expect(discounted.specificity_multiplier).toBe(0.85);
    expect(discounted.decision_score!).toBeCloseTo(plain.decision_score! * 0.85, 4);
  });

  it('clamps to [-2.0, 1.5]', () => {
    const r = computeDecisionScore(
      input({
        alignment: 'BROKE',
        party_alignment: 'CROSS_PARTY',
        donor_alignment: 'ALIGNED',
        donor_pro_count: 50,
        platform_alignment: 'CONTRADICTS',
        vote_pattern: 'DECISIVE_BLOCK',
        is_sponsor: true,
      }),
    );
    expect(r.decision_score!).toBeGreaterThanOrEqual(-2.0);
    expect(r.decision_score!).toBeLessThanOrEqual(1.5);
  });

  it('never lets a multiplier flip a sign', () => {
    for (const pattern of ['DECISIVE_BLOCK', 'BLOCKED_THEN_JOINED', 'CLOTURE_ONLY_YEA'] as const) {
      const kept = computeDecisionScore(input({ vote_pattern: pattern }));
      const broke = computeDecisionScore(input({ alignment: 'BROKE', vote_pattern: pattern }));
      expect(kept.decision_score!).toBeGreaterThan(0);
      expect(broke.decision_score!).toBeLessThan(0);
    }
  });
});

describe('summariseScores — the denominator', () => {
  it('excludes frozen rows from the mean rather than counting them as zero', () => {
    const rows = [
      computeDecisionScore(input()), // scorable
      computeDecisionScore(input({ alignment: 'NOT_DETERMINABLE' })), // frozen
      computeDecisionScore(input({ alignment: 'PROCEDURAL_SWITCH' })), // frozen
    ];
    const s = summariseScores(rows);
    expect(s.total).toBe(3);
    expect(s.scorable).toBe(1);
    expect(s.frozen).toBe(2);
    expect(s.average).toBe(rows[0]!.decision_score);

    // If frozen rows were scored 0.0 the mean would be a third of this — which
    // is exactly the misinformation the null contract prevents.
    const naive = rows.reduce((a, r) => a + (r.decision_score ?? 0), 0) / rows.length;
    expect(s.average).not.toBeCloseTo(naive, 3);
  });

  it('returns a null average rather than 0 when nothing is scorable', () => {
    const s = summariseScores([computeDecisionScore(input({ alignment: 'NOT_DETERMINABLE' }))]);
    expect(s.average).toBeNull();
    expect(s.scorable).toBe(0);
  });
});

// ===========================================================================
// Effort signal
// ===========================================================================

describe('effortSignals', () => {
  it('surfaces a block as BLOCKED_OPPOSITION, the strongest positive signal', () => {
    const s = effortSignals({
      alignment: 'KEPT',
      bill_effect: 'HINDER',
      cloture_vote: 'NAY',
      passage_vote: 'NA',
    });
    expect(s).toContain('BLOCKED_OPPOSITION');
    expect(s).not.toContain('VOTED_AGAINST');
  });

  it('is additive — one action can carry several signals', () => {
    const s = effortSignals({
      alignment: 'KEPT',
      bill_effect: 'ADVANCE',
      passage_vote: 'YEA',
      is_sponsor: true,
    });
    expect(s).toEqual(expect.arrayContaining(['AUTHORED', 'VOTED_TO_ADVANCE']));
  });

  it('distinguishes a procedural switch from silence', () => {
    const preserved = effortSignals({
      alignment: 'PROCEDURAL_SWITCH',
      bill_effect: 'ADVANCE',
      passage_vote: 'NAY',
      is_sponsor: true,
    });
    const silence = effortSignals({ alignment: 'NOT_DETERMINABLE', bill_effect: 'ADVANCE' });

    expect(preserved).toContain('PRESERVED_FOR_RECONSIDERATION');
    expect(silence).toContain('NO_ACTION');
    // Both are frozen by the scorer. They must not render the same.
    expect(preserved).not.toEqual(silence);
  });

  it('marks a vote against the goal', () => {
    expect(
      effortSignals({ alignment: 'BROKE', bill_effect: 'ADVANCE', passage_vote: 'NAY' }),
    ).toContain('VOTED_AGAINST');
    expect(
      effortSignals({ alignment: 'BROKE', bill_effect: 'HINDER', passage_vote: 'YEA' }),
    ).toContain('VOTED_AGAINST');
  });

  it('reports NO_ACTION only when there is genuinely nothing on record', () => {
    expect(effortSignals({ alignment: 'NOT_DETERMINABLE', bill_effect: 'NEUTRAL' })).toEqual([
      'NO_ACTION',
    ]);
    expect(
      effortSignals({ alignment: 'KEPT', bill_effect: 'ADVANCE', is_cosponsor: true }),
    ).not.toContain('NO_ACTION');
  });
});

// ===========================================================================
// Bill outcome
// ===========================================================================

describe('billOutcome', () => {
  it('prefix-matches the raw scraper vocabulary', () => {
    expect(billOutcome({ status: 'ENACTED:SIGNED' }).outcome).toBe('BECAME_LAW');
    expect(billOutcome({ status: 'PASS_OVER:HOUSE' }).outcome).toBe('PASSED_SENATE');
    expect(billOutcome({ status: 'PROV_KILL:CLOTUREFAILED' }).outcome).toBe('DIED_ON_FLOOR');
    expect(billOutcome({ status: 'REFERRED' }).outcome).toBe('IN_COMMITTEE');
    // REPORTED cleared committee; REFERRED never left it. Distinct states.
    expect(billOutcome({ status: 'REPORTED' }).outcome).toBe('REPORTED_OUT');
    expect(billOutcome({ status: 'VETOED:POCKET' }).outcome).toBe('VETOED');
  });

  it('degrades to the vote fields when no status is joined', () => {
    const cloture = billOutcome({ cloture_vote: 'NAY', passage_vote: 'NA' });
    expect(cloture.outcome).toBe('DIED_AT_CLOTURE');
    expect(cloture.derived_from_votes).toBe(true);

    expect(billOutcome({ passage_vote: 'YEA' }).outcome).toBe('PASSED_SENATE');
    expect(billOutcome({}).outcome).toBe('NEVER_SCHEDULED');
  });

  it('prefers a joined status over the vote-derived fallback', () => {
    const r = billOutcome({ status: 'ENACTED:SIGNED', cloture_vote: 'NAY' });
    expect(r.outcome).toBe('BECAME_LAW');
    expect(r.derived_from_votes).toBe(false);
  });

  it('treats only enacted and vetoed as terminal', () => {
    expect(isTerminal('BECAME_LAW')).toBe(true);
    expect(isTerminal('VETOED')).toBe(true);
    // A failed bill can come back under a motion to reconsider.
    expect(isTerminal('DIED_ON_FLOOR')).toBe(false);
    expect(isTerminal('DIED_AT_CLOTURE')).toBe(false);
  });

  it('never renders a status without an as-of date', () => {
    expect(statusWithAsOf('Became law', '2026-08-15T00:00:00Z')).toContain('verified August');
    // No date is stated as missing rather than quietly omitted.
    expect(statusWithAsOf('Became law', null)).toContain('as-of date unavailable');
    expect(statusWithAsOf('Became law', '')).not.toBe('Became law');
  });

  // Upstream writes these literals instead of a timestamp. Parsed as dates they
  // render as "verified Unknown", which claims a verification that never
  // happened — the exact opposite of what the as-of stamp is for.
  it('treats the upstream sentinels as unverified, not as dates', () => {
    for (const sentinel of ['Unknown', 'Unverified', 'UNKNOWN', 'unverified', 'No Change']) {
      const out = statusWithAsOf('Became law', sentinel);
      expect(out, sentinel).toContain('not verified');
      expect(out, sentinel).not.toContain('verified ' + sentinel);
    }
  });
});

// ===========================================================================
// Policy positions — the 2026-08-19 WF11 split.
//
// Before the node change, CONSISTENT/INCONSISTENT fell through the KEPT/BROKE
// guard and froze to decision_score null. That is a bigger deal here than
// upstream: dispatch defaults free-typed queries to 'Policy Position', so the
// freeze would have hit essentially every query this tool answers if the score
// were ever surfaced.
// ===========================================================================

const position = (over: Partial<DecisionScoreInput> = {}): DecisionScoreInput =>
  input({ statement_type: 'Policy Position', alignment: 'CONSISTENT', ...over });

describe('policy positions — separate scale, separate index', () => {
  it('scores CONSISTENT instead of freezing it', () => {
    const r = computeDecisionScore(position());
    expect(r.scorable).toBe(true);
    expect(r.decision_score).not.toBeNull();
  });

  it('scores INCONSISTENT instead of freezing it', () => {
    const r = computeDecisionScore(position({ alignment: 'INCONSISTENT' }));
    expect(r.scorable).toBe(true);
    expect(r.decision_score).not.toBeNull();
  });

  it('routes positions to CONSISTENCY and promises to TRUST', () => {
    expect(computeDecisionScore(position()).index_bucket).toBe('CONSISTENCY');
    expect(computeDecisionScore(input()).index_bucket).toBe('TRUST');
  });

  it('carries the bucket on frozen rows too, so a freeze cannot be misfiled', () => {
    // The live node omits these on the VERDICT_WITHOUT_ACTION branch; downstream
    // then defaults them to Campaign Promise / TRUST. Guard against inheriting
    // that if this port is ever re-synced carelessly.
    const r = computeDecisionScore(position({ action_tier: 'NONE' }));
    expect(r.scorable).toBe(false);
    expect(r.index_bucket).toBe('CONSISTENCY');
    expect(r.statement_type).toBe('Policy Position');
  });

  it('still freezes PROCEDURAL_SWITCH for positions', () => {
    const r = computeDecisionScore(position({ alignment: 'PROCEDURAL_SWITCH' }));
    expect(r.scorable).toBe(false);
    expect(r.decision_score).toBeNull();
  });

  // The asymmetry is the whole point of separate tables: lower upside AND
  // softer downside. A single multiplier could not express both.
  it('scores a position below the promise on the positive side', () => {
    const promise = computeDecisionScore(input({ alignment: 'KEPT' }));
    const pos = computeDecisionScore(position({ alignment: 'CONSISTENT' }));
    expect(pos.base_score!).toBeLessThan(promise.base_score!);
    expect(pos.base_score!).toBeGreaterThan(0);
  });

  it('penalises an inconsistency less than a broken promise', () => {
    const promise = computeDecisionScore(input({ alignment: 'BROKE' }));
    const pos = computeDecisionScore(position({ alignment: 'INCONSISTENT' }));
    expect(pos.base_score!).toBeGreaterThan(promise.base_score!); // less negative
    expect(pos.base_score!).toBeLessThan(0);
  });

  it('applies the position tables on every action tier', () => {
    const tiers: Array<[DecisionScoreInput['action_tier'], number, number]> = [
      ['VOTED', 0.9, 0.75],
      ['SPONSOR', 0.45, 0.38],
      ['CO_SPONSOR', 0.3, 0.25],
      ['ABSTAIN', -0.3, -0.25],
    ];
    for (const [tier, promiseBase, positionBase] of tiers) {
      expect(computeDecisionScore(input({ action_tier: tier })).base_score).toBe(promiseBase);
      expect(computeDecisionScore(position({ action_tier: tier })).base_score).toBe(positionBase);
    }
  });

  it('keeps campaign-promise scoring byte-identical to before the split', () => {
    // The node change must not have moved promise numbers. Method spec worked
    // example: HINDER + opposed -> KEPT, DECISIVE_BLOCK, base 0.9 + 0.05, ×1.15.
    const r = computeDecisionScore(input({ vote_pattern: 'DECISIVE_BLOCK' }));
    expect(r.base_score).toBe(0.9);
    expect(r.decision_score).toBe(1.0925);
    expect(r.index_bucket).toBe('TRUST');
  });
});
