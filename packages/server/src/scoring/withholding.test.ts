import { describe, expect, it } from 'vitest';
import type { DirectedAction, ScoredResult } from '@receipts/shared';
import { ACCUSATION_CONFIDENCE_FLOOR, applyWithholding } from './withholding.js';

// ===========================================================================
// Behavioural contract 3.
//
// An audit found 78 of 79 BROKE verdicts were false positives. This is the
// deterministic tail-catcher. It must fire on weak accusations, and must not
// fire on anything else — a guard that over-fires suppresses true findings and
// one that never fires is decoration.
// ===========================================================================

const action = (over: Partial<DirectedAction> = {}): DirectedAction =>
  ({
    action_uid: 'ACT-1',
    bill_id: 'hr1-118',
    direction: 'breaks',
    alignment_confidence: 0.5,
    bill_effect: 'HINDER',
    bill_effect_reasoning: '',
    outcome: 'BROKE',
    evidence_type: 'vote',
    action_tier: 'VOTED',
    vote_pattern: 'PASSAGE_ONLY',
    weight: 1,
    scoring_flags: [],
    vote_governing: 'PASSAGE',
    vote_flags: [],
    ...over,
  }) as unknown as DirectedAction;

const result = (verdict: ScoredResult['verdict'], evidence: DirectedAction[]): ScoredResult =>
  ({
    verdict,
    band: 'Medium',
    mode: 'single',
    nd_reason: null,
    ranked: [],
    receipt: { trace: [] },
    evidence,
  }) as unknown as ScoredResult;

describe('it withholds weak accusations', () => {
  it('downgrades a BROKE whose best supporting action is below the floor', () => {
    const r = applyWithholding(result('BROKE', [action({ alignment_confidence: 0.65 })]));
    expect(r.withheld).toBe(true);
    expect(r.result.verdict).toBe('NOT_DETERMINABLE');
    expect(r.result.nd_reason).toBe('WITHHELD_LOW_CONFIDENCE');
    expect(r.result.band).toBeNull();
  });

  it('withholds when no confidence was recorded at all', () => {
    // Fail closed. No confidence is LESS evidence than 0.65, not more — the bar
    // is "demonstrably at or above 0.7", not "not demonstrably below it".
    const r = applyWithholding(result('BROKE', [action({ alignment_confidence: null })]));
    expect(r.withheld).toBe(true);
  });

  it('keeps the evidence on screen — it withholds the verdict, not the record', () => {
    const r = applyWithholding(result('BROKE', [action({ alignment_confidence: 0.6 })]));
    expect(r.result.evidence).toHaveLength(1);
    expect(r.result.receipt.trace?.join(' ')).toMatch(/Contract 3/);
  });

  it('says why, in words safe to show', () => {
    const r = applyWithholding(result('BROKE', [action({ alignment_confidence: 0.62 })]));
    expect(r.reason).toContain('0.62');
    expect(r.reason).toContain('counterargument');
  });
});

describe('it does not over-fire', () => {
  it('leaves a well-evidenced accusation alone', () => {
    const r = applyWithholding(result('BROKE', [action({ alignment_confidence: 0.85 })]));
    expect(r.withheld).toBe(false);
    expect(r.result.verdict).toBe('BROKE');
  });

  it('uses the BEST breaking action, not the average', () => {
    // One sound action at 0.85 supports the reading even beside weak
    // corroboration. Averaging would withhold a defensible accusation, which is
    // the wrong failure direction.
    const r = applyWithholding(
      result('BROKE', [
        action({ action_uid: 'a', alignment_confidence: 0.85 }),
        action({ action_uid: 'b', alignment_confidence: 0.3 }),
        action({ action_uid: 'c', alignment_confidence: 0.4 }),
      ]),
    );
    expect(r.withheld).toBe(false);
  });

  it('never touches KEPT, at any confidence', () => {
    // The rule is asymmetric on purpose. A weak favourable reading is not the
    // output with real downside.
    const r = applyWithholding(
      result('KEPT', [action({ direction: 'keeps', alignment_confidence: 0.2 })]),
    );
    expect(r.withheld).toBe(false);
    expect(r.result.verdict).toBe('KEPT');
  });

  it('never touches NOT_DETERMINABLE', () => {
    const r = applyWithholding(result('NOT_DETERMINABLE', []));
    expect(r.withheld).toBe(false);
  });

  it('releases the accusation once a counterargument is on the record', () => {
    // The floor is not "we are unsure", it is "we have not published the reply".
    const r = applyWithholding(result('BROKE', [action({ alignment_confidence: 0.6 })]), {
      counterargumentPresent: true,
    });
    expect(r.withheld).toBe(false);
    expect(r.result.verdict).toBe('BROKE');
  });

  it('ignores confidence on non-breaking actions', () => {
    // A high-confidence KEEPS action must not license a weak accusation.
    const r = applyWithholding(
      result('BROKE', [
        action({ direction: 'keeps', alignment_confidence: 0.95 }),
        action({ action_uid: 'b', direction: 'breaks', alignment_confidence: 0.4 }),
      ]),
    );
    expect(r.withheld).toBe(true);
  });
});

describe('the floor is the documented one', () => {
  it('is 0.7, and 0.7 exactly passes', () => {
    expect(ACCUSATION_CONFIDENCE_FLOOR).toBe(0.7);
    expect(applyWithholding(result('BROKE', [action({ alignment_confidence: 0.7 })])).withheld).toBe(
      false,
    );
    expect(
      applyWithholding(result('BROKE', [action({ alignment_confidence: 0.699 })])).withheld,
    ).toBe(true);
  });
});
