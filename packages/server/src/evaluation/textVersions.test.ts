import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyTextVersion,
  governingActOf,
  isoDate,
  parseVersionRow,
  selectTextVersion,
  taxonomyDivergence,
  type GoverningAct,
  type VersionMirrorRow,
} from './textVersions.js';
import { buildFulfillmentUserMessage, type FulfillmentCandidate } from './fulfillment.js';

// ===========================================================================
// EVALUATE EACH ACTION AGAINST THE TEXT THAT EXISTED WHEN IT HAPPENED.
//
// Fixture: the six confirmed gut-and-amend bills, in the exact row shape of
// mirror.mirror_impact_statement_versions. They are SYNTHETIC today, written
// while the live corpus was being regenerated; `tools/dump-version-fixtures.mjs`
// swaps in live rows. Every assertion here is about BEHAVIOUR — which version
// is in effect on which date — and never about prose, so the swap needs no
// test change. If a test fails after the swap, the live data disagrees with
// the selection rules: report it, do not edit the fixture to agree.
// ===========================================================================

const FIXTURE = fileURLToPath(new URL('./fixtures/gutAndAmendVersions.json', import.meta.url));
const ROWS: VersionMirrorRow[] = JSON.parse(readFileSync(FIXTURE, 'utf8')).rows;
const rowsOf = (billId: string) => ROWS.filter((r) => r.bill_id === billId);

const BILLS = ['s1071-119', 'hr5334-119', 'hr6500-119', 'hr2872-118', 'hr815-118', 's870-118'];

const sponsorship = (date: string): GoverningAct => ({ kind: 'SPONSORSHIP', date });
const passage = (date: string): GoverningAct => ({ kind: 'PASSAGE', date });

const dayAfter = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** What Pinecone hands the evaluator today: one summary per bill, the latest. */
const LATEST = 'LATEST SUMMARY FROM PINECONE METADATA';
const candidate = (billId: string): FulfillmentCandidate => ({
  statement_type: 'Campaign Promise',
  promise_uid: 'QUERY',
  promise_text: 'A statement.',
  promise_stance: 'In Favor',
  promise_primary_issue: 'Budget & Economy',
  promise_sub_issue: 'Taxes',
  bill_id: billId,
  bill_title: 'CURRENT TITLE',
  bill_summary: LATEST,
  bill_primary_issue: 'Current Primary',
  bill_sub_issue: 'Current Sub',
  bill_intended_effects: 'Current effects.',
  bill_mechanisms: 'Current mechanisms.',
  vote: 'NA',
  is_sponsor: 'FALSE',
  is_cosponsor: 'TRUE',
});

// ---------------------------------------------------------------------------
// The brief's named cases.
// ---------------------------------------------------------------------------

describe('s1071-119 — introduced as a VA disinterment bill, enrolled as the FY2026 NDAA', () => {
  const rows = rowsOf('s1071-119');

  it('evaluates a March 2025 cosponsorship against the introduced text', () => {
    const s = selectTextVersion(rows, sponsorship('2025-03-20'))!;
    expect(s.disclosure.status).toBe('SELECTED');
    expect(s.disclosure.code).toBe('is');
    expect(s.disclosure.governed_by).toBe('SPONSORSHIP');
  });

  it('evaluates a December 2025 vote against the text the House sent back', () => {
    const s = selectTextVersion(rows, passage('2025-12-17'))!;
    expect(s.disclosure.status).toBe('SELECTED');
    expect(s.disclosure.code).toBe('eah');
  });

  it('gives the two actions different bill_summary inputs', () => {
    const early = applyTextVersion(candidate('s1071-119'), selectTextVersion(rows, sponsorship('2025-03-20'))!.version);
    const late = applyTextVersion(candidate('s1071-119'), selectTextVersion(rows, passage('2025-12-17'))!.version);
    expect(early.bill_summary).not.toBe(late.bill_summary);
    expect(early.bill_summary).not.toBe(LATEST);
    expect(late.bill_summary).not.toBe(LATEST);
  });
});

describe('hr5334-119 — introduced as an educator tax deduction, enrolled as a Russia sanctions act', () => {
  const rows = rowsOf('hr5334-119');

  it('evaluates a cosponsorship at introduction against the introduced text', () => {
    const s = selectTextVersion(rows, sponsorship('2025-09-20'))!;
    expect(s.disclosure.code).toBe('ih');
    expect(s.disclosure.status).toBe('SELECTED');
  });

  it('evaluates a vote after the Senate amendment against the amended text', () => {
    const s = selectTextVersion(rows, passage('2026-08-10'))!;
    expect(s.disclosure.code).toBe('eas');
  });

  it('gives the two actions different bill_summary inputs', () => {
    const a = selectTextVersion(rows, sponsorship('2025-09-20'))!.version!;
    const b = selectTextVersion(rows, passage('2026-08-10'))!.version!;
    expect(a.summary).not.toBe(b.summary);
  });

  // Task 5 needs this: the reader of a verdict on the introduced text must be
  // able to see that the bill later became something else.
  it('discloses what the bill became when the introduced text was evaluated', () => {
    const d = selectTextVersion(rows, sponsorship('2025-09-20'))!.disclosure;
    expect(d.latest?.code).toBe('enr');
    expect(d.latest?.title).not.toBe(d.title);
  });
});

describe('a bill with no version rows', () => {
  it('selects nothing, so the caller takes the unchanged path', () => {
    expect(selectTextVersion([], sponsorship('2025-03-20'))).toBeNull();
  });

  // The candidate is returned as the SAME object: not a copy with the same
  // fields, the same reference. The byte-level guarantee for dispatch lives in
  // evaluatorInputGolden.test.ts, pinned against the code before this existed.
  it('leaves the evaluator candidate untouched — the same object', () => {
    const c = candidate('s1-119');
    expect(applyTextVersion(c, null)).toBe(c);
  });
});

describe('a row with Version Mismatch = TRUE', () => {
  // Mark s1071's introduced row as a mismatch — the model described a
  // different version than the one it was given.
  const rows = rowsOf('s1071-119').map((r) =>
    r.text_version_code === 'is' ? { ...r, row: { ...r.row, 'Version Mismatch': 'TRUE' } } : r,
  );

  it('is never selected, on any date', () => {
    for (const d of ['2025-03-14', '2025-03-20', '2025-07-31', '2025-08-01', '2026-01-01']) {
      for (const act of [sponsorship(d), passage(d)]) {
        expect(selectTextVersion(rows, act)!.version?.code).not.toBe('is');
      }
    }
  });

  // Skipping it would let the NEXT-EARLIER version stand in, presented as the
  // text in effect. Here there is none, but on a later version the fall-back
  // would be a real, older, wrong text. So the slot is blocked, and disclosed.
  it('blocks its slot rather than letting another version stand in for it', () => {
    const s = selectTextVersion(rows, sponsorship('2025-03-20'))!;
    expect(s.disclosure.status).toBe('TEXT_UNAVAILABLE');
    expect(s.disclosure.code).toBe('is');
    expect(s.version).toBeNull();
    expect(applyTextVersion(candidate('s1071-119'), s.version).bill_summary).toBe(LATEST);
  });
});

describe('an undated enrolled version', () => {
  it.each(BILLS)('is never chosen for a sponsorship — %s', (billId) => {
    const rows = rowsOf(billId);
    // Even a sponsorship dated long after the last floor action.
    const s = selectTextVersion(rows, sponsorship('2099-01-01'))!;
    expect(s.version?.date).not.toBeNull();
    expect(s.disclosure.code).not.toBe('enr');
  });

  // Enrollment follows the last floor vote, so it is never the text a senator
  // voted on either. It is carried for disclosure only.
  it.each(BILLS)('is never chosen for a vote either — %s', (billId) => {
    const s = selectTextVersion(rowsOf(billId), passage('2099-01-01'))!;
    expect(s.disclosure.code).not.toBe('enr');
  });

  it('sorts last: it is what the bill became, never where it started', () => {
    for (const billId of BILLS) {
      const rows = rowsOf(billId);
      if (!rows.some((r) => !r.text_version_date)) continue;
      const d = selectTextVersion(rows, sponsorship('2000-01-01'))!.disclosure;
      expect(d.latest?.date ?? null).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// All six bills, data-driven. Dates come from the rows themselves, so these
// hold whatever the live codes and dates turn out to be.
// ---------------------------------------------------------------------------

describe.each(BILLS)('%s — the gut-and-amend pattern', (billId) => {
  const versions = rowsOf(billId).map(parseVersionRow);
  const dated = versions.filter((v) => v.date).sort((a, b) => a.date!.localeCompare(b.date!));
  const first = dated[0]!;
  const last = dated[dated.length - 1]!;

  it('has version rows to test against', () => {
    expect(dated.length).toBeGreaterThanOrEqual(2);
  });

  it('dates an original cosponsorship to the earliest version', () => {
    const s = selectTextVersion(rowsOf(billId), sponsorship(first.date!))!;
    expect(s.disclosure.code).toBe(first.code);
    expect(s.disclosure.date).toBe(first.date);
  });

  it('dates a vote after the last floor text to that text', () => {
    const s = selectTextVersion(rowsOf(billId), passage(dayAfter(last.date!)))!;
    expect(s.disclosure.code).toBe(last.code);
  });

  it('feeds the evaluator different text for the two', () => {
    const early = selectTextVersion(rowsOf(billId), sponsorship(first.date!))!;
    const late = selectTextVersion(rowsOf(billId), passage(dayAfter(last.date!)))!;
    if (early.version && late.version) {
      const a = buildFulfillmentUserMessage(applyTextVersion(candidate(billId), early.version));
      const b = buildFulfillmentUserMessage(applyTextVersion(candidate(billId), late.version));
      expect(a).not.toBe(b);
      expect(a).toContain(early.version.summary);
      expect(a).not.toContain(LATEST);
    }
  });

  // Two different bills under one number are classified differently, and the
  // divergence is computed from the stored issue pairs, not WF5's per-run flag.
  it('is reported as taxonomy-divergent', () => {
    expect(taxonomyDivergence(versions).divergent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dates.
// ---------------------------------------------------------------------------

describe('isoDate', () => {
  it.each([
    ['2025-03-14', '2025-03-14'],
    ['2025-03-14T04:00:00Z', '2025-03-14'],
    // The sheet's vote dates: 323 of 329 non-blank vote dates are M/D/YYYY.
    ['1/15/2026', '2026-01-15'],
    ['5/8/2025', '2025-05-08'],
    ['NA', null],
    ['', null],
    [null, null],
    ['next Tuesday', null],
  ])('%s -> %s', (input, out) => {
    expect(isoDate(input)).toBe(out);
  });

  // THE BUG THIS PREVENTS. Compared as strings, '1/15/2026' sorts before every
  // ISO date, so a January 2026 vote would select a version from February.
  it('places an M/D/YYYY vote date correctly among ISO version dates', () => {
    const rows = [row({ code: 'ih', date: '2025-12-10' }), row({ code: 'eh', date: '2026-02-01' })];
    const act = governingActOf({ passage_vote: 'Yea', passage_vote_date: '1/15/2026' });
    expect(act).toEqual({ kind: 'PASSAGE', date: '2026-01-15' });
    expect(selectTextVersion(rows, act)!.disclosure.code).toBe('ih');
  });
});

// ---------------------------------------------------------------------------
// The governing act — deriveAlignment's order, so the date that picks the text
// belongs to the act that decides the verdict.
// ---------------------------------------------------------------------------

describe('governingActOf', () => {
  it('cloture governs when it was taken', () => {
    expect(
      governingActOf({ cloture_vote: 'Nay', cloture_vote_date: '2025-03-01', passage_vote: 'Yea', passage_vote_date: '2025-03-05' }),
    ).toEqual({ kind: 'CLOTURE', date: '2025-03-01' });
  });

  it('passage governs without cloture', () => {
    expect(governingActOf({ passage_vote: 'Yea', passage_vote_date: '2025-03-05' })).toEqual({
      kind: 'PASSAGE',
      date: '2025-03-05',
    });
  });

  // A substitute amendment is often adopted between cloture and passage, so
  // borrowing the passage date could put the cloture vote on the wrong text.
  it('does not borrow the other vote\'s date', () => {
    expect(governingActOf({ cloture_vote: 'Yea', passage_vote: 'Yea', passage_vote_date: '2025-03-05' })).toEqual({
      kind: 'CLOTURE',
      date: null,
    });
  });

  // A cosponsor who later voted is judged on the vote.
  it('a vote outranks a cosponsorship', () => {
    expect(
      governingActOf({ is_cosponsor: 'TRUE', cosponsored_at: '2025-01-27', passage_vote: 'Yea', passage_vote_date: '5/8/2025' }),
    ).toEqual({ kind: 'PASSAGE', date: '2025-05-08' });
  });

  it('a vote-less cosponsorship is dated by Cosponsored At', () => {
    expect(governingActOf({ is_cosponsor: true, cosponsored_at: '2025-01-27' })).toEqual({
      kind: 'SPONSORSHIP',
      date: '2025-01-27',
    });
  });

  // Abstentions are not acts: "Not Voting" must not date anything.
  it('ignores non-directional votes', () => {
    expect(governingActOf({ passage_vote: 'Not Voting', passage_vote_date: '2025-03-05', is_cosponsor: 'TRUE', cosponsored_at: '2025-01-27' }))
      .toEqual({ kind: 'SPONSORSHIP', date: '2025-01-27' });
  });

  it('returns null when there is no act at all', () => {
    expect(governingActOf({ passage_vote: 'NA' })).toBeNull();
  });

  it('an untyped vote with both typed dates cannot be placed', () => {
    expect(governingActOf({ vote: 'Yea', cloture_vote_date: '2025-03-01', passage_vote_date: '2025-03-05' })).toEqual({
      kind: 'VOTE',
      date: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Selection edge cases, on hand-written rows.
// ---------------------------------------------------------------------------

function row(over: {
  code: string;
  date: string;
  summary?: string;
  mismatch?: boolean;
  flagged?: boolean;
  pi?: string;
  si?: string;
  title?: string;
  titleSource?: string;
  storedDivergent?: boolean;
  extra?: Record<string, unknown>;
}): VersionMirrorRow {
  return {
    impact_version_uid: `UID-${over.code}-${over.date}`,
    bill_id: 'x1-119',
    text_version_code: over.code,
    text_version_date: over.date || null,
    row: {
      'Text Version Code': over.code,
      'Text Version Date': over.date,
      Title: over.title ?? `Title ${over.code}`,
      'Version Title Source': over.titleSource ?? 'TEXT',
      Summary: over.summary ?? `Summary of ${over.code}.`,
      'Primary Issue': over.pi ?? 'Budget & Economy',
      'Sub Issue': over.si ?? 'Taxes',
      'Version Mismatch': over.mismatch ? 'TRUE' : 'FALSE',
      'Flagged For Review': over.flagged ? 'TRUE' : 'FALSE',
      'Taxonomy Divergent': over.storedDivergent ? 'TRUE' : 'FALSE',
      ...over.extra,
    },
  };
}

describe('selectTextVersion — edge cases', () => {
  // congress.gov publishes only a PDF for some versions; WF5 flags those with
  // an empty summary rather than a guessed one. Falling back to the previous
  // version would judge the senator against text that was no longer in effect.
  it('does not fall back to an earlier version when the one in effect has no text', () => {
    const rows = [row({ code: 'is', date: '2025-01-10' }), row({ code: 'rs', date: '2025-06-01', summary: '', flagged: true })];
    const s = selectTextVersion(rows, passage('2025-07-01'))!;
    expect(s.disclosure.status).toBe('TEXT_UNAVAILABLE');
    expect(s.disclosure.code).toBe('rs');
    expect(s.version).toBeNull();
  });

  it('prefers a usable version over an unusable one on the same day', () => {
    const rows = [row({ code: 'rh', date: '2025-06-01', summary: '' }), row({ code: 'rs', date: '2025-06-01' })];
    expect(selectTextVersion(rows, passage('2025-06-01'))!.version?.code).toBe('rs');
  });

  it('prefers an unflagged version over a flagged one on the same day', () => {
    const rows = [row({ code: 'rh', date: '2025-06-01', flagged: true }), row({ code: 'rs', date: '2025-06-01' })];
    expect(selectTextVersion(rows, passage('2025-06-01'))!.version?.code).toBe('rs');
  });

  // THE LIVE DEFECT. WF5 does not write an empty summary when a version's text
  // was never published as HTML: 16 of 21 flagged rows on the live mirror
  // (2026-10-02) carry a non-empty summary like this one. Read as usable, it
  // would hand the evaluator a sentence about missing data as the bill summary.
  it('treats a flagged row as unusable, even when its summary is not empty', () => {
    const rows = [
      row({ code: 'is', date: '2025-01-10' }),
      row({
        code: 'rs',
        date: '2025-06-01',
        flagged: true,
        summary: 'The bill summary text was unavailable, so the specific provisions of the selected version could not be summarized.',
      }),
    ];
    const s = selectTextVersion(rows, passage('2025-07-01'))!;
    expect(s.disclosure.status).toBe('TEXT_UNAVAILABLE');
    expect(s.disclosure.code).toBe('rs');
    expect(s.disclosure.flagged_for_review).toBe(true);
    expect(s.version).toBeNull();
    // Nor does the earlier, unflagged version stand in for it.
    expect(applyTextVersion(candidate('x1-119'), s.version).bill_summary).toBe(LATEST);
  });

  it('counts a version dated the same day as the act as in effect', () => {
    const rows = [row({ code: 'is', date: '2025-01-10' }), row({ code: 'es', date: '2025-03-01' })];
    expect(selectTextVersion(rows, passage('2025-03-01'))!.disclosure.code).toBe('es');
  });

  it('reports an act that predates every version, and substitutes nothing', () => {
    const s = selectTextVersion([row({ code: 'es', date: '2025-03-01' })], sponsorship('2025-01-01'))!;
    expect(s.disclosure.status).toBe('BEFORE_FIRST_VERSION');
    expect(s.version).toBeNull();
  });

  // The Congress-start proxy would always guess "introduced". An act with no
  // real date is not placed at all.
  it('reports an undated act, and substitutes nothing', () => {
    const rows = [row({ code: 'is', date: '2025-01-10' })];
    expect(selectTextVersion(rows, null)!.disclosure.status).toBe('NO_ACTION_DATE');
    expect(selectTextVersion(rows, { kind: 'CLOTURE', date: null })!.disclosure.status).toBe('NO_ACTION_DATE');
  });

  it('does not report a later version when the one evaluated is the last', () => {
    const rows = [row({ code: 'is', date: '2025-01-10' }), row({ code: 'es', date: '2025-03-01' })];
    expect(selectTextVersion(rows, passage('2025-04-01'))!.disclosure.latest).toBeNull();
  });
});

describe('taxonomyDivergence — computed from the stored issue pairs', () => {
  // WF5 compares rows within one run; versions generated in different runs are
  // never compared and never flagged. The pairs themselves settle it.
  it('finds divergence the stored per-run flag missed', () => {
    const rows = [
      row({ code: 'is', date: '2025-01-10', pi: 'Budget & Economy', si: 'Taxes' }),
      row({ code: 'eas', date: '2025-08-01', pi: 'Foreign Policy & Defense', si: 'Foreign Affairs / Diplomacy' }),
    ].map(parseVersionRow);
    expect(rows.every((v) => !v.stored_taxonomy_divergent)).toBe(true);
    const d = taxonomyDivergence(rows);
    expect(d.divergent).toBe(true);
    expect(d.detail).toBe('is -> Budget & Economy / Taxes | eas -> Foreign Policy & Defense / Foreign Affairs / Diplomacy');
  });

  it('overrides a stored flag the pairs do not support', () => {
    const rows = [row({ code: 'is', date: '2025-01-10', storedDivergent: true }), row({ code: 'es', date: '2025-03-01', storedDivergent: true })];
    expect(taxonomyDivergence(rows.map(parseVersionRow)).divergent).toBe(false);
  });

  it('falls back to the stored flag only when no row carries both issue fields', () => {
    const rows = [
      row({ code: 'is', date: '2025-01-10', pi: '', si: '', storedDivergent: true, extra: { 'Taxonomy Divergence Detail': 'is -> A / B | es -> C / D' } }),
    ].map(parseVersionRow);
    expect(taxonomyDivergence(rows)).toEqual({ divergent: true, detail: 'is -> A / B | es -> C / D' });
  });

  // A mismatch row may describe a different version than its label.
  it('leaves Version Mismatch rows out of the comparison', () => {
    const rows = [
      row({ code: 'is', date: '2025-01-10' }),
      row({ code: 'es', date: '2025-03-01', pi: 'Health Care', si: 'Prescription Drugs', mismatch: true }),
    ].map(parseVersionRow);
    expect(taxonomyDivergence(rows).divergent).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Substitution.
// ---------------------------------------------------------------------------

describe('applyTextVersion', () => {
  const base = candidate('x1-119');

  it('replaces the impact statement with the version\'s own', () => {
    const v = parseVersionRow(
      row({
        code: 'is',
        date: '2025-01-10',
        summary: 'Version summary.',
        pi: 'Foreign Policy & Defense',
        si: 'Military Personnel / Veterans',
        extra: {
          'Intended Effects': 'Version effects.',
          Mechanisms: 'Version mechanisms.',
          'Affected Stakeholders JSON': JSON.stringify([
            { impact_statement_uid: 'U', stakeholder_group: 'Veterans', positive_impact: 'Recover remains', negative_impact: 'none identified' },
          ]),
          'Reverses Existing Policy': 'true',
          'Target Name': 'FCC Order 24-76',
          'Target Source': 'Federal Register',
          'Target Effect': 'Extended E-Rate support to Wi-Fi hotspot lending.',
        },
      }),
    );
    const c = applyTextVersion(base, v);
    expect(c.bill_summary).toBe('Version summary.');
    expect(c.bill_primary_issue).toBe('Foreign Policy & Defense');
    expect(c.bill_sub_issue).toBe('Military Personnel / Veterans');
    expect(c.bill_intended_effects).toBe('Version effects.');
    expect(c.bill_mechanisms).toBe('Version mechanisms.');
    expect(c.affected_stakeholders).toEqual([
      { stakeholder_group: 'Veterans', positive_impacts: 'Recover remains', negative_impacts: 'none identified' },
    ]);
    expect(c.reverses_existing_policy).toBe('true');
    expect(c.target_effect).toBe('Extended E-Rate support to Wi-Fi hotspot lending.');
    // The statement and the senator's action are not the bill's to change.
    expect(c.promise_text).toBe(base.promise_text);
    expect(c.is_cosponsor).toBe(base.is_cosponsor);
  });

  it('uses the version title only when it was read from the version\'s own text', () => {
    const text = parseVersionRow(row({ code: 'is', date: '2025-01-10', title: 'Own heading', titleSource: 'TEXT' }));
    const canonical = parseVersionRow(row({ code: 'eah', date: '2025-12-10', title: 'Current title', titleSource: 'CANONICAL' }));
    const model = parseVersionRow(row({ code: 'es', date: '2025-08-01', title: 'Model guess', titleSource: 'MODEL' }));
    expect(applyTextVersion(base, text).bill_title).toBe('Own heading');
    expect(applyTextVersion(base, canonical).bill_title).toBe(base.bill_title);
    expect(applyTextVersion(base, model).bill_title).toBe(base.bill_title);
  });

  // A candidate assembled from two versions of a gut-and-amend bill is the
  // defect itself. A blank field stays blank.
  it('never backfills a blank field from the latest version', () => {
    const v = parseVersionRow(row({ code: 'is', date: '2025-01-10', extra: { Mechanisms: '' } }));
    expect(applyTextVersion(base, v).bill_mechanisms).toBe('');
  });

  it('drops stakeholders whose JSON will not parse, rather than borrowing the latest', () => {
    const v = parseVersionRow(row({ code: 'is', date: '2025-01-10', extra: { 'Affected Stakeholders JSON': '{not json' } }));
    expect(applyTextVersion({ ...base, affected_stakeholders: [{ stakeholder_group: 'Latest' }] }, v).affected_stakeholders)
      .toBeUndefined();
  });
});
