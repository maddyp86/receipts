import { describe, expect, it } from 'vitest';
import { ND_REASON_COPY, type EnrichmentGap } from '@receipts/shared';
import { scoreMatches, type ScorableMatch } from './score.js';
import {
  DECISIVE_ENRICHMENT_GAPS,
  RECORD_UNREAD,
  applyWithholding,
  withholdForUnreadRecord,
} from './withholding.js';

// ===========================================================================
// A VERDICT REACHED WHILE PART OF THE RECORD COULD NOT BE READ.
//
// #30 made a failed enrichment read visible. Decided in review of #30:
//   - any failed read drops the band to Low — the checks that needed it failed
//     open, so the band claims more scrutiny than the result had;
//   - a BROKE is withheld when the failed read decides the text or a gate.
//     Vote and sponsorship dates pick the version of a gut-and-amend bill the
//     action is judged against; roll-call context (cloture result, whip vote,
//     role) opens and closes G2/G3; the versions are the text itself;
//   - a KEPT shows, at Low — contract 3's asymmetry;
//   - bill progress is presentation only, so its failure lowers the band but
//     never withholds.
// ===========================================================================

let uid = 0;
function row(over: Partial<ScorableMatch> = {}): ScorableMatch {
  uid += 1;
  return {
    action_uid: `ACT-${uid}`, bill_id: `s${uid}-119`, title: 'A bill', summary: 'S.', intended_effects: 'E.',
    mechanisms: 'M.', action_type: 'voted', is_sponsor: false, is_cosponsor: false, vote: 'Yea',
    cloture_vote: 'NA', passage_vote: 'Yea', bill_keywords: [], primary_issue: 'x', sub_issue: 'y', source_url: '',
    score: 0.7, strength: 'STRONG', missing_fields: [], bill_effect: 'ADVANCE', bill_effect_reasoning: 'r',
    alignment_confidence: 0.9,
    ...over,
  } as ScorableMatch;
}
const breaking = (over: Partial<ScorableMatch> = {}) => row({ passage_vote: 'Nay', vote: 'Nay', ...over });

const run = (matches: ScorableMatch[], enrichment_gaps?: EnrichmentGap[]) =>
  scoreMatches({ promise_type: 'policy', statement_type: 'Campaign Promise', matches, enrichment_gaps });

const ALL: EnrichmentGap[] = ['vote_records', 'roll_call_context', 'bill_progress', 'text_versions'];

describe('the band', () => {
  // Two strong hard rows are High on their own.
  it.each(ALL)('a failed %s read lowers a High to Low', (gap) => {
    expect(run([row(), row()]).band).toBe('High');
    const r = run([row(), row()], [gap]);
    expect(r.verdict).toBe('KEPT');
    expect(r.band).toBe('Low');
    expect(r.receipt.trace.join(' ')).toMatch(new RegExp(`could not be read \\(${gap}\\)`));
  });

  it('a contested record drops to Low too, on both sides', () => {
    const r = run([row(), row(), breaking()], ['vote_records']);
    expect(r.mode).toBe('ranked');
    expect(r.ranked.map((e) => e.band)).toEqual(['Low', 'Low']);
  });

  // Not a weight and not a direction.
  it('moves no weight', () => {
    const a = run([row(), breaking()]);
    const b = run([row(), breaking()], ['vote_records']);
    expect(b.evidence.map((e) => [e.weight, e.direction])).toEqual(a.evidence.map((e) => [e.weight, e.direction]));
  });

  it('no gap, no change', () => {
    expect(run([row(), row()], []).band).toBe('High');
  });
});

describe('an accusation', () => {
  it.each(['vote_records', 'roll_call_context', 'text_versions'] as EnrichmentGap[])(
    'is withheld when the %s read failed',
    (gap) => {
      expect(run([breaking()]).verdict).toBe('BROKE');
      const r = run([breaking()], [gap]);
      expect(r.verdict).toBe('NOT_DETERMINABLE');
      expect(r.nd_reason).toBe('EVALUATION_FAILED');
      expect(r.receipt.scoring_flags).toContain(RECORD_UNREAD);
      expect(r.receipt.trace.join(' ')).toMatch(/Withheld: .*could not be read for this answer/);
      // Withholding the verdict is not hiding the record.
      expect(r.evidence).toHaveLength(1);
    },
  );

  // Tier, stage and committee never reach a verdict, so their absence cannot
  // have changed one.
  it('stands, at Low, when only bill progress failed', () => {
    const r = run([breaking(), breaking()], ['bill_progress']);
    expect(r.verdict).toBe('BROKE');
    expect(r.band).toBe('Low');
  });

  it('a dominant accusation on a contested record is withheld', () => {
    const r = run([breaking(), breaking(), row()], ['roll_call_context']);
    expect(r.verdict).toBe('NOT_DETERMINABLE');
    expect(r.nd_reason).toBe('EVALUATION_FAILED');
  });

  // A counterargument repairs a weak reading, not an incomplete check.
  it('is withheld even with the counterargument on the record', () => {
    const scored = run([breaking()]);
    const out = applyWithholding(scored, { counterargumentPresent: true, enrichmentGaps: ['vote_records'] });
    expect(out.withheld).toBe(true);
    expect(out.result.nd_reason).toBe('EVALUATION_FAILED');
  });
});

describe('a favourable reading', () => {
  it.each(ALL)('is shown, at Low, when the %s read failed', (gap) => {
    const r = run([row()], [gap]);
    expect(r.verdict).toBe('KEPT');
    expect(r.band).toBe('Low');
  });

  it('withholdForUnreadRecord passes it through', () => {
    const scored = run([row()]);
    expect(withholdForUnreadRecord(scored, ['vote_records']).withheld).toBe(false);
  });
});

describe('which reads decide', () => {
  it('everything but bill progress', () => {
    expect([...DECISIVE_ENRICHMENT_GAPS].sort()).toEqual(['roll_call_context', 'text_versions', 'vote_records']);
  });

  // The judge's own read (dispatch) uses the same function on a BROKE.
  it('the judge-read path withholds the same way', () => {
    const scored = run([breaking()]);
    const out = withholdForUnreadRecord(scored, ['vote_records']);
    expect(out.withheld).toBe(true);
    expect(out.result.receipt.scoring_flags).toContain(RECORD_UNREAD);
    expect(withholdForUnreadRecord(scored, ['bill_progress']).withheld).toBe(false);
    expect(withholdForUnreadRecord(scored, []).withheld).toBe(false);
  });
});

describe("the reader's words", () => {
  // EVALUATION_FAILED now covers a failed record read as well as a failed
  // bill read. It must not claim the bills were unread when they were read.
  it('names both kinds of failure without claiming which', () => {
    const copy = ND_REASON_COPY.EVALUATION_FAILED;
    expect(copy).toMatch(/couldn't finish checking/);
    expect(copy).toMatch(/reading the bills against this statement, or reading the part of the record/);
    expect(copy).toMatch(/says nothing about the senator/);
  });

  it('the withholding reason names the parts that failed in plain words', () => {
    const out = withholdForUnreadRecord(run([breaking()]), ['vote_records', 'text_versions']);
    expect(out.reason).toMatch(/the dates of the senator's votes and sponsorships; which version of each bill's text was in effect/);
    expect(out.reason).not.toMatch(/vote_records|text_versions/);
  });
});
