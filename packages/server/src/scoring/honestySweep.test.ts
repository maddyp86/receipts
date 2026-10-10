import { describe, expect, it } from 'vitest';
import {
  BAND_PHRASE,
  GOVERNING_VOTE_COPY,
  ND_REASON_COPY,
  VOTE_FLAG_COPY,
  TEXT_AT_ACTION_UNAVAILABLE,
  notDeterminableHeadline,
  type NotDeterminableReason,
} from '@receipts/shared';
import { scoreMatches, type ScorableMatch } from './score.js';
import { EXPLANATION_CONSTRAINTS } from '../orchestrator/prompts.js';
import { FOLLOWUP_SYSTEM_PROMPT } from '../followup/followup.js';

// ===========================================================================
// HONESTY SWEEP (beta readiness, item 1).
//
// One standard: never sound definite where the honest answer is "we don't
// know". Two known failures, then an audit of every reason, headline,
// walkthrough step and explainer instruction. Each test below pins one
// before/after row of the PR's table. The walkthrough's rows are in
// packages/web/src/components/howWeGotHere.test.ts.
// ===========================================================================

let uid = 0;
function row(over: Partial<ScorableMatch> = {}): ScorableMatch {
  uid += 1;
  return {
    action_uid: `ACT-${uid}`, bill_id: `s${uid}-119`, title: 'A bill', summary: 'S.', intended_effects: 'E.',
    mechanisms: 'M.', action_type: 'voted', is_sponsor: false, is_cosponsor: false, vote: 'Yea',
    cloture_vote: 'NA', passage_vote: 'Yea', bill_keywords: [], primary_issue: 'x', sub_issue: 'y', source_url: '',
    score: 0.7, strength: 'STRONG', missing_fields: [], bill_effect: 'ADVANCE', bill_effect_reasoning: 'r',
    alignment_confidence: 0.9,
    ...over,
  } as ScorableMatch;
}

const run = (matches: ScorableMatch[]) =>
  scoreMatches({ promise_type: 'policy', statement_type: 'Campaign Promise', matches });

describe('CONTESTED is not "no effect"', () => {
  it('a contested bill gets its own reason, not ALL_NEUTRAL', () => {
    const r = run([row({ bill_effect: 'CONTESTED' })]);
    expect(r.nd_reason).toBe('CONTESTED_READING');
    expect(ND_REASON_COPY.CONTESTED_READING).toMatch(/can reasonably be read either way/);
    expect(ND_REASON_COPY.CONTESTED_READING).not.toMatch(/don't move the goal/);
  });

  it('ALL_NEUTRAL still says what it says, as a reading', () => {
    expect(run([row({ bill_effect: 'NEUTRAL' })]).nd_reason).toBe('ALL_NEUTRAL');
    expect(ND_REASON_COPY.ALL_NEUTRAL).toMatch(/^As we read them,/);
  });
});

describe('headlines claim a thin record only when the record was thin', () => {
  it.each([
    ['ALL_NEUTRAL', "The record we found doesn't settle this"],
    ['ABSTAINED', "The record we found doesn't settle this"],
    ['WITHHELD_LOW_CONFIDENCE', "We can't make a reliable call on this"],
    ['WITHHELD_TEXT_UNAVAILABLE', "We can't make a reliable call on this"],
    ['NOT_EVALUABLE', 'This is too broad to check against specific bills'],
    ['NO_MATCHES', "We couldn't find enough to say"],
  ] as Array<[NotDeterminableReason, string]>)('%s → %s', (reason, h) => {
    expect(notDeterminableHeadline(reason)).toBe(h);
  });
});

describe('reader copy that stated a reading or a rule as fact', () => {
  it('Low is not "the evidence is thin": it also covers an incomplete check', () => {
    expect(BAND_PHRASE.Low).toBe('low confidence');
    expect(Object.values(BAND_PHRASE).join(' ')).not.toMatch(/thin/);
  });

  // TEXT_UNAVAILABLE means the slot's row was unusable, not that the bill was
  // rewritten.
  it('text unavailable does not claim the bill was rewritten', () => {
    expect(VOTE_FLAG_COPY[TEXT_AT_ACTION_UNAVAILABLE]).not.toMatch(/rewritten/);
    expect(ND_REASON_COPY.WITHHELD_TEXT_UNAVAILABLE).not.toMatch(/rewritten/);
    expect(ND_REASON_COPY.WITHHELD_TEXT_UNAVAILABLE).toMatch(/may say something different/);
  });

  it('a search that found nothing is not proof of nothing', () => {
    expect(ND_REASON_COPY.NO_MATCHES).toMatch(/isn't proof there are none/);
  });

  it('cloture governs by our rule, not by a law of nature', () => {
    expect(GOVERNING_VOTE_COPY['CLOTURE (60-vote threshold; split vote)']).toMatch(/We count .* usually/);
  });

  // "promise" is the wrong word for a Policy Position, and these sentences are
  // shown for both.
  it('reason copy does not call every statement a promise', () => {
    for (const copy of Object.values(ND_REASON_COPY)) expect(copy).not.toMatch(/\bpromise\b/);
  });
});

describe('the model is told a reading is a reading', () => {
  it('explainer: effects are readings; CONTESTED and ERROR named; Low said', () => {
    expect(EXPLANATION_CONSTRAINTS).toMatch(/NEVER sound more certain than the result/);
    expect(EXPLANATION_CONSTRAINTS).toMatch(/CONTESTED means the bill can reasonably be read either way/);
    expect(EXPLANATION_CONSTRAINTS).toMatch(/ERROR means the bill could not be read/);
    expect(EXPLANATION_CONSTRAINTS).toMatch(/When the band is Low, say plainly/);
    expect(EXPLANATION_CONSTRAINTS).not.toMatch(/turned out to be about a different thing/);
  });

  it('follow-up: same', () => {
    expect(FOLLOWUP_SYSTEM_PROMPT).toMatch(/Say a reading as a reading/);
    expect(FOLLOWUP_SYSTEM_PROMPT).toMatch(/CONTESTED was read both ways, not as having no effect/);
  });
});
