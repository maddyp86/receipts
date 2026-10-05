import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { textVersionLines } from '@receipts/shared';
import { governingActOf, isMotionToProceed, selectTextVersion, type VersionMirrorRow } from './textVersions.js';
import { buildFollowupContext } from '../followup/followup.js';
import type { TraceRecord } from '../trace/TraceStore.js';
import type { TraceStep } from '../trace/Trace.js';

// ===========================================================================
// CLOTURE ON A MOTION TO PROCEED IS DATED BY THE LATER PASSAGE VOTE.
//
// Found in the first live end-to-end run. hr5334-119, both senators:
//   cloture 7/28/2026  "Motion to Invoke Cloture on the Motion to Proceed to
//                       H.R. 5334" — the text was still the educator deduction
//   passage 8/7/2026   "On Passage of the Bill H.R. 5334" — the sanctions
//                       substitute, adopted on the floor in between
// Cloture governs the verdict (fix/06), so Task 3 dated the text by it and a
// sanctions statement was read against an educator tax deduction. Decided in
// review: when cloture was on a motion to proceed AND a later passage vote
// exists, the text is dated by passage; with no later passage vote, cloture
// stands. The verdict is still governed by cloture. Live rows, live questions.
// ===========================================================================

const FIXTURE = fileURLToPath(new URL('./fixtures/gutAndAmendVersions.json', import.meta.url));
const HR5334: VersionMirrorRow[] = JSON.parse(readFileSync(FIXTURE, 'utf8')).rows.filter(
  (r: VersionMirrorRow) => r.bill_id === 'hr5334-119',
);

/** Verbatim from mirror_roll_call_votes, s212-119.2026 and s224-119.2026. */
const MTP_QUESTION = 'Motion to Invoke Cloture on the Motion to Proceed to H.R. 5334';
const MTP_RESULT = 'Cloture on the Motion to Proceed Agreed to';

const thune = {
  vote: 'Yea', cloture_vote: 'Yea', passage_vote: 'Yea',
  cloture_vote_date: '7/28/2026', passage_vote_date: '8/7/2026',
  is_sponsor: 'false', is_cosponsor: 'false',
  cloture_vote_question: MTP_QUESTION,
};

describe('hr5334-119, as the live mirror holds it', () => {
  it('dates the text by passage, and the sanctions version is what gets read', () => {
    const act = governingActOf(thune)!;
    expect(act).toEqual({ kind: 'CLOTURE', date: '2026-08-07', dated_by: 'PASSAGE', dating_reason: 'CLOTURE_ON_MOTION_TO_PROCEED' });
    const s = selectTextVersion(HR5334, act)!;
    expect(s.disclosure.code).toBe('eas');
    // The verdict is still the cloture vote's.
    expect(s.disclosure.governed_by).toBe('CLOTURE');
    expect(s.disclosure.dated_by).toBe('PASSAGE');
    expect(s.disclosure.dating_reason).toBe('CLOTURE_ON_MOTION_TO_PROCEED');
  });

  // The same votes, dated by cloture as before: the educator deduction.
  it('without the rule, it would have read the educator deduction', () => {
    const s = selectTextVersion(HR5334, governingActOf({ ...thune, cloture_vote_question: null }))!;
    expect(s.disclosure.code).toBe('pcs');
    expect(s.disclosure.dated_by).toBe('CLOTURE');
    expect(s.disclosure.dating_reason).toBeNull();
  });

  it('tells the reader which date picked the text, and why', () => {
    const lines = textVersionLines(selectTextVersion(HR5334, governingActOf(thune))!.disclosure);
    expect(lines[0]).toBe(
      'The deciding cloture vote was on a motion to begin debating the bill, so the text is taken from the later vote on passage (August 7, 2026).',
    );
    expect(lines[1]).toBe('Judged against the text in effect at that vote: the version as amended by the Senate (August 7, 2026).');
  });
});

describe('when the rule applies', () => {
  it('reads the question and the result alike', () => {
    expect(isMotionToProceed(MTP_QUESTION)).toBe(true);
    expect(isMotionToProceed(MTP_RESULT)).toBe(true);
    expect(isMotionToProceed('motion to invoke cloture on the motion to proceed to S. 1')).toBe(true);
  });

  it.each([
    'Motion to Invoke Cloture on the Bill H.R. 5334',
    'Motion to Invoke Cloture on Amendment No. 2101',
    'On Passage of the Bill H.R. 5334',
    '',
    null,
  ])('not for %s', (q) => {
    expect(isMotionToProceed(q)).toBe(false);
    expect(governingActOf({ ...thune, cloture_vote_question: q })!.dated_by ?? 'CLOTURE').toBe('CLOTURE');
  });

  // No later passage vote: the cloture date stands.
  it('keeps the cloture date when there is no passage vote', () => {
    expect(governingActOf({ ...thune, passage_vote: 'NA', passage_vote_date: 'NA' })).toEqual({ kind: 'CLOTURE', date: '2026-07-28' });
  });

  it('keeps the cloture date when the passage vote is not later', () => {
    expect(governingActOf({ ...thune, passage_vote_date: '7/28/2026' })!.date).toBe('2026-07-28');
    expect(governingActOf({ ...thune, passage_vote_date: '7/1/2026' })!.date).toBe('2026-07-28');
  });

  // "A later passage vote exists" — the roll call happened, whatever this
  // senator's own vote on it. The text they took up is the text that passed.
  it('applies even when the senator did not vote on passage', () => {
    expect(governingActOf({ ...thune, passage_vote: 'Not Voting' })!.date).toBe('2026-08-07');
  });

  it('cannot place it with no cloture date', () => {
    expect(governingActOf({ ...thune, cloture_vote_date: 'NA' })).toEqual({ kind: 'CLOTURE', date: null });
  });

  // Only the governing CLOTURE vote is redated. Without one, passage governs
  // and dates itself as before.
  it('changes nothing when cloture does not govern', () => {
    expect(governingActOf({ ...thune, cloture_vote: 'Not Voting' })).toEqual({ kind: 'PASSAGE', date: '2026-08-07' });
  });
});

describe('the follow-up assistant', () => {
  it('can say the text was dated by passage, and why', () => {
    const step = (over: Partial<TraceStep>): TraceStep => ({
      run_id: 'r', seq: 1, at: '2026-10-04T00:00:00Z', duration_ms: null, stage: 'TEXT_VERSION', kind: 'deterministic',
      status: 'ok', subject: 'ACT-hr5334-119-T000250', label: 'hr5334-119', model: null, prompt_version: null,
      prompt_sha256: null, usage: null, input: null, output: null, error: null, ...over,
    });
    const record: TraceRecord = {
      run: { run_id: '33333333-3333-3333-3333-333333333333', started_at: '2026-10-04T00:00:00Z', ended_at: null, status: 'result', politician_id: 'T000250', promise_text: 'Sanction Russia.', query_id: null, meta: {} },
      steps: [step({ output: selectTextVersion(HR5334, governingActOf(thune))!.disclosure })],
    };
    expect(buildFollowupContext(record)).toContain(
      'the deciding cloture vote was on the motion to proceed, so the text was dated by the passage vote (2026-08-07)',
    );
  });
});
