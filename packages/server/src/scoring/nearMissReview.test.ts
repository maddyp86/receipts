import { describe, expect, it } from 'vitest';
import type { MatchedAction } from '@receipts/shared';
import { searchResultOf } from '../data/PineconeActionStore.js';
import { NEAR_MISS_REVIEW_LIMIT, SIMILARITY } from './config.js';
import { scoreMatches, type ScorableMatch } from './score.js';

// ===========================================================================
// The near-miss review (2026-10-10, trace 7e1e8f99). "He promised not to raise
// my taxes" (Schumer): all ten candidates scored 0.45–0.499, the 2025 tax law
// hr1-119 among them at 0.473, and the answer was "nothing found". When nothing
// clears the floor, the best near misses now go to the relevance check.
// ===========================================================================

const action = (bill: string, score: number) =>
  ({ action_uid: `ACT-${bill}-S000148`, bill_id: bill, title: bill, score }) as unknown as MatchedAction;

// The ten scores that trace retrieved.
const TAXES = [
  ['s441-118', 0.499], ['s4297-119', 0.488], ['s5619-119', 0.4795], ['hr1-119', 0.473], ['s4298-119', 0.469],
  ['s1515-119', 0.462], ['hr7024-118', 0.46], ['s3948-119', 0.4585], ['s1992-118', 0.454], ['s4796-119', 0.4538],
] as const;

describe('the search result names the near misses worth reviewing', () => {
  it('the best five at or above the review floor, best first', () => {
    const r = searchResultOf(TAXES.map(([b, s]) => action(b, s)), 'test', 10);
    expect(r.matches).toHaveLength(0);
    expect(r.reviewable!.map((m) => m.bill_id)).toEqual(['s441-118', 's4297-119', 's5619-119', 'hr1-119', 's4298-119']);
    expect(r.reviewable).toHaveLength(NEAR_MISS_REVIEW_LIMIT);
  });

  it('nothing under the review floor is offered', () => {
    const r = searchResultOf([action('a', 0.449), action('b', 0.3)], 'test', 10);
    expect(r.reviewable).toEqual([]);
  });

  it('the floor values', () => {
    expect(SIMILARITY.REVIEW).toBe(0.45);
    expect(SIMILARITY.REVIEW).toBeLessThan(SIMILARITY.WEAK);
  });
});

describe('the scorer weighs reviewed near misses only when told to', () => {
  const row = (score: number): ScorableMatch =>
    ({
      action_uid: `ACT-${score}`, bill_id: `s${Math.round(score * 1000)}-119`, title: 'A bill', summary: 'S.', intended_effects: 'E.',
      mechanisms: 'M.', action_type: 'voted', is_sponsor: false, is_cosponsor: false, vote: 'Yea',
      cloture_vote: 'NA', passage_vote: 'Yea', bill_keywords: [], primary_issue: 'x', sub_issue: 'y', source_url: '',
      score, strength: 'WEAK', missing_fields: [], bill_effect: 'ADVANCE', bill_effect_reasoning: 'r',
      alignment_confidence: 0.9,
    }) as ScorableMatch;
  const base = { promise_type: 'policy' as const, statement_type: 'Policy Position' as const };

  it('at the default floor, a 0.473 match is not evidence', () => {
    expect(scoreMatches({ ...base, matches: [row(0.473)] }).verdict).toBe('NOT_DETERMINABLE');
  });

  it('at the review floor, the same match is weighed — and only Low', () => {
    const s = scoreMatches({ ...base, matches: [row(0.473)], evidence_floor: SIMILARITY.REVIEW });
    expect(s.verdict).not.toBe('NOT_DETERMINABLE');
    expect(s.band).toBe('Low');
    expect(s.receipt.trace.join(' ')).toContain('near-miss review');
  });

  it('below the review floor, still nothing', () => {
    expect(scoreMatches({ ...base, matches: [row(0.44)], evidence_floor: SIMILARITY.REVIEW }).verdict).toBe('NOT_DETERMINABLE');
  });
});
