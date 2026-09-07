import { describe, expect, it } from 'vitest';
import {
  BANNED_LEVEL1_TERMS,
  BANNED_MOTIVE_TERMS,
  ND_REASON_COPY,
  toVerdict,
  type PromiseType,
  type StatementType,
} from '@receipts/shared';
import { scoreMatches, type ScorableMatch } from './score.js';
import {
  capSplitConfidence,
  deriveAlignment,
  effectiveVote,
  isSplitVote,
  voteOf,
  type AlignmentInput,
} from './deriveAlignment.js';
import { PATTERN_NARRATIVE, actionTier, votePattern } from './votePattern.js';

/**
 * `deriveAlignment` returns { verdict, governing, split } since the fix/06 port.
 * Most tests here assert the table, so they read the verdict through this.
 * Tests that care about disclosure call `deriveAlignment` directly.
 */
const verdictOf = (
  input: AlignmentInput,
  statementType: StatementType = 'Campaign Promise',
): string => deriveAlignment(input, statementType).verdict;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let uid = 0;
function match(over: Partial<ScorableMatch> = {}): ScorableMatch {
  uid += 1;
  return {
    action_uid: `ACT-test-${uid}`,
    bill_id: `bill-${uid}`,
    title: 'A Bill',
    summary: 'Summary.',
    intended_effects: 'Effects.',
    mechanisms: 'Mechanisms.',
    action_type: 'voted',
    is_sponsor: false,
    is_cosponsor: false,
    vote: 'NA',
    cloture_vote: 'NA',
    passage_vote: 'NA',
    bill_keywords: ['keyword'],
    primary_issue: 'Health Care',
    sub_issue: 'Prescription Drugs',
    source_url: 'https://congress.gov/example',
    score: 0.72,
    strength: 'STRONG',
    missing_fields: [],
    bill_effect: 'ADVANCE',
    bill_effect_reasoning: 'It advances the goal.',
    ...over,
  };
}

const run = (
  matches: ScorableMatch[],
  promise_type: PromiseType = 'policy',
  statement_type: StatementType = 'Campaign Promise',
) => scoreMatches({ promise_type, statement_type, matches });

// ===========================================================================
// The alignment table — the two-factor port
// ===========================================================================

describe('deriveAlignment — the two-factor table', () => {
  it('ADVANCE + YEA is KEPT; ADVANCE + NAY is BROKE', () => {
    expect(verdictOf({ bill_effect: 'ADVANCE', passage_vote: 'YEA' }, 'Campaign Promise')).toBe('KEPT');
    expect(verdictOf({ bill_effect: 'ADVANCE', passage_vote: 'NAY' }, 'Campaign Promise')).toBe('BROKE');
  });

  // THE REGRESSION GUARD. A NAY on a bill that would set the goal back is
  // KEEPING the promise. The removed three-factor formula (stance × effect ×
  // behaviour) inverts this for every "Opposed" promise, which is how a 25%
  // error rate on HINDER rows got shipped once already. If this test fails,
  // someone has re-introduced a stance term.
  it('HINDER + NAY is KEPT (CRA-shaped inversion)', () => {
    expect(verdictOf({ bill_effect: 'HINDER', passage_vote: 'NAY' }, 'Campaign Promise')).toBe('KEPT');
    expect(verdictOf({ bill_effect: 'HINDER', passage_vote: 'YEA' }, 'Campaign Promise')).toBe('BROKE');
  });

  // Stance never enters the table. Same effect + same action must give the same
  // verdict no matter what the promise's stance was — that is the whole point.
  it('is stance-independent by construction', () => {
    const input = { bill_effect: 'HINDER' as const, passage_vote: 'NAY' };
    // statementType picks the LABEL PAIR; it is not a stance and must not act
    // like one. The same effect + action yields the same direction under both
    // vocabularies — only the words change.
    expect(verdictOf(input, 'Campaign Promise')).toBe('KEPT');
    expect(verdictOf(input, 'Policy Position')).toBe('CONSISTENT');
    expect(Object.keys(input)).not.toContain('stance');
  });

  it('NEUTRAL or unreadable effect is NOT_DETERMINABLE, never a forced verdict', () => {
    expect(verdictOf({ bill_effect: 'NEUTRAL', passage_vote: 'YEA' }, 'Campaign Promise')).toBe(
      'NOT_DETERMINABLE',
    );
    expect(verdictOf({ bill_effect: '', passage_vote: 'YEA' }, 'Campaign Promise')).toBe('NOT_DETERMINABLE');
    expect(verdictOf({ bill_effect: 'ERROR', passage_vote: 'YEA' }, 'Campaign Promise')).toBe('ERROR');
  });

  it('no vote and no sponsorship is NOT_DETERMINABLE', () => {
    expect(verdictOf({ bill_effect: 'ADVANCE' }, 'Campaign Promise')).toBe('NOT_DETERMINABLE');
  });

  it('sponsorship without a vote counts as support', () => {
    expect(verdictOf({ bill_effect: 'ADVANCE', is_cosponsor: true }, 'Campaign Promise')).toBe('KEPT');
    expect(verdictOf({ bill_effect: 'HINDER', is_sponsor: true }, 'Campaign Promise')).toBe('BROKE');
  });

  it('sponsored then voted NAY is a procedural switch, not opposition', () => {
    expect(verdictOf({ bill_effect: 'ADVANCE', is_sponsor: true, passage_vote: 'NAY' }, 'Campaign Promise')).toBe(
      'PROCEDURAL_SWITCH',
    );
  });
});

// ===========================================================================
// Abstentions — the guard set from Resolution 1
// ===========================================================================

describe('abstentions cannot read as support', () => {
  it('normalises every non-directional vote value to null', () => {
    for (const v of ['Not Voting', 'NOT VOTING', 'Present', 'NA', '', null, undefined]) {
      expect(voteOf(v)).toBeNull();
    }
    expect(voteOf('yea')).toBe('YEA');
    expect(voteOf('No')).toBe('NAY');
  });

  it('abstain-only + ADVANCE is not KEPT', () => {
    const outcome = verdictOf({ bill_effect: 'ADVANCE', vote: 'Not Voting' }, 'Campaign Promise');
    expect(outcome).not.toBe('KEPT');
    expect(outcome).toBe('NOT_DETERMINABLE');
  });

  it('abstain-only + HINDER is not KEPT', () => {
    const outcome = verdictOf({ bill_effect: 'HINDER', vote: 'Not Voting' }, 'Campaign Promise');
    expect(outcome).not.toBe('KEPT');
    expect(outcome).toBe('NOT_DETERMINABLE');
  });

  it('a real NAY still governs when mixed with an abstention', () => {
    expect(
      verdictOf(
        { bill_effect: 'ADVANCE', cloture_vote: 'Not Voting', passage_vote: 'NAY' },
        'Campaign Promise',
      ),
    ).toBe('BROKE');
    expect(effectiveVote({ bill_effect: 'ADVANCE', cloture_vote: 'Not Voting', passage_vote: 'NAY' })).toBe(
      'NAY',
    );
  });

  it('a sponsor who is recorded Not Voting lands on the abstain tier, not sponsorship', () => {
    expect(actionTier({ bill_effect: 'ADVANCE', is_sponsor: true, vote: 'Not Voting' })).toBe(
      'ABSTAIN',
    );
  });
});

// ===========================================================================
// Split votes — the "ANY NAY GOVERNS" regression set (fix/06, 2026-09-05)
//
// The removed rule read every split as opposition, in both directions. That
// produced 14 false accusations in the 79-row audit. These tests pin the
// binding-threshold rule that replaced it, and the disclosure that must travel
// with any split row.
// ===========================================================================

describe('split cloture/passage votes', () => {
  // THE REGRESSION GUARD. This is the case the old rule got wrong: the March
  // 2025 CR shape, where the cloture YEA was the operative 60-vote act and the
  // passage NAY was symbolic. "ANY NAY GOVERNS" called this BROKE. It is KEPT.
  // If this test fails, someone has reinstated a rule that any NAY decides.
  it('cloture YEA over a passage NAY is KEPT on an ADVANCE bill', () => {
    const d = deriveAlignment(
      { bill_effect: 'ADVANCE', cloture_vote: 'YEA', passage_vote: 'NAY' },
      'Campaign Promise',
    );
    expect(d.verdict).toBe('KEPT');
    expect(d.governing).toContain('CLOTURE');
    expect(d.split).toBe(true);
  });

  it('is symmetric — the same split on a HINDER bill is BROKE', () => {
    expect(
      verdictOf({ bill_effect: 'HINDER', cloture_vote: 'YEA', passage_vote: 'NAY' }),
    ).toBe('BROKE');
  });

  it('passage governs only when no cloture vote was taken', () => {
    const d = deriveAlignment({ bill_effect: 'ADVANCE', passage_vote: 'NAY' }, 'Campaign Promise');
    expect(d.verdict).toBe('BROKE');
    expect(d.governing).toBe('PASSAGE (no cloture vote)');
    expect(d.split).toBe(false);
  });

  it('agreeing votes are not a split and say so', () => {
    const d = deriveAlignment(
      { bill_effect: 'ADVANCE', cloture_vote: 'YEA', passage_vote: 'YEA' },
      'Campaign Promise',
    );
    expect(d.split).toBe(false);
    expect(d.governing).toBe('CLOTURE+PASSAGE (agree)');
  });

  it('an abstention on one leg is not a split', () => {
    expect(isSplitVote({ bill_effect: 'ADVANCE', cloture_vote: 'Not Voting', passage_vote: 'NAY' })).toBe(
      false,
    );
    expect(isSplitVote({ bill_effect: 'ADVANCE', cloture_vote: 'YEA', passage_vote: 'NAY' })).toBe(true);
  });

  // Contract 2. The cap is code, not a prompt instruction, so it holds even
  // when the evaluator ignores it.
  it('caps confidence at 0.75 on a split, and leaves clean rows alone', () => {
    expect(capSplitConfidence(0.95, true)).toBe(0.75);
    expect(capSplitConfidence(0.6, true)).toBe(0.6);
    expect(capSplitConfidence(0.95, false)).toBe(0.95);
  });

  it('scoreMatches applies the cap and flags the row for disclosure', () => {
    const scored = run([
      match({
        bill_effect: 'ADVANCE',
        cloture_vote: 'YEA',
        passage_vote: 'NAY',
        alignment_confidence: 0.92,
      }),
    ]);
    const row = scored.evidence[0]!;
    expect(row.alignment_confidence).toBe(0.75);
    expect(row.vote_flags).toContain('SPLIT_VOTE');
    expect(row.vote_governing).toContain('CLOTURE');
  });

  it('carries a null confidence through rather than inventing a zero', () => {
    const scored = run([match({ bill_effect: 'ADVANCE', passage_vote: 'YEA' })]);
    expect(scored.evidence[0]!.alignment_confidence).toBeNull();
  });
});

// ===========================================================================
// Vote patterns
// ===========================================================================

describe('votePattern', () => {
  it('reads cloture and passage as distinct acts', () => {
    expect(votePattern('NAY', 'YEA', 'YEA')).toBe('BLOCKED_THEN_JOINED');
    expect(votePattern('YEA', 'NAY', 'NAY')).toBe('ENABLED_THEN_OPPOSED');
    expect(votePattern('NAY', 'NA', 'NAY')).toBe('DECISIVE_BLOCK');
    expect(votePattern('YEA', 'NA', 'YEA')).toBe('CLOTURE_ONLY_YEA');
    expect(votePattern('NA', 'YEA', 'YEA')).toBe('PASSAGE_ONLY');
    expect(votePattern('NA', 'NA', 'NA')).toBe('NO_FLOOR_ACTION');
  });

  // Right answer, and now for the right reason: cloture is the binding
  // 60-vote threshold, so a cloture NAY governs a later passage YEA. The old
  // rule reached the same verdict by asserting that any NAY governs, which
  // gave the wrong answer on the mirror case below.
  it('reads a cloture NAY over a passage YEA — cloture governs', () => {
    const d = deriveAlignment(
      { bill_effect: 'ADVANCE', cloture_vote: 'NAY', passage_vote: 'YEA' },
      'Campaign Promise',
    );
    expect(d.verdict).toBe('BROKE');
    expect(d.governing).toContain('CLOTURE');
    expect(d.split).toBe(true);
  });

  it('falls back to the flat rollup only when no typed vote exists', () => {
    expect(votePattern('NA', 'NA', 'YEA')).toBe('PASSAGE_ONLY');
  });
});

// ===========================================================================
// Gates
// ===========================================================================

describe('G0 — is there a checkable commitment', () => {
  // Regression guard for a real false positive: an unclassifiable promise
  // ("build a colony on Mars") was being forced into a taxonomy row, whose
  // keywords then went into the embedded query and matched drug-pricing bills
  // at High confidence. A vague promise must stop before retrieval counts.
  it('an unevaluable promise short-circuits before any match is scored', () => {
    const r = scoreMatches({
      promise_type: 'policy',
      statement_type: 'Campaign Promise',
      is_evaluable: false,
      matches: [match({ bill_effect: 'ADVANCE', passage_vote: 'YEA', score: 0.9 })],
    });
    expect(r.verdict).toBe('NOT_DETERMINABLE');
    expect(r.nd_reason).toBe('NOT_EVALUABLE');
    expect(r.band).toBeNull();
    expect(r.evidence).toHaveLength(0);
  });

  it('defaults to evaluable so the gate is opt-in', () => {
    const r = run([match({ bill_effect: 'ADVANCE', passage_vote: 'YEA' })]);
    expect(r.verdict).toBe('KEPT');
  });
});

describe('G1 — determinability', () => {
  it('zero matches is NOT_DETERMINABLE with a NO_MATCHES reason', () => {
    const r = run([]);
    expect(r.verdict).toBe('NOT_DETERMINABLE');
    expect(r.nd_reason).toBe('NO_MATCHES');
    expect(r.band).toBeNull();
    expect(r.mode).toBe('not_determinable');
  });

  it('distinguishes "nothing found" from "nothing close enough"', () => {
    const r = run([match({ score: 0.52, strength: 'WEAK' })]);
    expect(r.verdict).toBe('NOT_DETERMINABLE');
    expect(r.nd_reason).toBe('ALL_BELOW_FLOOR');
  });

  it('never reaches a band on a NOT_DETERMINABLE — it is not "low confidence"', () => {
    for (const r of [run([]), run([match({ score: 0.51, strength: 'WEAK' })])]) {
      expect(r.band).toBeNull();
    }
  });

  it('related actions that cannot be directed are NOT_DETERMINABLE, not a guess', () => {
    const r = run([match({ bill_effect: 'NEUTRAL', passage_vote: 'YEA' })]);
    expect(r.verdict).toBe('NOT_DETERMINABLE');
    expect(r.nd_reason).toBe('ALL_NEUTRAL');
    // The evidence is still returned so the UI can show what was considered.
    expect(r.evidence).toHaveLength(1);
  });

  it('a procedural switch presents as NOT_DETERMINABLE with its own reason', () => {
    const r = run([match({ is_sponsor: true, passage_vote: 'NAY' })]);
    expect(r.verdict).toBe('NOT_DETERMINABLE');
    expect(r.nd_reason).toBe('PROCEDURAL_SWITCH');
    // ...but the distinct cause survives into the analyst trace.
    expect(r.receipt.scoring_flags).toContain('PROCEDURAL_SWITCH');
    expect(r.evidence[0]!.outcome).toBe('PROCEDURAL_SWITCH');
    expect(toVerdict(r.evidence[0]!.outcome)).toBe('NOT_DETERMINABLE');
  });

  it('flags missing metadata rather than defaulting it', () => {
    const r = run([
      match({ bill_effect: 'NEUTRAL', missing_fields: ['passage_vote', 'intended_effects'] }),
    ]);
    expect(r.nd_reason).toBe('UNDIRECTABLE_METADATA');
    expect(r.receipt.scoring_flags.join(' ')).toContain('MISSING_METADATA');
  });
});

describe('G2 — direction gate and ranked mode', () => {
  it('a clean unanimous record produces a single verdict', () => {
    const r = run([
      match({ bill_effect: 'ADVANCE', passage_vote: 'YEA', score: 0.8 }),
      match({ bill_effect: 'ADVANCE', passage_vote: 'YEA', score: 0.75 }),
    ]);
    expect(r.verdict).toBe('KEPT');
    expect(r.mode).toBe('single');
    expect(r.ranked).toHaveLength(0);
    expect(r.band).toBe('High');
  });

  it('conflicting evidence routes to ranked mode with the dominant side on top', () => {
    const r = run([
      match({ bill_effect: 'ADVANCE', passage_vote: 'YEA', score: 0.85 }),
      match({ bill_effect: 'ADVANCE', passage_vote: 'YEA', score: 0.8 }),
      match({ bill_effect: 'ADVANCE', passage_vote: 'NAY', score: 0.7 }),
    ]);
    expect(r.mode).toBe('ranked');
    expect(r.ranked).toHaveLength(2);
    expect(r.ranked[0]!.verdict).toBe('KEPT');
    expect(r.ranked[1]!.verdict).toBe('BROKE');
    expect(r.ranked[0]!.weight).toBeGreaterThan(r.ranked[1]!.weight);
  });

  it('caps High at Medium on a contested record', () => {
    // The KEPT subset alone would earn High: two hard matches, strong average.
    const r = run([
      match({ bill_effect: 'ADVANCE', passage_vote: 'YEA', score: 0.9 }),
      match({ bill_effect: 'ADVANCE', passage_vote: 'YEA', score: 0.88 }),
      match({ bill_effect: 'ADVANCE', passage_vote: 'NAY', score: 0.6 }),
    ]);
    expect(r.mode).toBe('ranked');
    expect(r.band).toBe('Medium');
    expect(r.receipt.trace.join(' ')).toContain('capped');
  });

  it('records the weight split and minority share for the analyst view', () => {
    const r = run([
      match({ bill_effect: 'ADVANCE', passage_vote: 'YEA', score: 0.8 }),
      match({ bill_effect: 'ADVANCE', passage_vote: 'NAY', score: 0.8 }),
    ]);
    expect(r.receipt.weight_split.keeps).toBeGreaterThan(0);
    expect(r.receipt.weight_split.breaks).toBeGreaterThan(0);
    expect(r.receipt.minority_share).toBeCloseTo(0.5, 2);
  });
});

// ===========================================================================
// Dials
// ===========================================================================

describe('dials — confidence band', () => {
  // Structural consequence of the WF10A port worth pinning down: a match can
  // only carry a direction if it has a directional vote or a sponsorship, so
  // every *directed* match is hard evidence by construction. Abstentions and
  // procedural switches are soft, and both are undirected. That makes the PRD's
  // "soft-evidence-only -> Low" branch unreachable in this architecture; the
  // branch stays in bandFor as a guard, but the real invariant is this one.
  it('every directed match is hard evidence — soft evidence is always undirected', () => {
    const r = run([
      match({ bill_effect: 'ADVANCE', is_sponsor: true, passage_vote: 'NAY', score: 0.9 }), // procedural switch
      match({ bill_effect: 'ADVANCE', vote: 'Not Voting', score: 0.9 }), // abstention
      match({ bill_effect: 'ADVANCE', passage_vote: 'YEA', score: 0.9 }), // real vote
    ]);
    expect(r.verdict).toBe('KEPT');
    for (const e of r.evidence) {
      const hard = e.evidence_type === 'vote' || e.evidence_type === 'sponsorship';
      expect(hard, `${e.evidence_type} carried direction ${e.direction}`).toBe(
        e.direction !== 'neutral',
      );
    }
    expect(r.receipt.directed_count).toBe(1);
  });

  it('a single strong hard match is Medium, not High', () => {
    const r = run([match({ bill_effect: 'ADVANCE', passage_vote: 'YEA', score: 0.8 })]);
    expect(r.verdict).toBe('KEPT');
    expect(r.band).toBe('Medium');
  });

  it('a single weak-ish match is Low', () => {
    const r = run([match({ bill_effect: 'ADVANCE', passage_vote: 'YEA', score: 0.6 })]);
    expect(r.band).toBe('Low');
  });
});

// ===========================================================================
// Structural guarantees
// ===========================================================================

describe('no silent failures', () => {
  it('always returns a receipt with a trace, on every branch', () => {
    const cases = [
      run([]),
      run([match({ score: 0.52, strength: 'WEAK' })]),
      run([match({ bill_effect: 'NEUTRAL' })]),
      run([match({ bill_effect: 'ADVANCE', passage_vote: 'YEA' })]),
      run([
        match({ bill_effect: 'ADVANCE', passage_vote: 'YEA' }),
        match({ bill_effect: 'ADVANCE', passage_vote: 'NAY' }),
      ]),
    ];
    for (const r of cases) {
      expect(r.receipt).toBeDefined();
      expect(r.receipt.trace.length).toBeGreaterThan(0);
      expect(['KEPT', 'BROKE', 'NOT_DETERMINABLE']).toContain(r.verdict);
    }
  });

  it('is pure — the same input scores identically every time', () => {
    const input = [
      match({ bill_effect: 'HINDER', cloture_vote: 'NAY', passage_vote: 'YEA', score: 0.77 }),
      match({ bill_effect: 'ADVANCE', passage_vote: 'YEA', score: 0.66 }),
    ];
    expect(JSON.stringify(run(input))).toBe(JSON.stringify(run(input)));
  });
});

// ===========================================================================
// Vocabulary discipline — the copy constants ship with the code, so they can
// be linted like code.
// ===========================================================================

describe('voter-facing copy', () => {
  const contains = (haystack: string, needle: string) =>
    haystack.toLowerCase().includes(needle.toLowerCase());

  it('never attributes motive on the silent-avoidance / procedural branches', () => {
    const copy = [ND_REASON_COPY.PROCEDURAL_SWITCH, ND_REASON_COPY.NO_ACTION, ...Object.values(PATTERN_NARRATIVE)];
    for (const line of copy) {
      for (const term of BANNED_MOTIVE_TERMS) {
        expect(contains(line, term), `"${line}" attributes motive via "${term}"`).toBe(false);
      }
    }
  });

  it('keeps statistics out of Level-1 explanations', () => {
    for (const line of Object.values(ND_REASON_COPY)) {
      for (const term of BANNED_LEVEL1_TERMS) {
        expect(contains(line, term), `"${line}" leaks the term "${term}"`).toBe(false);
      }
    }
  });

  it('gives every not-determinable cause its own sentence', () => {
    const values = Object.values(ND_REASON_COPY);
    expect(new Set(values).size).toBe(values.length);
  });
});
