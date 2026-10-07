import { describe, expect, it } from 'vitest';
import {
  ND_REASON_COPY,
  TEXT_AT_ACTION_UNAVAILABLE,
  VOTE_FLAG_COPY,
  textVersionLines,
  type TextVersionDisclosure,
} from '@receipts/shared';

// ===========================================================================
// "THE TEXT ISN'T AVAILABLE" WAS FALSE FOR HALF THE CASES.
//
// A version row is unusable for one of three reasons: generated for the wrong
// version (mismatch), Flagged For Review, or an empty summary. Flagged used to
// mean only "the text was unavailable to the generator". Since 2026-10-07 it
// also marks rows whose text exists but whose SUMMARY is wrong — 14 rows on
// disapproval resolutions, sjres31-119 among them, describing the overturned
// rule backwards. The flag alone cannot tell the two apart, so the reader is
// told what is true of every case: we have no reliable summary of that
// version.
// ===========================================================================

const d = (over: Partial<TextVersionDisclosure>): TextVersionDisclosure => ({
  status: 'TEXT_UNAVAILABLE', governed_by: 'PASSAGE', action_date: '2025-06-02', dated_by: 'PASSAGE', dating_reason: null,
  code: 'is', type: 'Introduced in Senate', date: '2025-03-01', title: null, title_source: null, flagged_for_review: true,
  latest: null, rewritten: false, taxonomy_divergent: false, taxonomy_divergence_detail: null, version_count: 4,
  ...over,
});

// Every surface a reader or the explainer sees for an unusable version.
const surfaces = [
  ['card line (flagged)', textVersionLines(d({ flagged_for_review: true })).join(' ')],
  ['card line (mismatch or empty)', textVersionLines(d({ flagged_for_review: false })).join(' ')],
  ['card flag', VOTE_FLAG_COPY[TEXT_AT_ACTION_UNAVAILABLE]!],
  ['withheld verdict', ND_REASON_COPY.WITHHELD_TEXT_UNAVAILABLE],
] as const;

describe('true whether the text is missing or its summary is wrong', () => {
  it.each(surfaces)('%s says we lack a reliable summary', (_name, copy) => {
    expect(copy).toMatch(/reliable summary/);
  });

  it.each(surfaces)('%s never claims the text itself is missing', (_name, copy) => {
    expect(copy).not.toMatch(/isn['’]t available|not available|is missing|doesn['’]t exist/);
  });

  it('flagged and unflagged rows read the same — the flag cannot tell the causes apart', () => {
    expect(surfaces[0][1]).toBe(surfaces[1][1]);
  });
});
