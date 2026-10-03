import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { preEvaluatorGates, type GateRefs } from './preEvaluatorGates.js';
import {
  gateTextOf,
  governingActOf,
  parseVersionRow,
  selectTextVersion,
  type VersionMirrorRow,
} from './textVersions.js';

// ===========================================================================
// THE GATES READ THE BILL AS IT STOOD WHEN THE SENATOR ACTED.
//
// G4 closes an action on a broad vehicle — an appropriations or authorization
// package — when the impact analysis names only generic stakeholders. Its test
// is a pattern on the TITLE. Read off the latest title, a March 2025
// cosponsorship of s1071-119 — a bill to disinter one veteran's remains — was
// classed as a vote on the FY2026 NDAA, and closed as "a vehicle that funds
// everything". That is the defect the version track exists to fix, on its
// headline case.
//
// These run on the LIVE s1071-119 rows in the fixture (dumped 2026-10-02 after
// the corpus was rebuilt): `is` carries a TEXT title, `eah` a MODEL one.
// ===========================================================================

const FIXTURE = fileURLToPath(new URL('./fixtures/gutAndAmendVersions.json', import.meta.url));
const ROWS: VersionMirrorRow[] = JSON.parse(readFileSync(FIXTURE, 'utf8')).rows;
const S1071 = ROWS.filter((r) => r.bill_id === 's1071-119');

/** What Pinecone carries for the bill today: its current — enrolled — title. */
const NDAA_TITLE = parseVersionRow(S1071.find((r) => r.text_version_code === 'enr')!).title!;
/** Generic stakeholders, the kind the NDAA's main impact statement lists. */
const LATEST = { bill_title: NDAA_TITLE, stakeholder_groups: ['Department of Defense'] };

const refs: GateRefs = { roleAt: () => 'NONE', clotureResult: () => '', rollCallHasResult: false };
const gate = (bill_title: string, stakeholder_groups: string[]) =>
  preEvaluatorGates(
    {
      politician_id: 'X000001',
      bill_id: 's1071-119',
      promise_text: 'I will make sure veterans are buried with dignity and their families respected.',
      bill_title,
      stakeholder_groups,
      cosponsored_at: '2025-03-20',
    },
    { scope: 'STANDING' },
    refs,
  );

describe('s1071-119 at the gates', () => {
  it('the latest title closes a March 2025 cosponsorship as a broad vehicle — the defect', () => {
    const r = gate(LATEST.bill_title, LATEST.stakeholder_groups);
    expect(r.context.bill_class).toBe('BROAD_VEHICLE');
    expect(r.hit?.gate).toBe('G4_vehicle');
  });

  it('the version in effect classes it as the targeted VA bill it was, and lets it through', () => {
    const act = governingActOf({ is_cosponsor: 'TRUE', cosponsored_at: '2025-03-20' });
    const selection = selectTextVersion(S1071, act);
    expect(selection?.disclosure.code).toBe('is');

    const text = gateTextOf(selection, LATEST);
    expect(text.bill_title).not.toBe(NDAA_TITLE);
    expect(text.bill_title).toMatch(/disinter/i);

    const r = gate(text.bill_title, text.stakeholder_groups);
    expect(r.context.bill_class).toBe('TARGETED');
    expect(r.scorable).toBe(true);
  });

  // The other side: by December 2025 the bill IS the NDAA. The engrossed
  // amendment has no heading of its own (MODEL title), so the current title is
  // used — and is right.
  it('a December 2025 vote is still classed as the broad vehicle it had become', () => {
    const act = governingActOf({ passage_vote: 'Yea', passage_vote_date: '12/17/2025' });
    const selection = selectTextVersion(S1071, act);
    expect(selection?.disclosure.code).toBe('eah');
    const text = gateTextOf(selection, LATEST);
    expect(text.bill_title).toBe(NDAA_TITLE);
    expect(gate(text.bill_title, text.stakeholder_groups).context.bill_class).toBe('BROAD_VEHICLE');
  });
});

describe('gateTextOf', () => {
  const row = (code: string, date: string, extra: Record<string, unknown>): VersionMirrorRow => ({
    impact_version_uid: `U-${code}`,
    bill_id: 'x1-119',
    text_version_code: code,
    text_version_date: date,
    row: {
      Title: `Own heading of ${code}`,
      'Version Title Source': 'TEXT',
      Summary: `Summary of ${code}.`,
      'Affected Stakeholders JSON': JSON.stringify([{ stakeholder_group: `Group of ${code}` }]),
      ...extra,
    },
  });
  const latest = { bill_title: 'Current title', stakeholder_groups: ['Current group'] };
  const at = (rows: VersionMirrorRow[]) => selectTextVersion(rows, { kind: 'SPONSORSHIP', date: '2025-06-01' });

  it('uses the version in effect when the bill has versions', () => {
    expect(gateTextOf(at([row('is', '2025-01-01', {})]), latest)).toEqual({
      bill_title: 'Own heading of is',
      stakeholder_groups: ['Group of is'],
    });
  });

  it('is exactly the latest text for a bill with no versions', () => {
    expect(gateTextOf(null, latest)).toBe(latest);
    expect(gateTextOf(undefined, latest)).toEqual(latest);
  });

  it.each(['MODEL', 'CANONICAL', 'NA'])('falls back to the current title when the version title is %s', (src) => {
    expect(gateTextOf(at([row('eah', '2025-01-01', { 'Version Title Source': src })]), latest).bill_title).toBe('Current title');
  });

  it('does not trust the title of a Version Mismatch row', () => {
    expect(gateTextOf(at([row('is', '2025-01-01', { 'Version Mismatch': true })]), latest).bill_title).toBe('Current title');
  });

  // An unusable summary does not make the heading wrong: whether the text in
  // effect was an appropriations vehicle is still known. Its impact analysis,
  // though, is no more trustworthy than its summary.
  it('reads the title of an unusable in-effect version, but not its stakeholders', () => {
    const t = gateTextOf(at([row('rs', '2025-01-01', { 'Flagged For Review': true })]), latest);
    expect(t.bill_title).toBe('Own heading of rs');
    expect(t.stakeholder_groups).toEqual(['Current group']);
  });

  it('falls back entirely when the act cannot be placed', () => {
    const s = selectTextVersion([row('is', '2025-01-01', {})], null);
    expect(gateTextOf(s, latest)).toEqual(latest);
  });
});
