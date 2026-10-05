import { describe, expect, it } from 'vitest';
import { BANNED_MOTIVE_TERMS, type TextVersionDisclosure } from '@receipts/shared';
import {
  afterIntroduction,
  billLabel,
  committeeActs,
  longDate,
  measureNoun,
  recordSentence,
  type RecordInput,
} from './recordSentence.js';
import type { BillEnrichment, SponsorshipEnrichment } from '../evaluation/enrichment.js';
import { scoreMatches, type ScorableMatch } from './score.js';

// ===========================================================================
// THE RECORD SENTENCE. Every clause citable; the record, never motive.
// ===========================================================================

const late: SponsorshipEnrichment = {
  sponsor_tier: 'LATE_COSPONSOR',
  cosponsored_at: '2023-06-12',
  original_cosponsor: false,
  cosponsor_ordinal: 34,
  cosponsor_total: 41,
  days_after_introduction: 92,
  withdrawn_at: null,
  committee_member: 'true',
  committee_member_of: ['SSCM'],
};

const diedInCommerce: BillEnrichment = {
  progress_stage: 'REFERRED',
  progress_outcome: 'DIED_AT_REFERRED',
  progress_stage_at: '2023-03-13',
  committee_activity: 'SSCM: Referred To',
  referred_committees: ['SSCM'],
  cosponsor_count: 41,
  enacted_via: 'NA',
};

const input = (over: Partial<RecordInput> = {}): RecordInput => ({
  bill_id: 's900-118',
  is_cosponsor: true,
  sponsorship: late,
  bill: diedInCommerce,
  ...over,
});

describe('the brief\'s example', () => {
  // "Co-sponsored as the 34th of 41, three months after introduction.
  //  Referred to Commerce, where he sits; no hearing before the 118th Congress
  //  ended." — the same facts, no pronoun, the committee's real name.
  it('reads as the record, clause by clause', () => {
    expect(recordSentence(input())!.sentence).toBe(
      'Co-sponsored the bill as the 34th of 41 co-sponsors, about 3 months after introduction (June 12, 2023). ' +
        'Referred to the Senate Committee on Commerce, Science, and Transportation, where the senator sits; ' +
        'no committee action after referral is recorded. ' +
        'It did not advance past committee before the 118th Congress ended.',
    );
  });
});

describe('sponsorship', () => {
  it('a sponsor: the introduction date, never the tier', () => {
    const r = recordSentence(
      input({
        is_sponsor: true,
        is_cosponsor: false,
        sponsorship: { sponsor_tier: 'SPONSOR_ADVANCED', cosponsored_at: '2025-02-03', days_after_introduction: 0 },
        bill: {
          progress_stage: 'IN_COMMITTEE',
          progress_outcome: 'ACTIVE',
          committee_activity: 'SSFI: Referred To, Hearings By (full committee), Markup By, Reported By',
          referred_committees: ['SSFI'],
        },
        bill_id: 's12-119',
      }),
    )!;
    expect(r.sentence).toBe(
      'Sponsored the bill, introducing it on February 3, 2025. ' +
        'Referred to the Senate Committee on Finance; the committee held a hearing, marked it up and reported it. ' +
        'It has not reached the floor.',
    );
    // SPONSOR_ADVANCED is a fact about the bill. The sentence says what the
    // committee did and nothing about who made it happen.
    expect(r.sentence).not.toMatch(/advanced|pushed|led\b/i);
  });

  it('an original co-sponsor', () => {
    const r = recordSentence(
      input({
        sponsorship: { sponsor_tier: 'ORIGINAL_COSPONSOR', cosponsored_at: '2025-01-27', original_cosponsor: true, cosponsor_total: 16 },
        bill: null,
      }),
    )!;
    expect(r.sentence).toBe('Co-sponsored the bill from its introduction on January 27, 2025, one of 16 co-sponsors.');
  });

  // Zero live examples (Withdrawn At is NA on every row, 2026-10-02), so
  // synthetic. Disclosed, never scored.
  it('a withdrawn name: the date, and nothing else', () => {
    const r = recordSentence(input({ sponsorship: { ...late, withdrawn_at: '2023-08-02' }, bill: null }))!;
    expect(r.sentence).toContain('Withdrew as a co-sponsor on August 2, 2023.');
    expect(r.sentence).not.toMatch(/regret|reconsider|changed (his|her|their) mind|backed away/i);
  });

  it('a tier that contradicts the flag is ignored, as in effortSignals', () => {
    const r = recordSentence(input({ is_cosponsor: false, is_sponsor: true, sponsorship: { ...late, cosponsored_at: '2023-03-13' }, bill: null }))!;
    expect(r.sentence).toBe('Sponsored the bill, introducing it on March 13, 2023.');
  });
});

describe('committee membership — said only when TRUE', () => {
  it.each(['false', 'NA_PRIOR_CONGRESS', 'UNAVAILABLE', 'NO_COMMITTEE', null])('says nothing about membership when it is %s', (marker) => {
    const r = recordSentence(input({ sponsorship: { ...late, committee_member: marker } }))!;
    expect(r.sentence).not.toMatch(/sits|member|serves/i);
  });

  // Committee Member Of is the overlap the pipeline computed; a code outside
  // the bill's referrals is not something the bill went through.
  it('names only the committees the bill was referred to', () => {
    const r = recordSentence(
      input({
        sponsorship: { ...late, committee_member_of: ['SSFI'] },
        bill: { ...diedInCommerce, referred_committees: ['SSCM'] },
      }),
    )!;
    expect(r.sentence).not.toMatch(/sits/);
  });

  it('with two committees, says which one', () => {
    const r = recordSentence(
      input({
        sponsorship: { ...late, committee_member_of: ['SSFI'] },
        bill: { ...diedInCommerce, referred_committees: ['SSCM', 'SSFI'], committee_activity: 'SSCM: Referred To | SSFI: Referred To' },
      }),
    )!;
    expect(r.sentence).toContain(
      'Referred to the Senate Committee on Commerce, Science, and Transportation and the Senate Committee on Finance; ' +
        'the senator sits on the Senate Committee on Finance',
    );
  });
});

describe('what became of the bill', () => {
  // Every outcome on the live Bills Master (2026-10-02).
  it.each([
    ['ENACTED', 'ENACTED', 'It became law on March 13, 2023.'],
    ['VETOED', 'VETOED', 'It was vetoed on March 13, 2023.'],
    ['FAILED', 'FLOOR', 'It failed in a floor vote.'],
    ['PROV_KILL', 'FLOOR', 'A procedural vote to advance it failed, which does not end the bill.'],
    ['AGREED_TO', 'PASSED_CHAMBER', 'It was agreed to.'],
    ['DIED_AT_REFERRED', 'REFERRED', 'It did not advance past committee before the 118th Congress ended.'],
    ['DIED_AT_IN_COMMITTEE', 'IN_COMMITTEE', 'It did not reach the floor before the 118th Congress ended.'],
    ['DIED_AT_ON_CALENDAR', 'ON_CALENDAR', 'It was on the calendar without a floor vote when the 118th Congress ended.'],
    ['DIED_AT_FLOOR', 'FLOOR', 'It reached the floor but did not pass before the 118th Congress ended.'],
    ['DIED_AT_PASSED_CHAMBER', 'PASSED_CHAMBER', 'It passed one chamber but not the other before the 118th Congress ended.'],
    ['DIED_AT_PASSED_BOTH', 'PASSED_BOTH', 'It passed both chambers but did not become law before the 118th Congress ended.'],
    ['ACTIVE', 'REFERRED', 'It has not advanced past committee.'],
    ['ACTIVE', 'ON_CALENDAR', 'It was placed on the calendar and has not had a floor vote.'],
    ['ACTIVE', 'PASSED_CHAMBER', 'It has passed one chamber.'],
  ])('%s at %s', (outcome, stage, expected) => {
    const r = recordSentence({
      bill_id: 's900-118',
      passage_vote: 'Yea',
      bill: { progress_outcome: outcome, progress_stage: stage, progress_stage_at: '2023-03-13' },
    } as RecordInput)!;
    expect(r.sentence).toBe(expected);
  });

  // The legitimate shell-bill pattern: the bill died, its text became law in
  // another. Zero live examples (Enacted Via is SELF on all 67 enacted bills),
  // so synthetic.
  it('says when the text became law under another number', () => {
    const r = recordSentence(input({ bill: { ...diedInCommerce, enacted_via: 'hr2617-117' } }))!;
    expect(r.sentence).toMatch(/It did not advance past committee before the 118th Congress ended\. Its text became law as part of H\.R\. 2617 of the 117th Congress\.$/);
  });

  it('lists several enacting bills', () => {
    const r = recordSentence(input({ bill: { ...diedInCommerce, enacted_via: 's1-118; hr5-118' } }))!;
    expect(r.sentence).toContain('Its text became law as part of S. 1 and H.R. 5.');
  });

  it('a vote gets the outcome only — no committee path', () => {
    const r = recordSentence({ bill_id: 's900-118', is_cosponsor: false, sponsorship: late, bill: diedInCommerce })!;
    expect(r.sentence).toBe('It did not advance past committee before the 118th Congress ended.');
  });
});

describe('a bill rewritten under the same number', () => {
  const rewritten: TextVersionDisclosure = {
    status: 'SELECTED', governed_by: 'SPONSORSHIP', action_date: '2025-03-20', dated_by: 'SPONSORSHIP', dating_reason: null, code: 'is', type: 'Introduced in Senate',
    date: '2025-03-14', title: 'To require the Secretary of Veterans Affairs to disinter …', title_source: 'TEXT',
    flagged_for_review: false,
    latest: { code: 'enr', type: 'Enrolled Bill', date: null, title: 'To authorize appropriations for fiscal year 2026 …', title_source: 'TEXT' },
    rewritten: true, taxonomy_divergent: true, taxonomy_divergence_detail: null, version_count: 4,
  };
  const s1071 = (over: Partial<RecordInput> = {}) =>
    recordSentence({
      bill_id: 's1071-119',
      is_cosponsor: true,
      sponsorship: { sponsor_tier: 'ORIGINAL_COSPONSOR', cosponsored_at: '2025-03-14', original_cosponsor: true, cosponsor_total: 1 },
      bill: {
        progress_stage: 'ENACTED', progress_outcome: 'ENACTED', progress_stage_at: '2025-12-18',
        committee_activity: 'HSAS: Unknown, Unknown | SSVA: Discharged From, Referred To', referred_committees: ['HSAS', 'SSVA'],
        enacted_via: 'SELF',
      },
      text_version: rewritten,
      ...over,
    })!;

  // The VA disinterment bill did not become law; the NDAA that replaced its
  // text did. "It became law" alone would be false about what was signed.
  it('attributes the outcome to the rewritten bill', () => {
    expect(s1071().sentence).toContain('The bill was later rewritten under the same number. As rewritten, it became law on December 18, 2025.');
    expect(s1071().sentence).not.toMatch(/^.*\bIt became law/);
  });

  // "Referred to House Armed Services" belongs to the NDAA, not to the VA bill
  // a March co-sponsor signed. Bills Master cannot say which, so: nothing.
  it('omits the committee path, which cannot be attributed to a version', () => {
    expect(s1071().sentence).not.toMatch(/Referred|committee/i);
  });

  it('says nothing about rewriting when the text was not rewritten', () => {
    const r = s1071({ text_version: { ...rewritten, rewritten: false } });
    expect(r.sentence).not.toMatch(/rewritten/);
    expect(r.sentence).toMatch(/It became law on December 18, 2025\./);
  });
});

describe('absence', () => {
  it('nothing on record → no sentence, and the card shows what it did before', () => {
    expect(recordSentence({ bill_id: 's1-119', is_cosponsor: true })).toBeNull();
    expect(recordSentence({ bill_id: 's1-119', passage_vote: 'Yea', bill: {} } as RecordInput)).toBeNull();
  });

  it('an unknown committee code is not named', () => {
    const r = recordSentence(input({ bill: { ...diedInCommerce, referred_committees: ['ZZZZ'] }, sponsorship: { ...late, committee_member_of: [] } }))!;
    expect(r.sentence).toContain('Referred to committee;');
  });
});

// ---------------------------------------------------------------------------
// The rules, swept across every live value of every field that varies.
// ---------------------------------------------------------------------------

const KNOWN_SOURCES = new Set([
  'Is Sponsor', 'Is Co-Sponsor', 'Sponsor Tier', 'Cosponsored At', 'Cosponsor Ordinal', 'Cosponsor Total',
  'Days After Introduction', 'Withdrawn At', 'Committee Member', 'Committee Member Of', 'Referred Committees',
  'Committee Activity', 'Progress Outcome', 'Progress Stage', 'Progress Stage At', 'Enacted Via', 'Title',
  'Version Title Source',
]);

function* matrix(): Generator<RecordInput> {
  const tiers = ['SPONSOR_ADVANCED', 'SPONSOR_STALLED', 'ORIGINAL_COSPONSOR', 'LATE_COSPONSOR', 'UNRESOLVED', null];
  const members = ['true', 'false', 'NO_COMMITTEE', 'NA_PRIOR_CONGRESS', 'UNAVAILABLE', null];
  const outcomes = ['ACTIVE', 'ENACTED', 'VETOED', 'FAILED', 'PROV_KILL', 'AGREED_TO', 'DIED_AT_REFERRED', 'DIED_AT_FLOOR', null];
  for (const tier of tiers) for (const m of members) for (const o of outcomes) for (const who of ['sponsor', 'cosponsor', 'vote']) {
    yield {
      bill_id: 's77-118',
      is_sponsor: who === 'sponsor',
      is_cosponsor: who === 'cosponsor',
      sponsorship: { ...late, sponsor_tier: tier, committee_member: m, withdrawn_at: tier === 'LATE_COSPONSOR' ? '2023-09-01' : null },
      bill: { ...diedInCommerce, progress_outcome: o, committee_activity: 'SSCM: Referred To, reporting, markup' },
    };
  }
}

describe('every sentence the builder can produce', () => {
  const all = [...matrix()].map((i) => recordSentence(i)).filter((r): r is NonNullable<typeof r> => r !== null);

  it('covers the matrix', () => {
    expect(all.length).toBeGreaterThan(500);
  });

  it('is citable: every clause names the columns it came from', () => {
    for (const r of all) {
      for (const c of r.clauses) {
        expect(c.sources.length).toBeGreaterThan(0);
        for (const src of c.sources) expect(KNOWN_SOURCES.has(src), `unknown source ${src}`).toBe(true);
      }
    }
  });

  it('uses no pronoun for the senator', () => {
    for (const r of all) expect(r.sentence).not.toMatch(/\b(he|she|his|her|him|hers)\b/i);
  });

  it('never names the sponsorship tier', () => {
    for (const r of all) expect(r.sentence).not.toMatch(/SPONSOR_|COSPONSOR|_VOTE_ONLY|UNRESOLVED|NA_PRIOR|NO_COMMITTEE|UNAVAILABLE/);
  });

  it('claims no effort or motive the record cannot show', () => {
    const effort = /push|fought|fight|champion|abandon|gave up|drove|spearhead|worked (to|for)|tried|refused|killed/i;
    for (const r of all) {
      expect(r.sentence).not.toMatch(effort);
      for (const term of BANNED_MOTIVE_TERMS) expect(r.sentence.toLowerCase()).not.toContain(term);
    }
  });
});

describe('helpers', () => {
  it.each([
    [0, 'on the day it was introduced'],
    [1, '1 day after introduction'],
    [45, '45 days after introduction'],
    [92, 'about 3 months after introduction'],
    [659, 'about 22 months after introduction'],
    [800, 'about 2 years after introduction'],
  ])('afterIntroduction(%i)', (d, s) => expect(afterIntroduction(d)).toBe(s));

  it('reads both committee-activity vocabularies', () => {
    expect([...committeeActs('SSCM: Referred To, Hearings By (subcommittee), Reported By')].sort()).toEqual(['hearing', 'report']);
    expect([...committeeActs('SSCM: referral, markup, reporting')].sort()).toEqual(['markup', 'report']);
    expect([...committeeActs('SSCM: Referred To, Unknown | HSAS: Bills of Interest - Exchange of Letters')]).toEqual([]);
    expect([...committeeActs('SSVA: Discharged From, Referred To')]).toEqual(['discharged']);
  });

  it('labels bills', () => {
    expect(billLabel('hr2617-117', 's900-118')).toBe('H.R. 2617 of the 117th Congress');
    expect(billLabel('sjres7-119', 'hr1-119')).toBe('S.J.Res. 7');
  });

  it('dates without drifting a day across time zones', () => {
    expect(longDate('2025-01-01')).toBe('January 1, 2025');
    expect(longDate('NA')).toBeNull();
  });
});

describe('no numeric score moves', () => {
  it('the same row with and without its record sentence scores identically', () => {
    const m: ScorableMatch = {
      action_uid: 'A', bill_id: 's900-118', title: 'A bill', summary: 'S.', intended_effects: 'E.', mechanisms: 'M.',
      action_type: 'cosponsored', is_sponsor: false, is_cosponsor: true, vote: 'NA', cloture_vote: 'NA', passage_vote: 'NA',
      bill_keywords: [], primary_issue: 'x', sub_issue: 'y', source_url: '', score: 0.8, strength: 'STRONG',
      missing_fields: [], bill_effect: 'ADVANCE', bill_effect_reasoning: 'r.',
    };
    const run = (x: ScorableMatch) => scoreMatches({ promise_type: 'policy', statement_type: 'Campaign Promise', matches: [x] });
    const a = run(m);
    const b = run({ ...m, record: recordSentence(input())!.sentence });
    expect(b.verdict).toBe(a.verdict);
    expect(b.band).toBe(a.band);
    expect(b.receipt).toEqual(a.receipt);
    expect(b.evidence[0]!.weight).toBe(a.evidence[0]!.weight);
    expect(b.evidence[0]!.record).toBe(recordSentence(input())!.sentence);
  });
});

// Found reading live sentences as a voter would (2026-10-03).
describe('read as a voter would', () => {
  it.each([
    ['s900-118', 'bill'],
    ['hr815-118', 'bill'],
    ['sres283-119', 'resolution'],
    ['sjres7-119', 'resolution'],
    ['hconres14-119', 'resolution'],
  ])('%s is a %s', (billId, noun) => {
    expect(measureNoun(billId)).toBe(noun);
    const r = recordSentence(input({ bill_id: billId, bill: null }))!;
    expect(r.sentence.startsWith(`Co-sponsored the ${noun} `)).toBe(true);
  });

  it('a sole co-sponsor is "its only co-sponsor", not "one of 1"', () => {
    const r = recordSentence(input({
      sponsorship: { sponsor_tier: 'ORIGINAL_COSPONSOR', cosponsored_at: '2025-03-14', original_cosponsor: true, cosponsor_total: 1 },
      bill: null,
    }))!;
    expect(r.sentence).toBe('Co-sponsored the bill from its introduction on March 14, 2025, its only co-sponsor.');
  });

  // s993-118, live: referred to Banking and Judiciary; only Banking held a
  // hearing. "committees held a hearing" overstated it.
  it('names the committee that acted, when there were several', () => {
    const r = recordSentence(input({
      bill_id: 's993-118',
      sponsorship: { ...late, committee_member: 'NA_PRIOR_CONGRESS', committee_member_of: [] },
      bill: {
        progress_outcome: 'DIED_AT_IN_COMMITTEE', progress_stage: 'IN_COMMITTEE',
        referred_committees: ['SSBK', 'SSJU'],
        committee_activity: 'SSBK: Hearings By (full committee) | SSJU: Referred To',
      },
    }))!;
    expect(r.sentence).toContain(
      'Referred to the Senate Committee on Banking, Housing, and Urban Affairs and the Senate Committee on the Judiciary; ' +
        'the Senate Committee on Banking, Housing, and Urban Affairs held a hearing.',
    );
    expect(r.sentence).not.toMatch(/committees held/);
  });

  it('a discharge after committee action reads as one clause', () => {
    const r = recordSentence(input({ bill: { ...diedInCommerce, committee_activity: 'SSCM: Referred To, Hearings By (full committee), Discharged From' } }))!;
    expect(r.sentence).toContain('; the committee held a hearing, and it was discharged from committee.');
  });
});

describe('a negative is said only when two fields agree', () => {
  // s3651-118, live: Progress Stage IN_COMMITTEE (from the action log), but
  // Committee Activity lists only the referral. "No committee action" could be
  // false, so it is not said — and the outcome sentence still stands.
  it('does not claim "no committee action" when the stage says otherwise', () => {
    const r = recordSentence(input({
      bill: { ...diedInCommerce, progress_stage: 'IN_COMMITTEE', progress_outcome: 'DIED_AT_IN_COMMITTEE', committee_activity: 'SSFI: Referred To', referred_committees: ['SSFI'] },
      sponsorship: { ...late, committee_member: 'false', committee_member_of: [] },
    }))!;
    expect(r.sentence).not.toMatch(/no committee action/);
    expect(r.sentence).toContain('Referred to the Senate Committee on Finance.');
    expect(r.sentence).toContain('It did not reach the floor before the 118th Congress ended.');
  });

  it('does say it when the stage confirms the bill stopped at referral', () => {
    expect(recordSentence(input())!.sentence).toContain('no committee action after referral is recorded');
  });
});
