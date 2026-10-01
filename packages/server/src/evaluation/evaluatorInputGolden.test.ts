import { describe, expect, it } from 'vitest';
import type { Interpretation, MatchedAction } from '@receipts/shared';
import { newSession, toFulfillmentCandidate } from '../orchestrator/dispatch.js';
import { buildFulfillmentUserMessage } from './fulfillment.js';
import { preEvaluatorGates } from './preEvaluatorGates.js';
import { nullEnrichmentSource, type ActionEnrichment } from './enrichment.js';

// ===========================================================================
// THE EVALUATOR'S EXACT INPUT, PINNED.
//
// The snapshot below was written from the code as it stood BEFORE per-version
// text existed (commit fdb9453, Task 2). A bill with no version rows must still
// produce that message byte for byte — that is the brief's unchanged-behaviour
// guarantee, and most bills take this path.
//
// If this fails, the evaluator is being asked something different for every
// bill without version rows. Do not update the snapshot to make it pass unless
// that change to every query is the intent.
// ===========================================================================

const interpretation = {
  raw: 'I will protect the E-Rate program that connects schools to the internet.',
  statement_type: 'Campaign Promise',
  provenance: 'USER_ASSERTED',
  restated: 'Protect E-Rate funding for school internet access.',
  primary_issue: 'Technology',
  sub_issue: 'Broadband & Internet Access',
  stance: 'In Favor',
  promise_type: 'policy',
  key_policy_terms: ['E-Rate', 'school internet'],
  is_evaluable: true,
} as unknown as Interpretation;

const match: MatchedAction = {
  action_uid: 'ACT-sjres7-119-S000148',
  bill_id: 'sjres7-119',
  title: 'A joint resolution providing for congressional disapproval of the rule relating to E-Rate support for Wi-Fi hotspots',
  summary: 'Disapproves the FCC rule extending E-Rate support to Wi-Fi hotspot lending.',
  intended_effects: 'Ends E-Rate reimbursement for off-premises hotspots.',
  mechanisms: 'Congressional Review Act disapproval of the FCC order.',
  affected_stakeholders: 'Schools; libraries; students without home internet.',
  action_type: 'voted',
  is_sponsor: false,
  is_cosponsor: false,
  vote: 'Nay',
  cloture_vote: 'NA',
  passage_vote: 'Nay',
  bill_keywords: ['e-rate', 'wi-fi hotspots'],
  primary_issue: 'Technology',
  sub_issue: 'Broadband & Internet Access',
  source_url: 'https://www.congress.gov/bill/119th-congress/senate-joint-resolution/7',
  score: 0.71,
  strength: 'STRONG',
  missing_fields: [],
};

const enriched: ActionEnrichment = {
  passage_vote: 'Nay',
  passage_vote_date: '5/8/2025',
  party_whip_vote: 'Yea',
  cosponsored_at: null,
  sponsor_tier: 'NA_VOTE_ONLY',
};

describe('evaluator input for a bill with no version rows', () => {
  it('is byte-identical to the message before per-version text existed', async () => {
    const session = newSession('S000148', interpretation.raw, undefined, '2024-10-01');
    session.interpretation = interpretation;
    session.scope = { scope: 'STANDING' } as never;
    const refs = await nullEnrichmentSource.refs();
    const gate = preEvaluatorGates(
      {
        politician_id: 'S000148',
        bill_id: match.bill_id,
        promise_text: interpretation.raw,
        bill_title: match.title,
        passage_vote: 'Nay',
        passage_vote_date: enriched.passage_vote_date,
      },
      { scope: 'STANDING' },
      refs,
    );
    const message = buildFulfillmentUserMessage(toFulfillmentCandidate(session, match, enriched, gate));
    expect(message).toMatchSnapshot();
  });
});
