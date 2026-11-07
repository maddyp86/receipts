import { describe, expect, it } from 'vitest';
import {
  coverageNote,
  coverageSentence,
  longDate,
  noMatchesCopy,
  notDeterminableReason,
  recordBoundarySentence,
  searchScopeSentence,
  searchSummarySentence,
  tenureOf,
  tenureSentence,
  type CoverageWindow,
  type QueryResult,
  type Senator,
} from '@receipts/shared';

// ===========================================================================
// TENURE: where the member's record starts and ends, as distinct from what we
// collected. Three members the 120th Congress (3 Jan 2027) produces, and the
// one it does not touch:
//   - Collins: lost in November 2026, leaves 3 Jan 2027. Record still here,
//     and it ENDS there.
//   - Jackson: sworn in 3 Jan 2027 (or an appointee, mid-Congress). Record
//     STARTS there; an empty search for 2025 is not "no record on this".
//   - Brown: 118th yes, 119th no, 120th yes. Nothing from the 119th is his.
//   - Schumer: served throughout. Every sentence reads as before.
// ===========================================================================

const window = (congresses: number[]): CoverageWindow => ({ congresses, observed: null, unknown: false });

const SCHUMER: Senator = { politician_id: 'S000148', name: 'Charles E. Schumer', cached: true, record_actions: 609, first_term_start: '1999-01-06', served_congresses: [118, 119, 120] };
const COLLINS: Senator = { politician_id: 'C001035', name: 'Susan M. Collins', cached: true, record_actions: 1003, first_term_start: '1997-01-07', last_term_end: '2027-01-03', left_at: '2027-01-03', served_congresses: [118, 119] };
const JACKSON: Senator = { politician_id: 'J000999', name: 'Troy Jackson', cached: true, record_actions: 12, first_term_start: '2027-06-15', served_congresses: [120] };
const BROWN: Senator = { politician_id: 'B000944', name: 'Sherrod Brown', cached: true, record_actions: 700, first_term_start: '2007-01-04', served_congresses: [118, 120] };

const result = (senator: Senator, coverage: CoverageWindow, nd: string | null = 'NO_MATCHES'): QueryResult =>
  ({
    senator,
    interpretation: { raw: 'x', restated: 'x', primary_issue: 'Health Care', sub_issue: 'x', stance: 'In Favor', statement_type: 'Policy Position', provenance: 'default', promise_type: 'policy' },
    scored: { verdict: nd ? 'NOT_DETERMINABLE' : 'KEPT', band: nd ? null : 'Medium', mode: nd ? 'not_determinable' : 'single', nd_reason: nd, ranked: [], evidence: [], receipt: {} },
    explanation: { why: '', connectors: {}, confidence: 0 },
    coverage,
    search: { returned: 0, below_floor: 0, evaluated: 0, admitted: 0, relevance_applied: true, exclusions: [] },
  }) as unknown as QueryResult;

describe('dates are read by parts', () => {
  it('"2027-01-03" is January 3, 2027 in every time zone', () => {
    expect(longDate('2027-01-03')).toBe('January 3, 2027');
    expect(longDate('2026-07-11')).toBe('July 11, 2026');
  });
  it('anything else is not a date here', () => {
    expect(longDate('')).toBeNull();
    expect(longDate(undefined)).toBeNull();
    expect(longDate('3 Jan 2027')).toBeNull();
  });
});

describe('what tenure says about each member', () => {
  it('a member who served throughout has nothing to add', () => {
    expect(tenureOf(SCHUMER, window([118, 119, 120]))).toEqual({ left_at: null, joined_after_start: null, absent: [] });
    expect(tenureSentence(SCHUMER, window([118, 119, 120]))).toBeNull();
  });

  it('a former member: the record ends the day they left', () => {
    expect(tenureOf(COLLINS, window([118, 119]))).toEqual({ left_at: '2027-01-03', joined_after_start: null, absent: [] });
    expect(tenureSentence(COLLINS, window([118, 119]))).toBe('Collins left the Senate on January 3, 2027, and their record ends there.');
  });

  it('a member who took office after our records begin: the record starts there', () => {
    expect(tenureOf(JACKSON, window([120]))).toEqual({ left_at: null, joined_after_start: '2027-06-15', absent: [] });
    expect(tenureSentence(JACKSON, window([120]))).toBe('Jackson took office on June 15, 2027, so their record starts there, not when ours does.');
  });

  it('sworn in on the first day of the first Congress we cover is not "after"', () => {
    const dayOne: Senator = { ...JACKSON, first_term_start: '2027-01-03' };
    expect(tenureOf(dayOne, window([120])).joined_after_start).toBeNull();
    expect(tenureSentence(dayOne, window([120]))).toBeNull();
  });

  it('a Congress inside the window the member did not sit in is named', () => {
    expect(tenureOf(BROWN, window([118, 120])).absent).toEqual([119]);
    expect(tenureSentence(BROWN, window([118, 120]))).toBe('Brown was not in the Senate during the 119th Congress, so nothing from then is in their record.');
  });

  it('without the record, nothing is claimed either way', () => {
    const bare: Senator = { politician_id: 'X', name: 'Some One', cached: true };
    expect(tenureOf(bare, window([118, 119]))).toEqual({ left_at: null, joined_after_start: null, absent: [] });
    expect(tenureSentence(bare, window([118, 119]))).toBeNull();
    expect(tenureOf(COLLINS, { congresses: [], observed: null, unknown: true }).absent).toEqual([]);
  });
});

describe('the coverage note carries tenure after the window', () => {
  it('the plain sentence is unchanged, and the member adds one clause', () => {
    const w = window([118, 119]);
    expect(coverageNote(w, SCHUMER)).toBe(coverageSentence(w));
    expect(coverageNote(w, COLLINS)).toBe(`${coverageSentence(w)} Collins left the Senate on January 3, 2027, and their record ends there.`);
    expect(coverageNote(w)).toBe(coverageSentence(w));
  });

  it('still never asserts what the senator did', () => {
    for (const s of [COLLINS, JACKSON, BROWN]) {
      const note = coverageNote(window([118, 119, 120]), s);
      expect(note).not.toMatch(/did nothing|never voted/i);
      // "has no record" appears only inside the denial, as in coverage.test.
      for (const m of note.matchAll(/has no record/g)) expect(note.slice(0, m.index)).toMatch(/not a finding that the senator $/);
    }
  });

  it('a Congress after they left, or before they joined, is not named as a gap as well', () => {
    // Collins left on 3 Jan 2027: the 120th is explained by that, not a gap.
    expect(tenureOf(COLLINS, window([118, 119, 120])).absent).toEqual([]);
    expect(coverageNote(window([118, 119, 120]), COLLINS)).not.toContain('was not in the Senate');
    // Jackson joined in June 2027: the 118th and 119th are before him, not gaps.
    expect(tenureOf(JACKSON, window([118, 119, 120])).absent).toEqual([]);
  });
});

describe('an empty search, said with the member’s own edges', () => {
  it('a former member: our start, then where their record ends', () => {
    expect(recordBoundarySentence(result(COLLINS, window([118, 119])))).toBe(
      'Our records start in January 2023. If they acted on this before then, it isn’t in what we searched. Collins left the Senate on January 3, 2027, and their record ends there.',
    );
    expect(noMatchesCopy(result(COLLINS, window([118, 119])))).toBe(
      "We didn't find any bills or votes that relate to this statement in this senator's analyzed record, which ends on January 3, 2027, when they left the Senate. Our search can miss things, so that isn't proof there are none.",
    );
  });

  it('a freshman: the record starts when they took office, and earlier votes happened without them', () => {
    expect(recordBoundarySentence(result(JACKSON, window([120])))).toBe(
      'Jackson took office on June 15, 2027, so their record starts there. Anything the Senate did on this before then happened without them.',
    );
    expect(noMatchesCopy(result(JACKSON, window([120])))).toContain('which only began on June 15, 2027, when they took office');
    expect(notDeterminableReason(result(JACKSON, window([120])))).toBe(noMatchesCopy(result(JACKSON, window([120]))));
  });

  it('a gap year is named on the boundary', () => {
    expect(recordBoundarySentence(result(BROWN, window([118, 120])))).toContain('Brown was not in the Senate during the 119th Congress.');
  });

  it('a member who served throughout reads exactly as before', () => {
    expect(recordBoundarySentence(result(SCHUMER, window([118, 119])))).toBe(
      'Our records start in January 2023. If they acted on this before then, it isn’t in what we searched.',
    );
    expect(noMatchesCopy(result(SCHUMER, window([118, 119])))).toBe(
      "We didn't find any bills or votes in this senator's analyzed record that relate to this statement. Our search can miss things, so that isn't proof there are none.",
    );
  });

  it('only on an empty search', () => {
    expect(recordBoundarySentence(result(COLLINS, window([118, 119]), null))).toBeNull();
  });
});

describe('what the search covered, in words', () => {
  it('served throughout: since our records start', () => {
    expect(searchScopeSentence(result(SCHUMER, window([118, 119])))).toBe('Searched all 609 of Schumer’s recorded actions since January 2023.');
  });

  it('a former member: from our start to the day they left', () => {
    expect(searchScopeSentence(result(COLLINS, window([118, 119])))).toBe(
      'Searched all 1,003 of Collins’s recorded actions from January 2023 to January 3, 2027, when they left the Senate.',
    );
    expect(searchSummarySentence(result(COLLINS, window([118, 119])))).toMatch(
      /^We searched all 1,003 of Collins’s recorded actions from January 2023 to January 3, 2027, when they left the Senate\. No bills came close/,
    );
  });

  it('a freshman: since they took office', () => {
    expect(searchScopeSentence(result(JACKSON, window([120])))).toBe('Searched all 12 of Jackson’s recorded actions since they took office on June 15, 2027.');
  });

  it('never says the member did nothing', () => {
    for (const s of [COLLINS, JACKSON, BROWN]) {
      expect(searchSummarySentence(result(s, window([118, 119, 120])))).not.toMatch(/did nothing|no record|never/i);
    }
  });
});
