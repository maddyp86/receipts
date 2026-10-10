import { describe, expect, it } from 'vitest';
import { ND_HEADLINE, ND_REASON_COPY, STRENGTH_PHRASE } from '@receipts/shared';
import { dispatchTool, newSession } from '../orchestrator/dispatch.js';
import { strengthOf } from '../data/PineconeActionStore.js';
import { SIMILARITY } from '../scoring/config.js';
import { scoreMatches, type ScorableMatch } from '../scoring/score.js';
import { CLASSIFY_SYSTEM_PROMPT } from './classify.js';

// ===========================================================================
// The fixes from the accuracy set's first review (2026-10-10):
//   1. the evidence floor at 0.50, with the card's wording line kept at 0.575
//   2. the classifier classifies the thing, not the speaker's name for it
//   3. "too broad", not "we couldn't tell what to check"; and an is_evaluable
//      override is logged with the other disagreements
// ===========================================================================

const row = (score: number): ScorableMatch =>
  ({
    action_uid: `ACT-${score}`, bill_id: `s${Math.round(score * 1000)}-119`, title: 'A bill', summary: 'S.', intended_effects: 'E.',
    mechanisms: 'M.', action_type: 'voted', is_sponsor: false, is_cosponsor: false, vote: 'Yea',
    cloture_vote: 'NA', passage_vote: 'Yea', bill_keywords: [], primary_issue: 'x', sub_issue: 'y', source_url: '',
    score, strength: strengthOf(score), missing_fields: [], bill_effect: 'ADVANCE', bill_effect_reasoning: 'r',
    alignment_confidence: 0.9,
  }) as ScorableMatch;

describe('1. the evidence floor', () => {
  it('is 0.50, the retrieval floor', () => {
    expect(SIMILARITY.STRONG).toBe(0.5);
    expect(SIMILARITY.STRONG).toBe(SIMILARITY.WEAK);
  });

  it('a relevant match at 0.51 now counts', () => {
    const r = scoreMatches({ promise_type: 'policy', statement_type: 'Policy Position', matches: [row(0.51)] });
    expect(r.verdict).toBe('KEPT');
    expect(r.evidence).toHaveLength(1);
  });

  it('the band bar is unchanged: 0.51 matches never make High', () => {
    const r = scoreMatches({ promise_type: 'policy', statement_type: 'Policy Position', matches: [row(0.51), row(0.52), row(0.53)] });
    expect(r.band).not.toBe('High');
  });

  // The label shares nothing with the floor any more. At the floor, everything
  // admitted would otherwise read "closely related".
  it('the card still says "loosely related" below 0.575 and "closely related" from it', () => {
    expect(SIMILARITY.CLOSE).toBe(0.575);
    expect(STRENGTH_PHRASE[strengthOf(0.501)]).toBe('loosely related');
    expect(STRENGTH_PHRASE[strengthOf(0.574)]).toBe('loosely related');
    expect(STRENGTH_PHRASE[strengthOf(0.575)]).toBe('closely related');
    expect(STRENGTH_PHRASE[strengthOf(0.7)]).toBe('closely related');
  });
});

describe('2. the classifier classifies the thing itself', () => {
  it('has the rule, with tariffs as its example, and no keyword list', () => {
    expect(CLASSIFY_SYSTEM_PROMPT).toMatch(/Classify by the policy, program or instrument the statement is about, not by how the speaker characterises it\./);
    expect(CLASSIFY_SYSTEM_PROMPT).toMatch(/tariffs are Trade even when the speaker calls them "a tax"/);
    expect(CLASSIFY_SYSTEM_PROMPT).not.toMatch(/international trade, imports, exports/);
  });
});

describe('3. too broad', () => {
  it('says the statement is too broad and asks for a specific policy', () => {
    expect(ND_HEADLINE.NOT_EVALUABLE).toBe('This is too broad to check against specific bills');
    expect(ND_REASON_COPY.NOT_EVALUABLE).toMatch(/^This statement is too broad to hold against specific bills\. Try naming a specific policy/);
    for (const s of [ND_HEADLINE.NOT_EVALUABLE!, ND_REASON_COPY.NOT_EVALUABLE]) expect(s).not.toMatch(/couldn't tell what/);
  });

  const classify = async (orchestrator: Record<string, unknown>, classifier: Record<string, unknown>) => {
    const session = newSession('S000148', 'I will protect clean air.');
    session.classifyFetcher = async () => structuredClone(classifier);
    const env = await dispatchTool(session, 'interpret_promise', orchestrator);
    expect(env.ok).toBe(true);
    return session;
  };
  const pair = { primary_issue: 'Environment', sub_issue: 'Pollution & Clean Air/Water', stance: 'In Favor', promise_type: 'policy', restated: 'x', key_policy_terms: ['clean air'], reasoning: 'r' };

  it('an is_evaluable override is logged with the other disagreements, and the classifier still wins', async () => {
    const s = await classify({ ...pair, is_evaluable: true }, { ...pair, is_evaluable: false });
    expect(s.classifyDisagreements).toContain('is_evaluable: orchestrator said true, classifier said false (classifier wins)');
    expect(s.interpretation!.is_evaluable).toBe(false);
  });

  it('agreement, or a side that said nothing, is not a disagreement', async () => {
    expect((await classify({ ...pair, is_evaluable: true }, { ...pair, is_evaluable: true })).classifyDisagreements).toEqual([]);
    expect((await classify({ ...pair }, { ...pair, is_evaluable: false })).classifyDisagreements).toEqual([]);
  });
});
