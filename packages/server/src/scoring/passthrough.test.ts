import { describe, expect, it } from 'vitest';
import { congressLabel, congressOfBillId, congressYears } from '@receipts/shared';
import { scoreMatches, type ScorableMatch } from './score.js';

// ===========================================================================
// The evidence card's identity and date fields.
//
// The card renders bill id, Congress, policy area, mechanisms, stakeholders
// and a date. All but the date were already on the row and simply not
// rendered; the date is new and comes through the scorer untouched. The
// scorer spreads its input, so a field it does not know about survives — but
// that is an accident of the spread, and this pins it as a contract.
// ===========================================================================

const match = (over: Partial<ScorableMatch> = {}): ScorableMatch => ({
  action_uid: 'ACT-1',
  bill_id: 's494-118',
  title: 'A bill to require a background check for every firearm sale.',
  summary: 'Summary.',
  intended_effects: 'Effects.',
  mechanisms: 'Expands NICS to every sale.',
  affected_stakeholders: 'Firearm buyers; sellers; law enforcement.',
  action_type: 'sponsored',
  is_sponsor: false,
  is_cosponsor: true,
  vote: 'NA',
  cloture_vote: 'NA',
  passage_vote: 'NA',
  bill_keywords: [],
  primary_issue: 'Crime & Public Safety',
  sub_issue: 'Guns / Gun Control',
  source_url: '',
  score: 0.62,
  strength: 'STRONG',
  missing_fields: [],
  bill_effect: 'ADVANCE',
  bill_effect_reasoning: 'Advances it.',
  ...over,
});

describe('the dates reach the evidence row', () => {
  it('carries action_date and the roll-call dates through the scorer', () => {
    const r = scoreMatches({
      promise_type: 'policy',
      statement_type: 'Policy Position',
      matches: [
        match({
          action_date: '2023-01-03',
          cloture_vote_date: null,
          passage_vote_date: '2023-06-14',
          vote_flags: ['ACTION_DATE_PROXY'],
        }),
      ],
    });
    const [e] = r.evidence;
    expect(e!.action_date).toBe('2023-01-03');
    expect(e!.passage_vote_date).toBe('2023-06-14');
    expect(e!.cloture_vote_date).toBeNull();
    // The stand-in flag travels with the date it qualifies.
    expect(e!.vote_flags).toContain('ACTION_DATE_PROXY');
  });

  it('keeps mechanisms, stakeholders and the policy area on the row', () => {
    const r = scoreMatches({ promise_type: 'policy', statement_type: 'Policy Position', matches: [match()] });
    const [e] = r.evidence;
    expect(e!.mechanisms).toBe('Expands NICS to every sale.');
    expect(e!.affected_stakeholders).toMatch(/law enforcement/);
    expect(e!.primary_issue).toBe('Crime & Public Safety');
    expect(e!.sub_issue).toBe('Guns / Gun Control');
  });
});

describe('the Congress is read from the bill id', () => {
  it('parses the three-digit suffix and nothing else', () => {
    expect(congressOfBillId('s494-118')).toBe(118);
    expect(congressOfBillId('hjres88-119')).toBe(119);
    expect(congressOfBillId('s494')).toBeNull();
    expect(congressOfBillId('')).toBeNull();
    expect(congressOfBillId(undefined)).toBeNull();
  });

  it('labels a Congress with the years it sat', () => {
    // The nth Congress convenes in January of 1789 + 2(n − 1).
    expect(congressYears(118)).toBe('2023–2024');
    expect(congressYears(119)).toBe('2025–2026');
    expect(congressYears(117)).toBe('2021–2022');
    expect(congressLabel(118)).toBe('118th Congress (2023–2024)');
  });
});
