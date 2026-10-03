import { describe, expect, it } from 'vitest';
import { truthy } from '../scoring/deriveAlignment.js';
import { judgeGates } from '../judge/judgeGates.js';
import { bool as pineconeBool } from '../data/PineconeActionStore.js';
import { sponsorshipOf } from './enrichment.js';
import { parseVersionRow, selectTextVersion, taxonomyDivergence, type VersionMirrorRow } from './textVersions.js';

// ===========================================================================
// SHEET FLAGS COME BACK IN THREE SHAPES. Every reader must accept all three.
//
// Google Sheets turns the typed string TRUE into a boolean cell. The n8n
// Sheets node reads it back as a JSON BOOLEAN, and that is what the mirror
// stores — measured 2026-10-02 on mirror_impact_statement_versions:
//
//   Flagged For Review   jsonb boolean   596 false · 21 true
//   Version Mismatch     jsonb boolean   617 false
//   Taxonomy Divergent   jsonb boolean   455 false · 162 true
//
// Postgres `->>` renders a JSON boolean as lowercase `true`, so a SQL filter
// on `= 'TRUE'` finds zero flagged rows when there are 21. A TypeScript reader
// that compared case-sensitively — or that compared a boolean to a string —
// would do the same thing silently, and treat every flagged row as clean.
//
// The three shapes, every reader, one file, so a new reader that gets it wrong
// fails here rather than in production.
// ===========================================================================

const SHAPES: Array<[string, unknown]> = [
  ['JSON boolean true (what the mirror stores)', true],
  ['lowercase string "true" (what ->> prints)', 'true'],
  ['uppercase string "TRUE" (what the sheet displays)', 'TRUE'],
  ['mixed case "True"', 'True'],
];
const FALSES: Array<[string, unknown]> = [
  ['JSON boolean false', false],
  ['lowercase "false"', 'false'],
  ['uppercase "FALSE"', 'FALSE'],
];

const versionRow = (code: string, date: string, flags: Record<string, unknown>, issue = ['Budget & Economy', 'Taxes']): VersionMirrorRow => ({
  impact_version_uid: `U-${code}`,
  bill_id: 'x1-119',
  text_version_code: code,
  text_version_date: date,
  row: {
    'Text Version Code': code,
    'Text Version Date': date,
    Title: `Title ${code}`,
    'Version Title Source': 'TEXT',
    Summary: `Summary of ${code}.`,
    'Primary Issue': issue[0],
    'Sub Issue': issue[1],
    ...flags,
  },
});

describe.each(SHAPES)('a flag stored as %s', (_label, TRUE) => {
  it('Version Mismatch blocks the version', () => {
    const v = parseVersionRow(versionRow('is', '2025-01-10', { 'Version Mismatch': TRUE }));
    expect(v.version_mismatch).toBe(true);
    const s = selectTextVersion([versionRow('is', '2025-01-10', { 'Version Mismatch': TRUE })], { kind: 'PASSAGE', date: '2025-02-01' })!;
    expect(s.disclosure.status).toBe('TEXT_UNAVAILABLE');
    expect(s.version).toBeNull();
  });

  it('Flagged For Review is read as flagged, and loses a same-day tie', () => {
    const rows = [
      versionRow('rh', '2025-06-01', { 'Flagged For Review': TRUE }),
      versionRow('rs', '2025-06-01', { 'Flagged For Review': false }),
    ];
    expect(parseVersionRow(rows[0]!).flagged_for_review).toBe(true);
    expect(selectTextVersion(rows, { kind: 'PASSAGE', date: '2025-06-01' })!.version?.code).toBe('rs');
  });

  it('a lone flagged version in effect is disclosed as flagged', () => {
    const s = selectTextVersion([versionRow('rs', '2025-06-01', { 'Flagged For Review': TRUE })], { kind: 'PASSAGE', date: '2025-07-01' })!;
    expect(s.disclosure.flagged_for_review).toBe(true);
  });

  it('Taxonomy Divergent is honoured on the stored-flag fallback', () => {
    const v = parseVersionRow(versionRow('is', '2025-01-10', { 'Taxonomy Divergent': TRUE }, ['', '']));
    expect(v.stored_taxonomy_divergent).toBe(true);
    expect(taxonomyDivergence([v]).divergent).toBe(true);
  });

  it('Original Cosponsor reads as true', () => {
    expect(sponsorshipOf({ 'Original Cosponsor': TRUE }).original_cosponsor).toBe(true);
  });

  it('Is Sponsor / Is Co-Sponsor read as true in the alignment table, the judge gates and the Pinecone store', () => {
    expect(truthy(TRUE)).toBe(true);
    expect(pineconeBool(TRUE)).toBe(true);
    // The judge's own flag reader is private; observe it through the gate it
    // drives — a cosponsor with a NAY that was not called a procedural switch.
    const r = judgeGates({
      promise_alignment: 'BROKE', bill_effect: 'ADVANCE', alignment_confidence: 0.8,
      politician_id: 'X', bill_id: 's1-119', promise_text: 'A statement.', bill_title: 'A bill',
      is_cosponsor: TRUE as string, passage_vote: 'Nay',
    });
    expect(r.fired.some((g) => g.class === 'SPONSOR_NAY_NOT_SWITCH')).toBe(true);
  });
});

describe.each(FALSES)('a flag stored as %s', (_label, FALSE) => {
  it('is read as false by every reader', () => {
    const v = parseVersionRow(versionRow('is', '2025-01-10', {
      'Version Mismatch': FALSE, 'Flagged For Review': FALSE, 'Taxonomy Divergent': FALSE,
    }));
    expect(v.version_mismatch).toBe(false);
    expect(v.flagged_for_review).toBe(false);
    expect(v.stored_taxonomy_divergent).toBe(false);
    expect(sponsorshipOf({ 'Original Cosponsor': FALSE }).original_cosponsor).toBe(false);
    expect(truthy(FALSE)).toBe(false);
    expect(pineconeBool(FALSE)).toBe(false);
  });
});

// Absence is not a negative and not a positive. 'NA' on a sponsor row means
// "does not apply", and must not read as either.
describe('a flag that is absent or NA', () => {
  it.each([['NA'], [''], [null], [undefined]])('%s is neither true nor false where the reader distinguishes', (v) => {
    expect(sponsorshipOf({ 'Original Cosponsor': v }).original_cosponsor).toBeNull();
    expect(parseVersionRow(versionRow('is', '2025-01-10', { 'Version Mismatch': v })).version_mismatch).toBe(false);
  });
});
