import { describe, expect, it, vi } from 'vitest';
import type { Interpretation, MatchedAction } from '@receipts/shared';
import { billStatementOf, type BillStatement } from './enrichment.js';
import { SUMMARY_UNDER_REVIEW_GATE, SUMMARY_UNDER_REVIEW_REASON, summaryUnderReview } from './summaryReview.js';
import type { TextVersionSelection } from './textVersions.js';
import { fixtureEnvelope } from './responsesFetcher.js';

// ===========================================================================
// A BILL WHOSE SUMMARY IS UNDER REVIEW IS SET ASIDE BEFORE EVALUATION.
//
// The bill-level statements for sjres103-119, sjres112-119 and sjres80-119
// are wrong or misleading on direction (2026-10-07). Flagged in the sheet's
// `Flagged For Review` column; confirmed in mirror.mirror_impact_statements
// 2026-10-08 as JSON true on those three, false on the other 970.
// ===========================================================================

// The enrichment reader is a module singleton; replace it for the dispatch
// test below with one that knows a single flagged bill.
const FLAGGED: BillStatement = {
  reverses_existing_policy: 'true', target_name: 'A rule', target_source: null, target_effect: null, flagged_for_review: true,
};
vi.mock('./enrichment.js', async (orig) => {
  const actual = await orig<typeof import('./enrichment.js')>();
  return {
    ...actual,
    enrichmentSource: {
      ...actual.nullEnrichmentSource,
      kind: 'mirror',
      async forBillStatements(ids: string[]) {
        return new Map(ids.filter((b) => b === 'sjres112-119').map((b) => [b, FLAGGED]));
      },
    },
  };
});

describe('reading the flag', () => {
  it.each([
    [true, true],
    ['TRUE', true],
    ['true', true],
    [false, false],
    ['', false],
    [undefined, false],
  ])('Flagged For Review %j → %s', (value, expected) => {
    const row: Record<string, unknown> = { 'Reverses Existing Policy': true };
    if (value !== undefined) row['Flagged For Review'] = value;
    expect(billStatementOf(row).flagged_for_review).toBe(expected);
  });
});

describe('when it applies', () => {
  const version = { version: { uid: 'v' } } as unknown as TextVersionSelection;
  const unusable = { version: null } as unknown as TextVersionSelection;

  it('a flagged summary with no version rows: set aside', () => {
    expect(summaryUnderReview(FLAGGED, undefined)).toBe(true);
  });

  it('a flagged summary whose version in effect is unusable: set aside — the summary is what would be read', () => {
    expect(summaryUnderReview(FLAGGED, unusable)).toBe(true);
  });

  it('a flagged summary with a usable version in effect: weighed — the version is read, not the summary', () => {
    expect(summaryUnderReview(FLAGGED, version)).toBe(false);
  });

  it('an unflagged or missing statement: weighed', () => {
    expect(summaryUnderReview({ ...FLAGGED, flagged_for_review: false }, undefined)).toBe(false);
    expect(summaryUnderReview(null, undefined)).toBe(false);
  });

  it('the reason claims nothing about the senator and is written for a reader', () => {
    expect(SUMMARY_UNDER_REVIEW_REASON).toMatch(/summary of this bill is under review/);
    expect(SUMMARY_UNDER_REVIEW_REASON).not.toMatch(/\bkept\b|\bbroke\b|\bconsistent\b|[A-Z]{2,}_[A-Z]/);
  });
});

describe('through evaluate_effects', () => {
  const interpretation = {
    raw: 'I will protect what this resolution would undo.', statement_type: 'Policy Position', provenance: 'default',
    restated: 'x', primary_issue: 'Foreign Policy & Defense', sub_issue: 'Trade & Sanctions', stance: 'In Favor',
    promise_type: 'policy', key_policy_terms: [], is_evaluable: true,
  } as unknown as Interpretation;
  const match = (bill: string): MatchedAction => ({
    action_uid: `ACT-${bill}-S000148`, bill_id: bill, title: `Resolution ${bill}`, summary: 's', intended_effects: 'e',
    mechanisms: 'm', action_type: 'voted', is_sponsor: false, is_cosponsor: false, vote: 'Nay', cloture_vote: 'NA',
    passage_vote: 'Nay', bill_keywords: [], primary_issue: 'Foreign Policy & Defense', sub_issue: 'Trade & Sanctions',
    source_url: 'https://www.congress.gov/x', score: 0.7, strength: 'STRONG', missing_fields: [],
  }) as MatchedAction;

  it('sets the flagged bill aside with the reason, and never sends it to the evaluator', async () => {
    const { newSession, dispatchTool } = await import('../orchestrator/dispatch.js');
    const session = newSession('S000148', interpretation.raw);
    session.interpretation = interpretation;
    session.scope = { scope: 'STANDING' } as never;
    session.matches = [match('sjres112-119'), match('hr1-119')];
    const sentTo: string[] = [];
    session.fulfillmentFetcher = async (body) => {
      const user = body.input.find((m) => m.role === 'user')?.content ?? '';
      sentTo.push(/Bill ID: (\S+)/.exec(String(user))?.[1] ?? '?');
      return fixtureEnvelope({ bill_effect: 'NEUTRAL', alignment: 'NOT_DETERMINABLE', confidence: 0.5 });
    };

    await dispatchTool(session, 'evaluate_effects', {});

    expect(session.gated?.map((g) => g.bill_id)).toEqual(['sjres112-119']);
    const g = session.gated![0]!;
    expect(g.gate).toBe(SUMMARY_UNDER_REVIEW_GATE);
    expect(g.reason).toBe(SUMMARY_UNDER_REVIEW_REASON);
    expect(sentTo).not.toContain('sjres112-119');
    expect(sentTo).toContain('hr1-119');
  });
});
