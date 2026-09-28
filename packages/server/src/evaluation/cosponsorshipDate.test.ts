import { describe, expect, it } from 'vitest';
import { sponsorshipOf } from './enrichment.js';
import { preEvaluatorGates, type GateRow } from './preEvaluatorGates.js';
import { judgeGates, type JudgeGateRow } from '../judge/judgeGates.js';

// ===========================================================================
// THE COSPONSORSHIP DATE.
//
// The ingestion workflow stamps every cosponsorship row's `Action Date` with
// the BILL'S INTRODUCTION DATE, not the date the senator joined it. WF2c now
// writes the real date to `Cosponsored At`, and every date-sensitive consumer
// reads that instead.
//
// Measured on the live mirror (2026-09-28, 1,131 action rows):
//
//   tier                 rows   Action Date disagrees   worst gap
//   LATE_COSPONSOR        172            171             659 days
//   ORIGINAL_COSPONSOR    534             12             399 days
//   SPONSOR_ADVANCED      108              5             -13 days
//   SPONSOR_STALLED        84              0                   —
//
// 171 of 172 late cosponsorships were dated wrong. The rows below are shaped
// like real mirror rows rather than invented: `Action Date` in the sheet's
// M/D/YYYY, `Cosponsored At` in ISO, 'NA' where the pipeline writes it.
// ===========================================================================

/** A real row from mirror_politician_bill_actions — Thune on sjres7-119. */
const THUNE_SJRES7 = {
  'Action UID': 'ACT-sjres7-119-T000250',
  'Bill ID': 'sjres7-119',
  'Politician ID': 'T000250',
  'Action Date': '5/8/2025',
  'Cosponsored At': '2025-01-27',
  'Sponsor Tier': 'ORIGINAL_COSPONSOR',
  'Original Cosponsor': 'true',
  'Cosponsor Ordinal': '10',
  'Cosponsor Total': '16',
  'Days After Introduction': '0',
  'Withdrawn At': 'NA',
  'Committee Member': 'true',
  'Committee Member Of': 'SSCM',
  'Progress Checked At': '2026-09-20T22:01:07.236Z',
  'Is Sponsor': 'false',
  'Is Co-Sponsor': 'true',
  'Passage Vote': 'Yea',
};

/** A vote-only row: the senator voted but never put his name on the bill. */
const SCHUMER_SJRES7 = {
  'Action UID': 'ACT-sjres7-119-S000148',
  'Bill ID': 'sjres7-119',
  'Action Date': '5/8/2025',
  'Cosponsored At': 'NA',
  'Sponsor Tier': 'NA_VOTE_ONLY',
  'Original Cosponsor': 'NA',
  'Cosponsor Ordinal': 'NA',
  'Cosponsor Total': '16',
  'Days After Introduction': 'NA',
  'Withdrawn At': 'NA',
  'Committee Member': 'NA',
  'Committee Member Of': 'NA',
  'Passage Vote': 'Nay',
};

describe('sponsorshipOf — the ten WF2c columns', () => {
  it('reads a cosponsorship row as the record states it', () => {
    expect(sponsorshipOf(THUNE_SJRES7)).toEqual({
      sponsor_tier: 'ORIGINAL_COSPONSOR',
      cosponsored_at: '2025-01-27',
      original_cosponsor: true,
      cosponsor_ordinal: 10,
      cosponsor_total: 16,
      days_after_introduction: 0,
      withdrawn_at: null,
      committee_member: 'true',
      committee_member_of: ['SSCM'],
      progress_checked_at: '2026-09-20T22:01:07.236Z',
    });
  });

  // 'NA' is the pipeline's "this does not apply", and it must not arrive
  // downstream as a date, an ordinal, or a false.
  it('turns every NA into absence, never into a negative', () => {
    const s = sponsorshipOf(SCHUMER_SJRES7);
    expect(s.cosponsored_at).toBeNull();
    expect(s.original_cosponsor).toBeNull();
    expect(s.cosponsor_ordinal).toBeNull();
    expect(s.withdrawn_at).toBeNull();
    expect(s.committee_member).toBeNull();
    expect(s.committee_member_of).toBeUndefined();
    // Still a real number on a vote-only row: the bill had 16 cosponsors.
    expect(s.cosponsor_total).toBe(16);
    expect(s.sponsor_tier).toBe('NA_VOTE_ONLY');
  });

  // These three are "we could not tell", not "he is not a member". A boolean
  // would erase the difference.
  it.each(['NO_COMMITTEE', 'NA_PRIOR_CONGRESS', 'UNAVAILABLE'])(
    'keeps the %s marker rather than collapsing it to false',
    (marker) => {
      expect(sponsorshipOf({ 'Committee Member': marker }).committee_member).toBe(marker);
    },
  );

  it('splits a multi-committee membership on the pipeline separator', () => {
    expect(
      sponsorshipOf({ 'Committee Member Of': 'SSCM; SSFI' }).committee_member_of,
    ).toEqual(['SSCM', 'SSFI']);
  });

  it('returns empty values for a row WF2c has not touched', () => {
    const s = sponsorshipOf({ 'Bill ID': 's1-119' });
    expect(s.sponsor_tier).toBeNull();
    expect(s.cosponsored_at).toBeNull();
    expect(s.cosponsor_total).toBeNull();
  });
});

const baseRow: GateRow = {
  politician_id: 'T000250',
  bill_id: 's1234-119',
  promise_text: 'In my first 100 days I will get this passed.',
  bill_title: 'A bill',
};

describe('the pre-evaluator gates date a sponsorship from the record', () => {
  const refs = {
    roleAt: () => 'NONE',
    clotureResult: () => '',
    rollCallHasResult: false,
  };
  // A bounded statement whose window closed on 2025-04-30.
  const bounded = { scope: 'BOUNDED', validUntil: new Date('2025-04-30') };

  // THE VERDICT CHANGE. Before this fix the row had no date at all, so it fell
  // back to the first day of the 119th Congress (2025-01-03) — inside the
  // window — and G1a stayed silent. The senator joined the bill in December,
  // seven months after the window closed.
  it('expires a late cosponsorship that the Congress-start proxy let through', () => {
    const withoutDate = preEvaluatorGates(baseRow, bounded, refs);
    expect(withoutDate.scorable).toBe(true);
    expect(withoutDate.context.action_date).toBe('2025-01-03');
    expect(withoutDate.context.vote_flags).toContain('ACTION_DATE_PROXY');

    const withDate = preEvaluatorGates(
      { ...baseRow, cosponsored_at: '2025-12-02' },
      bounded,
      refs,
    );
    expect(withDate.scorable).toBe(false);
    expect(withDate.hit?.verdict).toBe('NOT_APPLICABLE_EXPIRED');
    expect(withDate.context.action_date).toBe('2025-12-02');
    expect(withDate.context.vote_flags).not.toContain('ACTION_DATE_PROXY');
  });

  // The other direction, and the reason this is a correctness fix rather than
  // a stricter gate: a cosponsorship INSIDE the window still scores, and now
  // does so on its own date rather than on a stand-in.
  it('keeps a cosponsorship made inside the window, and dates it properly', () => {
    const r = preEvaluatorGates({ ...baseRow, cosponsored_at: '2025-02-14' }, bounded, refs);
    expect(r.scorable).toBe(true);
    expect(r.context.action_date).toBe('2025-02-14');
    expect(r.context.vote_flags).not.toContain('ACTION_DATE_PROXY');
  });

  // A recorded vote dates itself. Nothing about vote rows changes, which is
  // what keeps this fix scoped to the rows that were actually wrong.
  it('still prefers a recorded vote date over the cosponsorship date', () => {
    const r = preEvaluatorGates(
      { ...baseRow, cosponsored_at: '2025-02-14', passage_vote_date: '2025-09-01' },
      bounded,
      refs,
    );
    expect(r.context.action_date).toBe('2025-09-01');
    expect(r.hit?.verdict).toBe('NOT_APPLICABLE_EXPIRED');
  });

  // With nothing to go on the gate must still fail open on the proxy rather
  // than drop the row.
  it('falls back to the Congress-start proxy when no real date exists', () => {
    const r = preEvaluatorGates(baseRow, { scope: 'STANDING' }, refs);
    expect(r.scorable).toBe(true);
    expect(r.context.vote_flags).toContain('ACTION_DATE_PROXY');
  });
});

describe('the judge is shown the same date the gates used', () => {
  const row: JudgeGateRow = {
    promise_alignment: 'BROKE',
    bill_effect: 'ADVANCE',
    alignment_confidence: 0.8,
    politician_id: 'T000250',
    bill_id: 's1234-119',
    promise_text: 'Within my first year I will pass this.',
    bill_title: 'A bill',
    is_cosponsor: 'TRUE',
    scope: 'BOUNDED',
    valid_until: '2025-04-30',
  };

  it('prefers Cosponsored At over the introduction date in Action Date', () => {
    // Action Date says January (the bill's introduction), so the bounded gate
    // sees an action inside the window and stays quiet.
    const onActionDate = judgeGates({ ...row, action_date: '2025-01-03' });
    expect(onActionDate.fired.some((g) => g.gate === 'G1_scope')).toBe(false);

    // The senator actually joined in December.
    const onCosponsoredAt = judgeGates({
      ...row,
      action_date: '2025-01-03',
      cosponsored_at: '2025-12-02',
    });
    const hit = onCosponsoredAt.fired.find((g) => g.gate === 'G1_scope');
    expect(hit?.class).toBe('BOUNDED_PROMISE');
    expect(hit?.detail).toContain('2025-12-02');
  });
});
