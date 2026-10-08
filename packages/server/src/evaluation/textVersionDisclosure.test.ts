import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BANNED_MOTIVE_TERMS,
  TEXT_VERSION_PHRASE,
  textVersionLines,
  type TextVersionDisclosure,
} from '@receipts/shared';
import { selectTextVersion, type GoverningAct, type VersionMirrorRow } from './textVersions.js';
import { buildFollowupContext } from '../followup/followup.js';
import type { TraceRecord } from '../trace/TraceStore.js';
import type { TraceStep } from '../trace/Trace.js';

// ===========================================================================
// TASK 5 — WHAT THE VOTER SEES ABOUT WHICH TEXT WAS JUDGED.
//
// The brief's acceptance line: "A voter reading a verdict on hr5334 must be
// able to see that the text they're reading about is the introduced version,
// and that the bill later became something else." Run on the LIVE rows.
// ===========================================================================

const FIXTURE = fileURLToPath(new URL('./fixtures/gutAndAmendVersions.json', import.meta.url));
const ROWS: VersionMirrorRow[] = JSON.parse(readFileSync(FIXTURE, 'utf8')).rows;
const disclosureFor = (billId: string, act: GoverningAct) =>
  selectTextVersion(ROWS.filter((r) => r.bill_id === billId), act)!.disclosure;

describe('hr5334-119 — the brief\'s acceptance case', () => {
  const lines = textVersionLines(disclosureFor('hr5334-119', { kind: 'SPONSORSHIP', date: '2025-09-20' }));

  it('says the text judged is the introduced version, with its date and its own title', () => {
    expect(lines[0]).toMatch(/^Judged against the text in effect when the senator acted: the version as introduced \(September 11, 2025\), titled “To amend the Internal Revenue Code of 1986 to allow early childhood educators/);
  });

  it('says the bill later became something else, by its own title', () => {
    expect(lines[1]).toMatch(/^Under the same number, its final text is titled “To impose sanctions/);
  });
});

describe('s1071-119 — the live run (a December 2025 cloture vote)', () => {
  const lines = textVersionLines(disclosureFor('s1071-119', { kind: 'CLOTURE', date: '2025-12-15' }));

  // eah's title is a MODEL document header ("[Congressional Bills 119th
  // Congress] …"). It is never quoted; the plain phrase stands in.
  it('names the version in plain words and quotes no document header', () => {
    expect(lines[0]).toBe('Judged against the text in effect when the senator acted: the version as amended by the House (December 10, 2025).');
    expect(lines.join(' ')).not.toMatch(/Congressional Bills|Engrossed Amendment|U\.S\. Government Publishing Office/);
  });

  // eah → enr: a later version exists, but with no TEXT title on eah, whether
  // it is different legislation cannot be told. Said neutrally.
  it('mentions the later version without claiming a rewrite', () => {
    expect(lines[1]).toBe('A later version of the text exists: the version as enrolled — the final text agreed by both chambers.');
    expect(lines.join(' ')).not.toMatch(/rewritten/);
  });
});

const d = (over: Partial<TextVersionDisclosure>): TextVersionDisclosure => ({
  status: 'SELECTED', governed_by: 'PASSAGE', action_date: '2025-06-02', dated_by: 'PASSAGE', dating_reason: null, code: 'rs', type: 'Reported in Senate',
  date: '2025-06-01', title: 'A bill to do one thing', title_source: 'TEXT', flagged_for_review: false,
  latest: null, rewritten: false, taxonomy_divergent: false, taxonomy_divergence_detail: null, version_count: 2,
  ...over,
});

describe('textVersionLines — every status', () => {
  it('nothing to disclose → nothing rendered', () => {
    expect(textVersionLines(null)).toEqual([]);
    expect(textVersionLines(undefined)).toEqual([]);
  });

  it('the version judged was the last: one line, no "later"', () => {
    expect(textVersionLines(d({}))).toEqual([
      'Judged against the text in effect when the senator acted: the version as reported by committee (June 1, 2025), titled “A bill to do one thing”.',
    ]);
  });

  it('TEXT_UNAVAILABLE names the version that should have been used', () => {
    const lines = textVersionLines(d({ status: 'TEXT_UNAVAILABLE', flagged_for_review: true }));
    expect(lines[0]).toBe(
      "We don't have a reliable summary of the text in effect when the senator acted — the version as reported by committee (June 1, 2025) — so a later version was used.",
    );
  });

  it('NO_ACTION_DATE and BEFORE_FIRST_VERSION say the latest version was used, and why', () => {
    expect(textVersionLines(d({ status: 'NO_ACTION_DATE', code: null, date: null }))[0]).toMatch(/doesn't date this action .* latest version was used/);
    expect(textVersionLines(d({ status: 'BEFORE_FIRST_VERSION', code: null, date: null }))[0]).toMatch(/predates the earliest version .* latest version was used/);
  });

  it.each(['MODEL', 'CANONICAL', 'NA', null])('a %s title is never quoted', (src) => {
    const lines = textVersionLines(
      d({ title_source: src, latest: { code: 'enr', type: 'Enrolled Bill', date: null, title: 'Header junk', title_source: src }, rewritten: true }),
    );
    expect(lines.join(' ')).not.toMatch(/A bill to do one thing|Header junk/);
    expect(lines[1]).toBe('The bill was later rewritten under the same number.');
  });

  // Titles end in a period ("…, and for other purposes."). Quoted inside a
  // sentence that supplies its own, they rendered as 'purposes.”.'.
  it('never doubles the closing punctuation of a quoted title', () => {
    const lines = textVersionLines(
      d({ title: 'A bill to do one thing, and for other purposes.', latest: { code: 'enr', type: null, date: null, title: 'An act to do another.', title_source: 'TEXT' }, rewritten: true }),
    );
    expect(lines.join(' ')).not.toMatch(/\.”\./);
    expect(lines[0]).toMatch(/purposes”\.$/);
    expect(lines[1]).toBe('Under the same number, its final text is titled “An act to do another”.');
  });

  it('truncates a very long title', () => {
    const lines = textVersionLines(d({ title: 'x'.repeat(400) }));
    expect(lines[0]!.length).toBeLessThan(300);
    expect(lines[0]).toContain('…”');
  });

  // The divergence is real — gated on the text titles differing — but a single
  // version's label is not reliable, so none is printed.
  it('states that the classification changed, without naming the labels', () => {
    const detail = 'is,es -> Budget & Economy / Finance & Banking | eah,enr -> Foreign Policy & Defense / Defense Spending';
    const lines = textVersionLines(d({ taxonomy_divergent: true, taxonomy_divergence_detail: detail }));
    expect(lines.at(-1)).toBe('Versions of this bill were classified under different policy areas as its text changed.');
    expect(lines.join(' ')).not.toMatch(/Finance & Banking|Defense Spending/);
    expect(textVersionLines(d({ taxonomy_divergent: false, taxonomy_divergence_detail: detail })).join(' ')).not.toMatch(/policy area/);
  });

  it('falls back to the version type for an unknown code', () => {
    expect(textVersionLines(d({ code: 'zz', type: 'Odd Version' }))[0]).toContain('the version marked “Odd Version”');
  });

  // Every code on the full live corpus (617 rows, 2026-10-03), not just the six
  // fixture bills — the first version of this map missed `pap` and confused
  // `rfs` (REFERRED in Senate) with `rds` (RECEIVED in Senate).
  it.each(['is', 'enr', 'pcs', 'rs', 'es', 'eh', 'ih', 'rh', 'ats', 'rds', 'eas', 'eah', 'rfs', 'cps', 'cph', 'pap', 'hds'])(
    'has a phrase for %s',
    (code) => expect(TEXT_VERSION_PHRASE[code]).toBeDefined(),
  );

  it('does not confuse referred with received', () => {
    expect(TEXT_VERSION_PHRASE.rfs).toMatch(/referred/);
    expect(TEXT_VERSION_PHRASE.rds).toMatch(/received/);
  });

  // "the bill as introduced" is wrong for a resolution; every phrase completes
  // "the version …" instead.
  it('words every phrase so it fits a resolution as well as a bill', () => {
    for (const phrase of Object.values(TEXT_VERSION_PHRASE)) expect(phrase).not.toMatch(/\bbill\b/);
  });

  it('claims nothing about the senator', () => {
    const all = [
      d({}), d({ status: 'TEXT_UNAVAILABLE' }), d({ status: 'NO_ACTION_DATE' }), d({ status: 'BEFORE_FIRST_VERSION' }),
      d({ latest: { code: 'enr', type: null, date: null, title: 'B', title_source: 'TEXT' }, rewritten: true }),
    ].flatMap(textVersionLines).join(' ');
    expect(all).not.toMatch(/\b(he|she|his|her|him)\b/i);
    for (const t of BANNED_MOTIVE_TERMS) expect(all.toLowerCase()).not.toContain(t);
  });
});

describe('the follow-up assistant can answer "which text was this judged against?"', () => {
  const step = (over: Partial<TraceStep>): TraceStep => ({
    run_id: 'r', seq: 0, at: '2026-10-04T00:00:00Z', duration_ms: null, stage: 'REQUEST', kind: 'control',
    status: 'ok', subject: null, label: '', model: null, prompt_version: null, prompt_sha256: null,
    usage: null, input: null, output: null, error: null, ...over,
  });
  const disclosure = disclosureFor('hr5334-119', { kind: 'SPONSORSHIP', date: '2025-09-20' });
  const record: TraceRecord = {
    run: {
      run_id: '22222222-2222-2222-2222-222222222222', started_at: '2026-10-04T00:00:00Z', ended_at: '2026-10-04T00:01:00Z',
      status: 'result', politician_id: 'X', promise_text: 'Support early childhood educators.', query_id: null, meta: {},
    },
    steps: [
      step({ seq: 1, stage: 'TEXT_VERSION', subject: 'ACT-hr5334-119-X', label: 'hr5334-119 · SPONSORSHIP 2025-09-20 → ih (2025-09-11)', output: disclosure }),
    ],
  };

  it('carries the version judged, its own title, and what the bill became', () => {
    const ctx = buildFollowupContext(record);
    expect(ctx).toContain('hr5334-119 · SPONSORSHIP 2025-09-20 → ih (2025-09-11)');
    expect(ctx).toContain('titled "To amend the Internal Revenue Code');
    expect(ctx).toContain('the bill was rewritten under the same number');
    expect(ctx).toMatch(/latest version is enr, titled "To impose sanctions/);
  });
});
