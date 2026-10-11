import { describe, expect, it } from 'vitest';
import type { TextVersionDisclosure } from '@receipts/shared';
import { billPath, isoDate } from './billPath.js';

// ===========================================================================
// The bill's path (2026-10-11): the steps a card draws left to right, from the
// record only. The case is hconres89-119 (Thune): passed the House July 23,
// a later version referred in the Senate, a final vote on September 24, failed.
// ===========================================================================

const tv = (over: Partial<TextVersionDisclosure> = {}): TextVersionDisclosure =>
  ({
    status: 'SELECTED', governed_by: 'PASSAGE', action_date: '2026-09-24', dated_by: null, dating_reason: null,
    code: 'eh', type: 'Engrossed in House', date: '2026-07-23', title: null, title_source: null, flagged_for_review: false,
    latest: { code: 'rfs', type: 'Referred in Senate', date: '2026-07-28', title: null, title_source: null },
    rewritten: false, taxonomy_divergent: false, taxonomy_divergence_detail: null, version_count: 3,
    ...over,
  }) as TextVersionDisclosure;

describe('billPath', () => {
  it('the War Powers resolution: introduced, passed the House (the text we read), sent to the Senate, final vote, failed', () => {
    const path = billPath({
      bill_id: 'hconres89-119',
      passage_vote: 'NAY', passage_vote_date: '9/24/2026',
      bill: { progress_outcome: 'FAILED', progress_stage: 'FLOOR' },
      text_version: tv(),
    });
    expect(path).toEqual([
      { label: 'Introduced', date: null },
      { label: 'Passed the House', date: '2026-07-23', note: 'the text we read' },
      { label: 'Sent to the Senate', date: '2026-07-28' },
      { label: 'Final vote', date: '2026-09-24', senator: { act: 'No' } },
      { label: 'Failed in a floor vote', date: null, outcome: true },
    ]);
  });

  it('a co-sponsorship dates the introduction from the join date, and names the bill dying in committee', () => {
    const path = billPath({
      bill_id: 's25-118',
      is_cosponsor: true,
      sponsorship: { cosponsored_at: '2023-03-11', days_after_introduction: 10 },
      bill: { progress_outcome: 'DIED_AT_REFERRED', progress_stage: 'REFERRED' },
    });
    expect(path).toEqual([
      { label: 'Introduced', date: '2023-03-01' },
      { label: 'Co-sponsored', date: '2023-03-11', senator: { act: 'Co-sponsored' } },
      { label: 'Ended in committee', date: null, note: 'when the 118th Congress ended', outcome: true },
    ]);
  });

  it('both votes, in date order, each with what the senator did', () => {
    const path = billPath({
      bill_id: 's100-119',
      cloture_vote: 'YEA', cloture_vote_date: '2025-05-02',
      passage_vote: 'NAY', passage_vote_date: '2025-05-06',
      bill: { progress_outcome: 'ENACTED', progress_stage_at: '2025-06-01' },
    })!;
    expect(path.map((s) => [s.label, s.senator?.act ?? null])).toEqual([
      ['Introduced', null], ['Vote to end debate', 'Yes'], ['Final vote', 'No'], ['Became law', null],
    ]);
    expect(path.at(-1)).toEqual({ label: 'Became law', date: '2025-06-01', outcome: true });
  });

  it('a rewritten bill\'s outcome says it belongs to the rewritten bill', () => {
    const path = billPath({
      bill_id: 's1071-119', passage_vote: 'YEA', passage_vote_date: '2025-03-01',
      bill: { progress_outcome: 'ENACTED', progress_stage_at: '2025-12-01' },
      text_version: tv({ code: 'is', date: '2025-02-01', latest: { code: 'enr', type: 'Enrolled', date: null, title: null, title_source: null }, rewritten: true }),
    })!;
    expect(path.at(-1)).toMatchObject({ label: 'Became law', note: 'as rewritten under the same number' });
  });

  it('nothing beyond the bill itself is no path at all', () => {
    expect(billPath({ bill_id: 's1-119' })).toBeNull();
  });

  it('reads both date spellings the record uses', () => {
    expect(isoDate('7/4/2025')).toBe('2025-07-04');
    expect(isoDate('2025-07-04T00:00:00Z')).toBe('2025-07-04');
    expect(isoDate('soon')).toBeNull();
  });
});
