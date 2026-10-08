import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ND_REASON_COPY, judgeDispositionSentence, type ScoredResult } from '@receipts/shared';
import { applyDispositionToResult, applyJudgeVerdict, forDisplay } from './dispositions.js';
import type { JudgeVerdict } from './judge.js';
import { buildAuditEvents } from '../orchestrator/loop.js';
import type { QuerySession } from '../orchestrator/dispatch.js';

// ===========================================================================
// A BROKE THE JUDGE REFUTES IS NEVER PUBLISHED.
//
// Live trace 2026-10-07 (fixture below, verbatim): Schumer, "promised to
// protect clean air standards from rollback". The evaluator read sjres31-119
// as ADVANCE, so a NAY became BROKE · Low. The judge FAILED it — T4,
// BILL_EFFECT_INVERTED — and corrected it to CONSISTENT @ 0.65. The page then
// showed BROKE · Low under "What you see is the corrected reading", and the
// audit log recorded verdict_after CONSISTENT. Three different claims; the
// one on screen was the one the review had rejected.
//
// applyJudgeVerdict is the WF13 port: there, a FAIL corrected to a
// non-accusation is "not withheld" because the row becomes the correction.
// applyDispositionToResult tested that flag, so the original BROKE fell
// through. Decided 2026-10-07: the query tool withholds — it never publishes
// the refuted accusation, and never publishes the judge's correction as ours.
// ===========================================================================

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/cleanAirJudgeCorrected.json', import.meta.url)), 'utf8'),
) as {
  run_id: string;
  scored: ScoredResult;
  judge_verdict: JudgeVerdict;
  disposition_as_published: { disposition: string; verdict: string; withheld: boolean };
};

const lead = FIXTURE.scored.evidence[0]!;
const row = { verdict: lead.outcome, confidence: lead.alignment_confidence ?? null, reasoning: 'evaluator reasoning' };
const disposition = applyJudgeVerdict(row, FIXTURE.judge_verdict);

describe('the clean-air trace', () => {
  it('is what it was: a BROKE the judge failed and corrected to CONSISTENT', () => {
    expect(FIXTURE.scored.verdict).toBe('BROKE');
    expect(FIXTURE.judge_verdict.grade).toBe('FAIL');
    expect(FIXTURE.judge_verdict.failure_class).toBe('BILL_EFFECT_INVERTED');
    expect(disposition.disposition).toBe('REVIEW_REQUIRED_JUDGE_CORRECTED');
    expect(disposition.verdict).toBe('CONSISTENT');
    // The WF13 sense of "withheld": the correction is not an accusation.
    expect(disposition.withheld).toBe(false);
    expect(FIXTURE.disposition_as_published.withheld).toBe(false);
  });

  it('is now withheld, not published', () => {
    const judged = applyDispositionToResult(FIXTURE.scored, disposition);
    expect(judged.withheld).toBe(true);
    expect(judged.result.verdict).toBe('NOT_DETERMINABLE');
    expect(judged.result.band).toBeNull();
    expect(judged.result.nd_reason).toBe('WITHHELD_PENDING_REVIEW');
    // Withholding the verdict is not hiding the record.
    expect(judged.result.evidence).toHaveLength(FIXTURE.scored.evidence.length);
  });

  // "Do not publish the judge's corrected verdict as ours."
  it("does not publish the judge's correction as the verdict either", () => {
    const judged = applyDispositionToResult(FIXTURE.scored, disposition);
    expect(judged.result.verdict).not.toBe('KEPT');
    expect(judged.result.verdict).not.toBe('BROKE');
  });
});

describe('the page and the audit log match what is shown', () => {
  const shown = forDisplay(disposition);

  it('the record kept for display is the withheld one, with the correction beside it', () => {
    expect(shown.withheld).toBe(true);
    expect(shown.verdict).toBe('NOT_DETERMINABLE');
    expect(shown.judge_corrected_verdict).toBe('CONSISTENT');
    expect(shown.model_verdict).toBe(row.verdict);
  });

  it('the sentence on the page says nothing is published, and claims no corrected reading on screen', () => {
    const s = judgeDispositionSentence(shown.disposition)!;
    expect(s).toMatch(/we are not publishing it/);
    expect(s).not.toMatch(/What you see is the corrected reading/);
    // Shown in place of the withheld-pending-review copy, so it must be as
    // non-exculpatory as that copy.
    expect(s).not.toMatch(/\bkept\b|\bconsistent\b|cleared/i);
    expect(ND_REASON_COPY.WITHHELD_PENDING_REVIEW).toBeTruthy();
  });

  it('the audit log records WITHHELD and NOT_DETERMINABLE, with the correction in detail', () => {
    const session = {
      politicianId: 'S000148',
      promiseText: 'promised to protect clean air standards from rollback',
      judge: { verdict: FIXTURE.judge_verdict, disposition: shown },
    } as unknown as QuerySession;
    const e = buildAuditEvents(session, 'q-1').find((x) => x.stage === 'JUDGE')!;
    expect(e.disposition).toBe('WITHHELD');
    expect(e.verdict_after).toBe('NOT_DETERMINABLE');
    expect(e.verdict_before).toBe(row.verdict);
    expect((e.detail as Record<string, unknown>).judge_corrected_verdict).toBe('CONSISTENT');
  });
});

describe('what does not change', () => {
  const base = { ...FIXTURE.judge_verdict };

  it('a PASS still publishes the accusation', () => {
    const d = applyJudgeVerdict(row, { ...base, grade: 'PASS', failed_test: '', failure_class: '', corrected_verdict: '' });
    expect(applyDispositionToResult(FIXTURE.scored, d).withheld).toBe(false);
    expect(forDisplay(d)).toBe(d);
  });

  it('a FAIL with no correction is still withheld', () => {
    const d = applyJudgeVerdict(row, { ...base, corrected_verdict: '' });
    expect(d.disposition).toBe('REVIEW_REQUIRED');
    expect(applyDispositionToResult(FIXTURE.scored, d).withheld).toBe(true);
  });

  it('a FAIL corrected to another accusation is still withheld', () => {
    const d = applyJudgeVerdict(row, { ...base, corrected_verdict: 'BROKE' });
    expect(applyDispositionToResult(FIXTURE.scored, d).withheld).toBe(true);
  });

  it('a judge that could not run still withholds', () => {
    const d = applyJudgeVerdict(row, { ...base, grade: 'ERROR', failure_class: 'JUDGE_NO_OUTPUT', corrected_verdict: '' });
    expect(applyDispositionToResult(FIXTURE.scored, d).withheld).toBe(true);
  });

  it('a non-accusation is never touched', () => {
    const kept = { ...FIXTURE.scored, verdict: 'KEPT' } as ScoredResult;
    expect(applyDispositionToResult(kept, disposition).withheld).toBe(false);
  });
});
