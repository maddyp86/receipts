import { describe, expect, it } from 'vitest';
import {
  BANNED_LEVEL1_TERMS,
  BANNED_MOTIVE_TERMS,
  GOVERNING_VOTE_COPY,
  JUDGE_DISPOSITION_COPY,
  VOTE_FLAG_COPY,
  confidenceTraceLabel,
  governingVoteSentence,
  judgeDispositionSentence,
} from '@receipts/shared';
import { deriveAlignment } from './deriveAlignment.js';
import { scoreMatches, type ScorableMatch } from './score.js';

// ===========================================================================
// Behavioural contract 2, the half that was missing.
//
//   "Split vote -> confidence <= 0.75, both votes named, governing_vote stated."
//
// The card already named both votes. It never said which one GOVERNED, which is
// the half the verdict actually turns on: handoff v2 §4 calls a row reading
// "voted NAY -> BROKE" beside an unmentioned cloture YEA "exactly the claim a
// senator's office knocks down".
// ===========================================================================

let uid = 0;
const match = (over: Partial<ScorableMatch> = {}): ScorableMatch => {
  uid += 1;
  return {
    action_uid: `ACT-${uid}`,
    bill_id: `bill-${uid}`,
    title: 'A Bill',
    summary: '',
    intended_effects: '',
    mechanisms: '',
    action_type: 'voted',
    is_sponsor: false,
    is_cosponsor: false,
    vote: 'NA',
    cloture_vote: 'NA',
    passage_vote: 'NA',
    bill_keywords: [],
    primary_issue: 'Health Care',
    sub_issue: 'Prescription Drugs',
    source_url: '',
    score: 0.8,
    strength: 'STRONG',
    missing_fields: [],
    bill_effect: 'ADVANCE',
    bill_effect_reasoning: '',
    ...over,
  } as ScorableMatch;
};

const run = (matches: ScorableMatch[]) =>
  scoreMatches({ promise_type: 'policy', statement_type: 'Campaign Promise', matches });

describe('every governing-vote value the table can produce has reader copy', () => {
  it('covers the split-vote string — the one the contract exists for', () => {
    const derived = deriveAlignment(
      { bill_effect: 'ADVANCE', cloture_vote: 'YEA', passage_vote: 'NAY' },
      'Campaign Promise',
    );
    expect(derived.split).toBe(true);
    // If deriveAlignment's wording ever changes, this fails rather than
    // silently rendering nothing on exactly the rows that need disclosure most.
    expect(governingVoteSentence(derived.governing)).toBeTruthy();
  });

  it('covers each governing value a real vote combination reaches', () => {
    const combos: Array<Partial<ScorableMatch>> = [
      { cloture_vote: 'YEA', passage_vote: 'NAY' }, // split
      { cloture_vote: 'YEA', passage_vote: 'YEA' }, // agree
      { cloture_vote: 'YEA' }, // cloture only
      { passage_vote: 'YEA' }, // passage only
      { vote: 'YEA' }, // untyped
      { is_cosponsor: true }, // sponsorship
    ];

    for (const combo of combos) {
      const derived = deriveAlignment({ bill_effect: 'ADVANCE', ...combo }, 'Campaign Promise');
      expect(
        governingVoteSentence(derived.governing),
        `no reader copy for governing value "${derived.governing}"`,
      ).toBeTruthy();
    }
  });

  it('renders nothing rather than jargon for an unknown value', () => {
    // Showing a raw analyst string to a voter is worse than showing one less
    // line — the votes themselves are already named on the card.
    expect(governingVoteSentence('SOMETHING_NEW')).toBeNull();
    expect(governingVoteSentence('NO_ACTION')).toBeNull();
    expect(governingVoteSentence('NA')).toBeNull();
    expect(governingVoteSentence('')).toBeNull();
    expect(governingVoteSentence(null)).toBeNull();
  });
});

describe('the disclosure copy obeys the Level-1 rules', () => {
  const level1Copy = [...Object.values(GOVERNING_VOTE_COPY), ...Object.values(VOTE_FLAG_COPY)];

  it('carries no statistics vocabulary', () => {
    // The raw value 'CLOTURE (60-vote threshold; split vote)' contains
    // "threshold", which is why the plain-language layer exists at all. If the
    // copy ever reintroduced it the layer would be pointless.
    for (const copy of level1Copy) {
      for (const term of BANNED_LEVEL1_TERMS) {
        expect(copy.toLowerCase(), `"${term}" in Level-1 copy`).not.toContain(term.toLowerCase());
      }
    }
  });

  it('attributes no motive', () => {
    // Especially load-bearing for FLOOR_LEADER: the honest disclosure is what
    // the ROLE involves, never what this senator was trying to achieve.
    for (const copy of level1Copy) {
      for (const term of BANNED_MOTIVE_TERMS) {
        expect(copy.toLowerCase(), `"${term}" in Level-1 copy`).not.toContain(term.toLowerCase());
      }
    }
  });
});

describe('disclosure flags established upstream survive scoring', () => {
  it('keeps FLOOR_LEADER, which the scorer cannot derive for itself', () => {
    // The gates hold the reference data — the senator's role at that Congress —
    // so FLOOR_LEADER can only originate there. It was being computed and then
    // dropped, leaving §4's flag set half-implemented on scored rows.
    const r = run([match({ passage_vote: 'YEA', vote_flags: ['FLOOR_LEADER'] })]);
    expect(r.evidence[0]!.vote_flags).toContain('FLOOR_LEADER');
  });

  it('still derives SPLIT_VOTE itself when the gates did not supply it', () => {
    const r = run([match({ cloture_vote: 'YEA', passage_vote: 'NAY' })]);
    expect(r.evidence[0]!.vote_flags).toContain('SPLIT_VOTE');
  });

  it('does not list SPLIT_VOTE twice when both sides flag it', () => {
    const r = run([
      match({ cloture_vote: 'YEA', passage_vote: 'NAY', vote_flags: ['SPLIT_VOTE'] }),
    ]);
    expect(r.evidence[0]!.vote_flags.filter((f) => f === 'SPLIT_VOTE')).toHaveLength(1);
  });

  it('does not let a disclosure flag change the verdict or the weight', () => {
    // vote_flags is a disclosure channel. If it could move a verdict it would be
    // scoring, and the scorer's inputs would no longer be just the evidence.
    const plain = run([match({ passage_vote: 'YEA' })]);
    const flagged = run([match({ passage_vote: 'YEA', vote_flags: ['FLOOR_LEADER'] })]);
    expect(flagged.verdict).toBe(plain.verdict);
    expect(flagged.band).toBe(plain.band);
    expect(flagged.evidence[0]!.weight).toBe(plain.evidence[0]!.weight);
  });
});

describe('the judge disposition copy', () => {
  const dispositions = [
    'PASS',
    'PASS_ON_RETRY',
    'REVIEW_REQUIRED',
    'REVIEW_REQUIRED_JUDGE_CORRECTED',
    'JUDGE_ERROR',
  ];

  it('covers every disposition the layer can produce', () => {
    for (const d of dispositions) {
      expect(judgeDispositionSentence(d), `no copy for ${d}`).toBeTruthy();
    }
    // GATED_* carries its failure class in the suffix and is matched by prefix.
    expect(judgeDispositionSentence('GATED_BROAD_VEHICLE')).toBeTruthy();
    expect(judgeDispositionSentence('SOMETHING_NEW')).toBeNull();
    expect(judgeDispositionSentence(null)).toBeNull();
  });

  it('never exonerates', () => {
    // Withholding an accusation is not a finding that the senator kept
    // anything, and a review that could not run is not a review that cleared
    // him. Same posture as WITHHELD_LOW_CONFIDENCE.
    for (const copy of Object.values(JUDGE_DISPOSITION_COPY)) {
      expect(copy.toLowerCase()).not.toMatch(/\bkept (it|the promise)\b|cleared him|no wrongdoing|in the clear/);
    }
  });

  it('does not claim a review happened when none did', () => {
    // The whole reason this copy exists: the generic WITHHELD_PENDING_REVIEW
    // sentence says "a second review didn't back this reading", which is false
    // on the JUDGE_ERROR path — no credential, or no usable model output.
    const judgeError = JUDGE_DISPOSITION_COPY.JUDGE_ERROR!;
    expect(judgeError).toMatch(/could not run/i);
    expect(judgeError.toLowerCase()).not.toMatch(/review (did not|didn.t) (back|sustain)/);
  });

  it('says a review DID happen where one did', () => {
    expect(JUDGE_DISPOSITION_COPY.REVIEW_REQUIRED!.toLowerCase()).toMatch(/did not sustain/);
    expect(JUDGE_DISPOSITION_COPY.PASS!.toLowerCase()).toMatch(/did not overturn/);
  });

  it('carries no statistics vocabulary and attributes no motive', () => {
    for (const copy of Object.values(JUDGE_DISPOSITION_COPY)) {
      for (const term of [...BANNED_LEVEL1_TERMS, ...BANNED_MOTIVE_TERMS]) {
        expect(copy.toLowerCase(), `"${term}" in judge copy`).not.toContain(term.toLowerCase());
      }
    }
  });
});

describe('the analyst trace writes absence in words, never as a number', () => {
  it('never prints 0 for a confidence nobody recorded', () => {
    // Handoff v2 §3: absence must not be replaced by a value from the column's
    // own vocabulary. A "0" here reads as "we looked and found no confidence at
    // all" — a finding nobody made.
    expect(confidenceTraceLabel(null)).not.toBe('0');
    expect(confidenceTraceLabel(undefined)).not.toBe('0');
    expect(confidenceTraceLabel(null)).toBe('not recorded');
  });

  it('prints a REAL zero as zero', () => {
    // The mirror of the rule. 0 is a value, and hiding it behind "not recorded"
    // would lose a finding in the other direction.
    expect(confidenceTraceLabel(0)).toBe('0');
  });

  it('passes a normal confidence through unchanged', () => {
    expect(confidenceTraceLabel(0.65)).toBe('0.65');
    // The split-vote cap is applied upstream, so what reaches the trace is what
    // contract 3's floor was actually measured against.
    expect(confidenceTraceLabel(0.75)).toBe('0.75');
  });

  it('does not treat NaN as a measurement', () => {
    expect(confidenceTraceLabel(Number.NaN)).toBe('not recorded');
  });
});
