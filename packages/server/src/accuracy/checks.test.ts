import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GatedAction, QueryResult, ScoredResult } from '@receipts/shared';
import { scoreMatches, type ScorableMatch } from '../scoring/score.js';
import { checkCase, didNothingSentences, verdictTokens, type EvalCase } from './checks.js';
import { classificationOf, whereIsBill } from './diagnose.js';

// ===========================================================================
// The accuracy set's checks, on scorer-built results. No model, no money:
// this is what makes a PASS from `npm run eval` mean something.
// ===========================================================================

function row(bill_id: string, over: Partial<ScorableMatch> = {}): ScorableMatch {
  return {
    action_uid: `ACT-${bill_id}`, bill_id, title: 'A bill', summary: 'S.', intended_effects: 'E.',
    mechanisms: 'M.', action_type: 'voted', is_sponsor: false, is_cosponsor: false, vote: 'Yea',
    cloture_vote: 'NA', passage_vote: 'Yea', bill_keywords: [], primary_issue: 'x', sub_issue: 'y', source_url: '',
    score: 0.8, strength: 'STRONG', missing_fields: [], bill_effect: 'ADVANCE', bill_effect_reasoning: 'r',
    alignment_confidence: 0.9,
    ...over,
  } as ScorableMatch;
}
const NAY = { vote: 'Nay', passage_vote: 'Nay' };

function result(scored: ScoredResult, over: Partial<QueryResult> = {}): QueryResult {
  return {
    senator: { politician_id: 'X000001', name: 'Jane Example', cached: true },
    interpretation: { raw: 'x', restated: 'x', primary_issue: 'x', sub_issue: '', stance: 'In Favor', statement_type: 'Policy Position', provenance: 'default', promise_type: 'policy' },
    scored,
    explanation: { why: 'Because.', connectors: {}, confidence: 0.5 },
    ...over,
  } as unknown as QueryResult;
}
const score = (m: ScorableMatch[]) => scoreMatches({ promise_type: 'policy', statement_type: 'Policy Position', matches: m });
const nd = (reason: ScoredResult['nd_reason'], m: ScorableMatch[]): ScoredResult =>
  ({ ...score(m), verdict: 'NOT_DETERMINABLE', band: null, mode: 'not_determinable', nd_reason: reason, ranked: [] });

const base = (over: Partial<EvalCase>): EvalCase =>
  ({ id: 't', senator: 'X000001', statement: 'x', verdict: ['KEPT'], must_have: [], ...over });

describe('the cases file', () => {
  it('parses, and every case names a senator, a statement and an allowed verdict', () => {
    const file = fileURLToPath(new URL('../../../../docs/eval/cases.json', import.meta.url));
    const { cases } = JSON.parse(readFileSync(file, 'utf8')) as { cases: EvalCase[] };
    expect(cases).toHaveLength(49);
    for (const c of cases) {
      expect(c.senator).toMatch(/^[A-Z]\d{6}$/);
      expect(c.statement.length).toBeGreaterThan(5);
      expect(c.verdict.length).toBeGreaterThan(0);
    }
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });
});

describe('1. verdict', () => {
  it('single and mixed are different outcomes', () => {
    expect(verdictTokens(result(score([row('a-1')])))).toEqual(['KEPT']);
    expect(verdictTokens(result(score([row('a-1'), row('a-2'), row('a-3', NAY)])))).toEqual(['KEPT_MIXED']);
  });

  it('BROKE published after review needs a disposition and a counterargument', () => {
    const s = score([row('a-1', NAY)]);
    expect(s.verdict).toBe('BROKE');
    expect(verdictTokens(result(s))).toEqual(['BROKE']);
    const judged = result(s, { judge: { disposition: 'PASS', withheld: false, counterargument: 'He says…' } as never });
    expect(verdictTokens(judged)).toEqual(['BROKE', 'BROKE_JUDGED']);
    const noCounter = result(s, { judge: { disposition: 'PASS', withheld: false, counterargument: null } as never });
    expect(verdictTokens(noCounter)).toEqual(['BROKE']);
  });

  it('withheld after review: the judge ran; a judge that could not run does not count', () => {
    const s = nd('WITHHELD_PENDING_REVIEW', [row('a-1', NAY)]);
    expect(verdictTokens(result(s, { judge: { disposition: 'REVIEW_REQUIRED', withheld: true } as never })))
      .toContain('WITHHELD_AFTER_REVIEW');
    expect(verdictTokens(result(s, { judge: { disposition: 'JUDGE_ERROR', withheld: true, unavailable: true } as never })))
      .not.toContain('WITHHELD_AFTER_REVIEW');
  });

  it('band and count fail only when the case sets them', () => {
    const r = result(score([row('a-1'), row('a-2')]));
    expect(checkCase(base({}), r, '').verdict.pass).toBe(true);
    expect(checkCase(base({ band: 'Low' }), r, '').verdict.pass).toBe(r.scored.band === 'Low');
    expect(checkCase(base({ count: { total: 2, consistent: 2 } }), r, '').verdict.pass).toBe(true);
    expect(checkCase(base({ count: { total: 3 } }), r, '').verdict.pass).toBe(false);
  });

  it('a flagged band is reported, not failed', () => {
    const r = result(score([row('a-1', { score: 0.6 })]));
    expect(r.scored.band).toBe('Low');
    const rep = checkCase(base({ flag_band: ['Low'] }), r, '');
    expect(rep.verdict.pass).toBe(true);
    expect(rep.flags).toEqual(['band is Low (flagged, not failed)']);
  });
});

describe('2 and 3. must-have and direction', () => {
  it('present with the right direction passes; extra bills are reported only', () => {
    const rep = checkCase(base({ must_have: [{ bill: 'a-1', direction: 'consistent' }] }), result(score([row('a-1'), row('b-2')])), '');
    expect([rep.must_have.pass, rep.direction.pass, rep.pass]).toEqual([true, true, true]);
    expect(rep.extra_bills).toEqual(['b-2 consistent']);
  });

  it('gated out is not present, and says so', () => {
    const gated: GatedAction[] = [{ action_uid: 'G', bill_id: 'a-1', title: 't', gate: 'G4_vehicle', outcome: 'NOT_APPLICABLE', reason: 'r' }];
    const rep = checkCase(base({ must_have: [{ bill: 'a-1', direction: 'consistent' }] }), result(score([row('b-2')]), { gated }), '');
    expect(rep.must_have.pass).toBe(false);
    expect(rep.must_have.detail).toEqual(['a-1: gated (G4_vehicle)']);
    expect(rep.direction.pass).toBe(false);
  });

  it('the wrong direction fails DIRECTION, not MUST-HAVE', () => {
    const rep = checkCase(base({ must_have: [{ bill: 'a-1', direction: 'consistent' }] }), result(score([row('a-1', NAY), row('b-2'), row('c-3')])), '');
    expect(rep.must_have.pass).toBe(true);
    expect(rep.direction.pass).toBe(false);
  });

  it('an outcome, when given, is checked too', () => {
    const c = base({ must_have: [{ bill: 'a-1', direction: 'not_counted', outcome: 'PROCEDURAL_SWITCH' }] });
    const neutral = result(score([row('a-1', { bill_effect: 'NEUTRAL' }), row('b-2')]));
    expect(checkCase(c, neutral, '').direction.pass).toBe(false);
  });

  it('any_of with a minimum', () => {
    const c = base({ must_have: [{ any_of: ['a-1', 'a-2', 'a-3', 'a-4'], min: 3, direction: 'consistent' }] });
    expect(checkCase(c, result(score([row('a-1'), row('a-2'), row('a-3')])), '').pass).toBe(true);
    const two = checkCase(c, result(score([row('a-1'), row('a-2')])), '');
    expect([two.must_have.pass, two.direction.pass]).toEqual([false, false]);
  });

  it('direction "any" only requires presence, and reports the reading', () => {
    const rep = checkCase(base({ must_have: [{ bill: 'a-1', direction: 'any' }] }), result(score([row('a-1', NAY), row('b-2'), row('c-3')])), '');
    expect(rep.direction.pass).toBe(true);
    expect(rep.readings['a-1']).toBe('runs_counter (INCONSISTENT)');
  });
});

describe('4. forbidden', () => {
  it('a bill counted the forbidden way', () => {
    const c = base({ forbidden: [{ bill_direction: { bill: 'a-1', direction: 'runs_counter' } }] });
    expect(checkCase(c, result(score([row('a-1'), row('b-2')])), '').forbidden.pass).toBe(true);
    expect(checkCase(c, result(score([row('a-1', NAY), row('b-2'), row('c-3')])), '').forbidden.pass).toBe(false);
  });

  it('BROKE published without a judge', () => {
    const c = base({ verdict: ['BROKE_JUDGED'], forbidden: ['BROKE_WITHOUT_JUDGE'] });
    expect(checkCase(c, result(score([row('a-1', NAY)])), '').forbidden.detail).toEqual([
      'BROKE published without a judge disposition and counterargument',
    ]);
  });

  it('a count line on a not-determinable answer, and any count line', () => {
    // The real builder returns null here, so this cannot fire on a real result —
    // which is the point of checking it.
    const r = result(nd('WITHHELD_PENDING_REVIEW', [row('a-1', NAY)]));
    expect(checkCase(base({ forbidden: ['TALLY_ON_NOT_DETERMINABLE', 'TALLY_SHOWN'] }), r, '').forbidden.pass).toBe(true);
    const kept = result(score([row('a-1')]));
    expect(checkCase(base({ forbidden: ['TALLY_SHOWN'] }), kept, '').forbidden.pass).toBe(false);
  });

  it('"did nothing" wording is about the senator, not about bills', () => {
    // Case 3, run on evaluator v8: a fact about the bills, not the senator.
    expect(didNothingSentences('The key limit here is that the two substantive bills were never voted on by the full Senate — what we have is co-sponsorship.', 'Schumer')).toEqual([]);
    expect(didNothingSentences('They were never voted on by the full Senate.', 'Schumer')).toEqual([]);
    expect(didNothingSentences('Schumer never voted for it.', 'Schumer')).toEqual(['Schumer never voted for it.']);
    expect(didNothingSentences('The senator has simply never acted on this.')).toHaveLength(1);
    expect(didNothingSentences('We found no record of Thune on this.', 'Thune')).toHaveLength(1);
    expect(didNothingSentences('This is his full record.')).toHaveLength(1);
  });

  it('"did nothing" wording, but not the sentences that guard against it', () => {
    expect(didNothingSentences('He did nothing on this. Fine.')).toEqual(['He did nothing on this.']);
    expect(didNothingSentences('The senator has no record on drug prices.')).toHaveLength(1);
    expect(
      didNothingSentences(
        'We searched the 118th and 119th Congress. Anything before that is outside the record we have analyzed, so an empty result here is not a finding that the senator has no record on the subject. ' +
          "Our search can miss things, so that isn't proof there are none.",
      ),
    ).toEqual([]);
  });
});

describe('where a missing bill went (from the trace)', () => {
  const steps = [
    { stage: 'RETRIEVE', output: { returned: 10, candidates: [{ bill_id: 'a-1', score: 0.62 }, { bill_id: 'b-2', score: 0.53 }, { bill_id: 'c-3', score: 0.51 }] } },
    { stage: 'RELEVANCE', subject: 'ACT-c-3-X000001', output: { parsed: { verdict: 'FALSE_POSITIVE' } } },
    { stage: 'RELEVANCE', subject: 'ACT-b-2-X000001', output: { parsed: { verdict: 'TRUE_POSITIVE' } } },
    { stage: 'CLASSIFY', output: { interpretation: { primary_issue: 'Tax Reform', sub_issue: 'Tax Cuts & Credits', stance: 'Opposed' }, disagreements: ['primary_issue: orchestrator said "Budget & Economy"'] } },
  ];

  it('not retrieved, dropped by relevance, below the floor, or retrieved', () => {
    expect(whereIsBill('z-9', steps)).toBe('not retrieved at or above the retrieval floor 0.5 (3 of 10 returned were)');
    expect(whereIsBill('c-3', steps)).toBe('retrieved (rank 3 of 3, score 0.510); dropped by the relevance check as FALSE_POSITIVE');
    // At or above the evidence floor (0.50 since 2026-10-10).
    expect(whereIsBill('b-2', steps)).toBe('retrieved (rank 2 of 3, score 0.530), relevance TRUE_POSITIVE');
    expect(whereIsBill('a-1', steps)).toBe('retrieved (rank 1 of 3, score 0.620)');
  });

  it('the classification, with the orchestrator’s disagreement', () => {
    expect(classificationOf(steps)).toBe('Tax Reform / Tax Cuts & Credits · Opposed (orchestrator disagreed: primary_issue: orchestrator said "Budget & Economy")');
  });
});

describe('a list of directions', () => {
  it('any one of them passes', () => {
    const c = base({ must_have: [{ bill: 'a-1', direction: ['consistent', 'not_counted'] }] });
    expect(checkCase(c, result(score([row('a-1'), row('b-2')])), '').direction.pass).toBe(true);
    expect(checkCase(c, result(score([row('a-1', { bill_effect: 'NEUTRAL' }), row('b-2')])), '').direction.pass).toBe(true);
    const counter = checkCase(c, result(score([row('a-1', NAY), row('b-2'), row('c-3')])), '');
    expect(counter.direction.pass).toBe(false);
    expect(counter.direction.detail[0]).toMatch(/expected consistent or not_counted$/);
  });
});

describe('forbidden text, and a not-determinable reason list', () => {
  it('text on the card is forbidden, case-insensitively', () => {
    const c = base({ verdict: ['NOT_DETERMINABLE'], forbidden: [{ text: "We couldn't tell what to check" }] });
    const r = result(nd('NOT_EVALUABLE', []));
    expect(checkCase(c, r, 'This is too broad to check against specific bills.').forbidden.pass).toBe(true);
    expect(checkCase(c, r, "we couldn't tell what to check").forbidden.pass).toBe(false);
  });

  it('nd_reasons narrows only a not-determinable answer', () => {
    const c = base({ verdict: ['NOT_DETERMINABLE', 'KEPT'], nd_reasons: ['NOT_EVALUABLE'] });
    expect(checkCase(c, result(nd('NOT_EVALUABLE', [])), '').verdict.pass).toBe(true);
    expect(checkCase(c, result(nd('NO_MATCHES', [])), '').verdict.pass).toBe(false);
    expect(checkCase(c, result(score([row('a-1')])), '').verdict.pass).toBe(true);
  });
});
