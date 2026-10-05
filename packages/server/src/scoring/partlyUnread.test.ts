import { describe, expect, it } from 'vitest';
import { EFFECT_UNREAD, VOTE_FLAG_COPY } from '@receipts/shared';
import { scoreMatches, type ScorableMatch } from './score.js';
import { applyWithholding } from './withholding.js';

// ===========================================================================
// A VERDICT BUILT PARTLY ON BILLS NOBODY READ.
//
// #28 stopped a fully-failed read from becoming "no effect". This is the
// partial case: some bills read, some not. Decided in review, on #24's
// principle:
//   - whenever a decisive row errored, the band drops to Low;
//   - a BROKE that the unread bills could overturn is not published;
//   - a KEPT is shown, at Low — contract 3's asymmetry.
// "Could overturn" is the scorer's own dominance test (keeps >= breaks) with
// every unread row counted for the other side at its hard-evidence weight.
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
const unread = (over: Partial<ScorableMatch> = {}) => row({ bill_effect: 'ERROR', alignment_confidence: 0, ...over });
const breaking = (over: Partial<ScorableMatch> = {}) => row({ passage_vote: 'Nay', vote: 'Nay', ...over });

const run = (matches: ScorableMatch[]) =>
  scoreMatches({ promise_type: 'policy', statement_type: 'Campaign Promise', matches });

describe('a favourable reading with unread bills beside it', () => {
  it('is KEPT, at Low, and the unread row says why', () => {
    const r = run([row(), row(), unread()]);
    expect(r.verdict).toBe('KEPT');
    expect(r.band).toBe('Low');
    const flagged = r.evidence.filter((e) => e.vote_flags.includes(EFFECT_UNREAD));
    expect(flagged).toHaveLength(1);
    expect(r.receipt.trace.join(' ')).toMatch(/could not be read against the statement/);
  });

  // Two strong hard rows would be High on their own.
  it('loses a High it would otherwise have had', () => {
    expect(run([row(), row()]).band).toBe('High');
    expect(run([row(), row(), unread()]).band).toBe('Low');
  });

  it('a sponsorship whose bill went unread counts too', () => {
    const r = run([row(), row(), unread({ vote: 'NA', passage_vote: 'NA', is_cosponsor: true })]);
    expect(r.band).toBe('Low');
  });
});

describe('an accusation with unread bills beside it', () => {
  // One breaking row (0.7) against one unread row (0.7): flipped, the unread
  // row ties it, and a tie goes to keeping. It could overturn — withheld.
  it('is withheld when the unread bills could overturn it', () => {
    const r = run([breaking(), unread()]);
    expect(r.verdict).toBe('NOT_DETERMINABLE');
    expect(r.nd_reason).toBe('EVALUATION_FAILED');
    expect(r.receipt.trace.join(' ')).toMatch(/Withheld: .*could not be read/);
    expect(r.evidence).toHaveLength(2);
  });

  // Three breaking rows (2.1) against one unread row (0.6 — above the 0.575
  // evidence floor, or it would be dropped before scoring): even flipped, it
  // cannot win. The accusation stands — at Low.
  it('stands, at Low, when they could not overturn it', () => {
    const r = run([breaking(), breaking(), breaking(), unread({ score: 0.6 })]);
    expect(r.verdict).toBe('BROKE');
    expect(r.band).toBe('Low');
  });

  // A counterargument repairs a weak reading, not an unread one.
  it('is withheld even with the counterargument on the record', () => {
    const r = run([breaking(), unread()]);
    const asBroke = { ...r, verdict: 'BROKE' as const, nd_reason: null, mode: 'single' as const, band: 'Low' as const };
    expect(applyWithholding(asBroke, { counterargumentPresent: true }).result.nd_reason).toBe('EVALUATION_FAILED');
  });

  // An abstention's bill can't be decided by reading it, so it cannot
  // overturn anything (#28's exclusion).
  it('an unread abstention neither lowers the band nor withholds', () => {
    const r = run([breaking(), breaking(), unread({ vote: 'Not Voting', passage_vote: 'Not Voting' })]);
    expect(r.verdict).toBe('BROKE');
    expect(r.evidence.some((e) => e.vote_flags.includes(EFFECT_UNREAD))).toBe(false);
  });
});

describe('what does not change', () => {
  it('with every bill read, nothing moves', () => {
    const r = run([row(), row()]);
    expect(r.band).toBe('High');
    expect(r.evidence.every((e) => !e.vote_flags.includes(EFFECT_UNREAD))).toBe(true);
  });

  it('weights are identical — only the band and publication move', () => {
    const a = run([row({ action_uid: 'A' }), row({ action_uid: 'B', bill_effect: 'NEUTRAL' })]);
    const b = run([row({ action_uid: 'A' }), unread({ action_uid: 'B' })]);
    expect(b.receipt.weight_split).toEqual(a.receipt.weight_split);
  });

  it('the reader copy neither clears nor accuses', () => {
    const copy = VOTE_FLAG_COPY[EFFECT_UNREAD]!;
    expect(copy).toMatch(/couldn't read this bill/);
    expect(copy).not.toMatch(/\bkept\b|\bbroke\b|cleared|did nothing wrong/i);
  });
});
