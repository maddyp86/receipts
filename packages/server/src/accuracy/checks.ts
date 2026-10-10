import { evidenceTallySentence, type Direction, type QueryResult } from '@receipts/shared';

// ===========================================================================
// THE ACCURACY SET — the checks, pure.
//
// One case is a statement, a senator, and the outcomes signed off for them
// (docs/eval/cases.json). A run of the real query path produces a result;
// these functions say whether it meets the case, check by check:
//
//   1. VERDICT     the outcome is one of the allowed ones
//   2. MUST-HAVE   the listed bills are in the evidence: not gated out, not
//                  below the floor
//   3. DIRECTION   each listed bill counts the way the case says
//   4. FORBIDDEN   none of the listed failure conditions occurred
//
// Counts and band are checked only when a case sets them. Extra bills are
// reported, never failed on: search can surface more than the case lists.
// tools/eval.mts runs the cases; this file decides nothing about running.
// ===========================================================================

export type CaseDirection = 'consistent' | 'runs_counter' | 'not_counted' | 'any';
export type VerdictToken =
  | 'KEPT' | 'KEPT_MIXED' | 'BROKE' | 'BROKE_MIXED' | 'BROKE_JUDGED' | 'WITHHELD_AFTER_REVIEW' | 'NOT_DETERMINABLE';
export type ForbiddenToken = 'BROKE_WITHOUT_JUDGE' | 'TALLY_ON_NOT_DETERMINABLE' | 'TALLY_SHOWN' | 'DID_NOTHING_WORDING';

export type MustHave =
  /** A list of directions means any one of them passes. */
  | { bill: string; direction: CaseDirection | CaseDirection[]; outcome?: string }
  | { any_of: string[]; min: number; direction: CaseDirection };

export type Forbidden =
  | ForbiddenToken
  | { bill_direction: { bill: string; direction: CaseDirection } }
  /** This text must not appear on the rendered card (case-insensitive). */
  | { text: string };

export interface EvalCase {
  id: string;
  senator: string;
  statement: string;
  verdict: VerdictToken[];
  /** When the answer is NOT_DETERMINABLE, its reason must be one of these. */
  nd_reasons?: string[];
  band?: string;
  flag_band?: string[];
  count?: { total?: number; consistent?: number; runs_counter?: number; not_counted?: number };
  must_have: MustHave[];
  forbidden?: Forbidden[];
  note?: string;
}

export interface CheckResult {
  pass: boolean;
  detail: string[];
}

export interface CaseReport {
  verdict: CheckResult;
  must_have: CheckResult;
  direction: CheckResult;
  forbidden: CheckResult;
  /** Band and count, when the case sets them. Folded into VERDICT's pass. */
  flags: string[];
  /** Bills in the evidence the case does not mention. */
  extra_bills: string[];
  /** How each listed bill was read, for the report. */
  readings: Record<string, string>;
  pass: boolean;
}

const WORD: Record<Direction, Exclude<CaseDirection, 'any'>> = {
  keeps: 'consistent',
  breaks: 'runs_counter',
  neutral: 'not_counted',
};

const norm = (bill: string) => bill.trim().toLowerCase();

/** The verdict tokens this result satisfies. */
export function verdictTokens(r: QueryResult): VerdictToken[] {
  const s = r.scored;
  const out: VerdictToken[] = [];
  if (s.verdict === 'KEPT') out.push(s.mode === 'ranked' ? 'KEPT_MIXED' : 'KEPT');
  if (s.verdict === 'BROKE') {
    out.push(s.mode === 'ranked' ? 'BROKE_MIXED' : 'BROKE');
    if (publishedAfterReview(r)) out.push('BROKE_JUDGED');
  }
  if (s.verdict === 'NOT_DETERMINABLE') {
    out.push('NOT_DETERMINABLE');
    // "After review": the judge ran and declined it. A judge that could not
    // run (unavailable) withheld nothing after review.
    if (s.nd_reason === 'WITHHELD_PENDING_REVIEW' && r.judge && !r.judge.unavailable) out.push('WITHHELD_AFTER_REVIEW');
  }
  return out;
}

const publishedAfterReview = (r: QueryResult) =>
  Boolean(r.judge && !r.judge.withheld && !r.judge.unavailable && r.judge.disposition && r.judge.counterargument);

/** The verdict as the report prints it. */
export function verdictLabel(r: QueryResult): string {
  const s = r.scored;
  if (s.verdict === 'NOT_DETERMINABLE') {
    return `NOT_DETERMINABLE · ${s.nd_reason ?? 'no reason'}${r.judge ? ` · judge ${r.judge.disposition}` : ''}`;
  }
  return `${s.verdict}${s.mode === 'ranked' ? ' (mixed)' : ''}${r.judge ? ` · judge ${r.judge.disposition}${r.judge.withheld ? ' withheld' : ''}` : ''}`;
}

/**
 * Wording that says or implies the senator did nothing, or that the search
 * was complete. Sentences that state the opposite ("is not a finding that
 * the senator has no record", "isn't proof there are none") are the guard
 * itself, and are skipped.
 */
const DID_NOTHING = /\b(did nothing|done nothing|has no record|have no record|no record (on|of)|never (voted|acted|did|supported|sponsored)|took no action|failed to act|hasn['’]t (done|acted)|nothing to (show|lower|address)|every (bill|vote|action) (he|she|they)|complete record|full record)\b/i;
const NEGATED = /(not a finding|isn['’]t proof|not proof|can miss|may not be)/i;

export function didNothingSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => DID_NOTHING.test(s) && !NEGATED.test(s));
}

/**
 * Check one result against its case. `readerText` is the Level-1 card as a
 * reader sees it (rendered by the caller), for the wording check.
 */
export function checkCase(c: EvalCase, r: QueryResult, readerText: string): CaseReport {
  const evidence = new Map(r.scored.evidence.map((e) => [norm(e.bill_id), e]));
  const gated = new Map((r.gated ?? []).map((g) => [norm(g.bill_id), g]));
  const readings: Record<string, string> = {};
  const describe = (bill: string): string => {
    const e = evidence.get(norm(bill));
    if (e) return `${WORD[e.direction]} (${e.outcome})`;
    const g = gated.get(norm(bill));
    if (g) return `gated (${g.gate})`;
    return 'not in evidence';
  };

  // 1. VERDICT, plus band and count when the case sets them.
  const tokens = verdictTokens(r);
  const verdictOk = c.verdict.some((v) => tokens.includes(v)) &&
    (!c.nd_reasons || r.scored.verdict !== 'NOT_DETERMINABLE' || c.nd_reasons.includes(r.scored.nd_reason ?? ''));
  const verdictDetail = [`got ${verdictLabel(r)}; allowed ${c.verdict.join(' | ')}`];
  const flags: string[] = [];
  let bandOk = true;
  if (c.band && r.scored.band !== c.band) {
    bandOk = false;
    verdictDetail.push(`band ${r.scored.band ?? 'none'}, expected ${c.band}`);
  }
  if (c.flag_band?.includes(r.scored.band ?? '')) flags.push(`band is ${r.scored.band} (flagged, not failed)`);
  let countOk = true;
  if (c.count) {
    const got = {
      total: r.scored.evidence.length,
      consistent: r.scored.evidence.filter((e) => e.direction === 'keeps').length,
      runs_counter: r.scored.evidence.filter((e) => e.direction === 'breaks').length,
      not_counted: r.scored.evidence.filter((e) => e.direction === 'neutral').length,
    };
    for (const [k, want] of Object.entries(c.count) as Array<[keyof typeof got, number]>) {
      if (got[k] !== want) {
        countOk = false;
        verdictDetail.push(`${k} ${got[k]}, expected ${want}`);
      }
    }
  }
  const verdict: CheckResult = { pass: verdictOk && bandOk && countOk, detail: verdictDetail };

  // 2 and 3. MUST-HAVE and DIRECTION.
  const mh: string[] = [];
  const dir: string[] = [];
  let mhOk = true;
  let dirOk = true;
  const directionMatches = (bill: string, want: CaseDirection | CaseDirection[], outcome?: string) => {
    const e = evidence.get(norm(bill));
    if (!e) return false;
    const wants = Array.isArray(want) ? want : [want];
    if (!wants.includes('any') && !wants.includes(WORD[e.direction])) return false;
    return !outcome || e.outcome === outcome;
  };
  for (const m of c.must_have) {
    if ('bill' in m) {
      readings[m.bill] = describe(m.bill);
      if (!evidence.has(norm(m.bill))) {
        mhOk = false;
        mh.push(`${m.bill}: ${readings[m.bill]}`);
        continue;
      }
      if (!directionMatches(m.bill, m.direction, m.outcome)) {
        dirOk = false;
        dir.push(`${m.bill}: ${readings[m.bill]}, expected ${[m.direction].flat().join(' or ')}${m.outcome ? ` (${m.outcome})` : ''}`);
      }
    } else {
      for (const b of m.any_of) readings[b] = describe(b);
      const present = m.any_of.filter((b) => evidence.has(norm(b)));
      const matching = present.filter((b) => directionMatches(b, m.direction));
      if (present.length < m.min) {
        mhOk = false;
        mh.push(`${present.length} of ${m.any_of.length} present, need ${m.min}`);
      }
      if (matching.length < m.min) {
        dirOk = false;
        dir.push(`${matching.length} of ${m.any_of.length} ${m.direction}, need ${m.min}`);
      }
    }
  }
  // A bill missing from the evidence cannot have its direction checked; the
  // failure is MUST-HAVE's, and DIRECTION says so rather than passing it.
  if (!mhOk && dirOk && c.must_have.some((m) => 'bill' in m && !evidence.has(norm(m.bill)))) {
    dirOk = false;
    dir.push('not checked: a listed bill is missing');
  }

  // 4. FORBIDDEN.
  const fb: string[] = [];
  const tally = evidenceTallySentence(r);
  const nd = r.scored.verdict === 'NOT_DETERMINABLE';
  for (const f of c.forbidden ?? []) {
    if (typeof f === 'object' && 'text' in f) {
      if (readerText.toLowerCase().includes(f.text.toLowerCase())) fb.push(`text on the card: "${f.text}"`);
      continue;
    }
    if (typeof f === 'object') {
      const { bill, direction } = f.bill_direction;
      if (direction !== 'any' && directionMatches(bill, direction)) fb.push(`${bill} counted as ${direction}`);
      continue;
    }
    if (f === 'BROKE_WITHOUT_JUDGE' && r.scored.verdict === 'BROKE' && !publishedAfterReview(r)) {
      fb.push('BROKE published without a judge disposition and counterargument');
    }
    if (f === 'TALLY_ON_NOT_DETERMINABLE' && nd && tally) fb.push(`count line on a not-determinable answer: "${tally}"`);
    if (f === 'TALLY_SHOWN' && tally) fb.push(`count line shown: "${tally}"`);
    if (f === 'DID_NOTHING_WORDING') {
      for (const s of didNothingSentences(readerText)) fb.push(`wording: "${s}"`);
    }
  }
  const forbidden: CheckResult = { pass: fb.length === 0, detail: fb };

  const listed = new Set<string>();
  for (const m of c.must_have) ('bill' in m ? [m.bill] : m.any_of).forEach((b) => listed.add(norm(b)));
  for (const f of c.forbidden ?? []) if (typeof f === 'object' && 'bill_direction' in f) listed.add(norm(f.bill_direction.bill));
  const extra_bills = r.scored.evidence
    .filter((e) => !listed.has(norm(e.bill_id)))
    .map((e) => `${e.bill_id} ${WORD[e.direction]}`);

  const must_have: CheckResult = { pass: mhOk, detail: mh };
  const direction: CheckResult = { pass: dirOk, detail: dir };
  return {
    verdict,
    must_have,
    direction,
    forbidden,
    flags,
    extra_bills,
    readings,
    pass: verdict.pass && must_have.pass && direction.pass && forbidden.pass,
  };
}
