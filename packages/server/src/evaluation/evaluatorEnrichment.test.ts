import { describe, expect, it } from 'vitest';
import { billProgressOf, nullEnrichmentSource } from './enrichment.js';
import { buildFulfillmentUserMessage, type FulfillmentCandidate } from './fulfillment.js';
import { scoreMatches, type ScorableMatch } from '../scoring/score.js';
import { deriveAlignment } from '../scoring/deriveAlignment.js';

// ===========================================================================
// WHAT THE EVALUATOR IS TOLD.
//
// The pre-evaluator gates have read the Supabase mirror since 2026-09-07, but
// `toFulfillmentCandidate` did not: a comment recorded that every mirror table
// was empty, and it stayed in the code long after that stopped being true. So
// the gates knew the vote dates, the whip's vote and the senator's role while
// the evaluator was still being handed UNKNOWN for all three.
//
// This pins both halves of closing that gap:
//   1. the evaluator's message gains the facts, and
//   2. the VERDICT does not move, because the verdict is not the evaluator's
//      to make — deriveAlignment decides from bill_effect plus the votes.
// ===========================================================================

/** sjres7-119 as the mirror holds it: Schumer voted Nay, never cosponsored. */
const ERATE_BASE: FulfillmentCandidate = {
  statement_type: 'Campaign Promise',
  promise_uid: 'QUERY',
  promise_text: 'I will protect the E-Rate program that connects schools to the internet.',
  promise_stance: 'In Favor',
  promise_primary_issue: 'Technology',
  promise_sub_issue: 'Broadband & Internet Access',

  bill_id: 'sjres7-119',
  action_uid: 'ACT-sjres7-119-S000148',
  bill_title: 'A joint resolution providing for congressional disapproval of the rule relating to E-Rate support for Wi-Fi hotspots',
  bill_summary: 'Disapproves the FCC rule extending E-Rate support to Wi-Fi hotspot lending.',
  bill_primary_issue: 'Technology',
  bill_sub_issue: 'Broadband & Internet Access',

  vote: 'Nay',
  passage_vote: 'Nay',
  is_sponsor: 'FALSE',
  is_cosponsor: 'FALSE',
  bill_congress: '119',
};

/** The same row once enrichment and the gates have run. */
const ERATE_ENRICHED: FulfillmentCandidate = {
  ...ERATE_BASE,
  passage_vote_date: '2025-05-08',
  party_whip_vote: 'Yea',
  senator_role: 'MINORITY_LEADER',
  cloture_result: 'AGREED',
  bill_class: 'REVERSAL',
  action_date: '2025-05-08',
};

describe('the E-Rate golden case — enrichment changes the input, not the verdict', () => {
  // The verdict comes from the alignment table, which reads bill_effect and the
  // votes and nothing else. No field added in this change is an input to it.
  it('stays BROKE with and without enrichment', () => {
    // Exactly the fields `deriveAlignment` reads, taken off each candidate the
    // way dispatch takes them. If enrichment ever started feeding the table,
    // these two objects would stop matching.
    const alignmentInputOf = (c: FulfillmentCandidate) => ({
      bill_effect: 'ADVANCE' as const,
      vote: c.vote,
      cloture_vote: c.cloture_vote,
      passage_vote: c.passage_vote,
      is_sponsor: c.is_sponsor,
      is_cosponsor: c.is_cosponsor,
    });

    const before = alignmentInputOf(ERATE_BASE);
    const after = alignmentInputOf(ERATE_ENRICHED);
    expect(after).toEqual(before);

    // The resolution disapproves the rule that created the support, so
    // evaluator v7 returns ADVANCE for a statement in favour of E-Rate and the
    // Nay breaks it. Same verdict on both rows, because it is the same input.
    expect(deriveAlignment(before, 'Campaign Promise').verdict).toBe('BROKE');
    expect(deriveAlignment(after, 'Campaign Promise').verdict).toBe('BROKE');
  });

  it('told the evaluator UNKNOWN for facts the gates already had', () => {
    const before = buildFulfillmentUserMessage(ERATE_BASE);
    expect(before).toContain('Senator role at the time: UNKNOWN');
    expect(before).toContain('Party whip\'s vote: NA');
    expect(before).toContain('Action date: unknown');
    expect(before).toContain('Bill class: UNKNOWN');
  });

  it('now states them, with the values the gates resolved', () => {
    const after = buildFulfillmentUserMessage(ERATE_ENRICHED);
    expect(after).toContain('Senator role at the time: MINORITY_LEADER');
    expect(after).toContain('Party whip\'s vote: Yea');
    expect(after).toContain('Passage Vote: Nay on 2025-05-08');
    expect(after).toContain('Action date: 2025-05-08');
    expect(after).toContain('Bill class: REVERSAL');
  });

  // The statement, the bill and the senator's action are the evidence. Only the
  // context around them changed, so a diff that touched the bill text would be
  // a different change from the one being made here.
  it('leaves the statement and the bill text untouched', () => {
    const before = buildFulfillmentUserMessage(ERATE_BASE).split('## SENATOR');
    const after = buildFulfillmentUserMessage(ERATE_ENRICHED).split('## SENATOR');
    expect(after[0]!.replace(/Bill class: REVERSAL/, 'Bill class: UNKNOWN')).toBe(before[0]);
  });

  // v6 anchored this call on the relevance step's reasoning and produced false
  // accusations. Threading more context must not smuggle it back.
  it('still carries no prior reasoning', () => {
    expect(buildFulfillmentUserMessage(ERATE_ENRICHED)).not.toContain('prior_llm_reasoning');
    expect(buildFulfillmentUserMessage(ERATE_ENRICHED)).not.toContain('PRIOR EVALUATION');
  });
});

// ===========================================================================
// The brief's acceptance test: no numeric score moves.
// ===========================================================================

let uid = 0;
function match(over: Partial<ScorableMatch> = {}): ScorableMatch {
  uid += 1;
  return {
    action_uid: `ACT-test-${uid}`,
    bill_id: `bill-${uid}-119`,
    title: 'A Bill',
    summary: 'Summary.',
    intended_effects: 'Effects.',
    mechanisms: 'Mechanisms.',
    action_type: 'cosponsored',
    is_sponsor: false,
    is_cosponsor: true,
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

describe('tier and progress data never move a score', () => {
  it('produces an identical result with and without the WF2c fields', () => {
    const plain = match();
    // The same row, now carrying what WF2c established about it. `vote_flags`
    // is the one channel these facts travel on into the scorer, and it is
    // documented DISCLOSURE ONLY — this is the test that holds that line.
    //
    // The sponsorship tier itself is deliberately absent from `ScorableMatch`:
    // there is no field for it, so it cannot reach a weight even by accident.
    const enriched: ScorableMatch = {
      ...plain,
      vote_flags: ['ACTION_DATE_PROXY', 'FLOOR_LEADER'],
    };

    const run = (m: ScorableMatch) =>
      scoreMatches({ promise_type: 'policy', statement_type: 'Campaign Promise', matches: [m] });
    const a = run(plain);
    const b = run(enriched);

    expect(b.verdict).toBe(a.verdict);
    expect(b.band).toBe(a.band);
    expect(b.receipt).toEqual(a.receipt);
    expect(b.evidence.map((e) => e.weight)).toEqual(a.evidence.map((e) => e.weight));
    expect(b.evidence.map((e) => e.outcome)).toEqual(a.evidence.map((e) => e.outcome));
  });
});

// ===========================================================================
// The bill-level reader.
// ===========================================================================

describe('billProgressOf — how far the bill got', () => {
  // A real mirror row: sjres7-119 passed the Senate and is still live.
  it('reads the progress block as the record states it', () => {
    expect(
      billProgressOf({
        'Bill ID': 'sjres7-119',
        'Progress Stage': 'PASSED_CHAMBER',
        'Progress Outcome': 'ACTIVE',
        'Progress Stage At': '2025-05-08',
        'Last Action At': '2025-05-08',
        'Last Action Text': 'Passed Senate without amendment by Yea-Nay Vote.',
        'Committee Activity': 'SSCM: Discharged From, Referred To',
        'Referred Committees': 'SSCM',
        'Cosponsor Count': '16',
        'Enacted Via': 'NA',
      }),
    ).toEqual({
      progress_stage: 'PASSED_CHAMBER',
      progress_outcome: 'ACTIVE',
      progress_stage_at: '2025-05-08',
      last_action_at: '2025-05-08',
      last_action_text: 'Passed Senate without amendment by Yea-Nay Vote.',
      committee_activity: 'SSCM: Discharged From, Referred To',
      referred_committees: ['SSCM'],
      cosponsor_count: 16,
      // 'NA' is not a bill number. Null, so nothing can claim the text became
      // law somewhere else.
      enacted_via: null,
    });
  });

  it('splits multiple referred committees', () => {
    expect(
      billProgressOf({ 'Referred Committees': 'HSAS; SSVA' }).referred_committees,
    ).toEqual(['HSAS', 'SSVA']);
  });

  it('returns empty values for a bill with no Bills Master row', () => {
    const b = billProgressOf({});
    expect(b.progress_stage).toBeNull();
    expect(b.progress_outcome).toBeNull();
    expect(b.enacted_via).toBeNull();
    expect(b.referred_committees).toBeUndefined();
  });
});

describe('the null enrichment source', () => {
  it('supplies no bill progress rather than claiming a bill went nowhere', async () => {
    expect((await nullEnrichmentSource.forBills(['sjres7-119'])).size).toBe(0);
  });
});
