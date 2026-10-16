import type { AnswerLabel, BillEffect, RecordAnswer, RecordReading, RecordRow } from '@receipts/shared';

// ===========================================================================
// The answer to a record question ("Did they vote to extend the enhanced ACA
// tax credits?"). Deterministic: no model is involved after the evaluator has
// read each bill against the action the question names.
//
// The evaluator reads the BILL only (ADVANCE: passing it does what was asked;
// HINDER: it does the opposite). This file reads the senator's votes against
// that, one stage at a time, and never merges a vote to end debate with the
// final vote: a senator can block one and join the other, and the reader is
// owed both.
// ===========================================================================

export interface AnswerInput {
  action_uid: string;
  bill_id: string;
  bill_effect: BillEffect | string;
  cloture_vote?: string | null;
  passage_vote?: string | null;
  /** The resolved primary vote. Read only when neither stage is recorded. */
  vote?: string | null;
  is_sponsor?: boolean | string | null;
  is_cosponsor?: boolean | string | null;
  /** TARGETED, REVERSAL or BROAD_VEHICLE, from the pre-evaluator gates. */
  bill_class?: string | null;
}

const isTrue = (v: unknown) => v === true || /^(true|yes|1)$/i.test(String(v ?? ''));

/** Yea / Nay / Not Voting / Present, or null when the stage has no vote. */
function voteOf(v: unknown): 'YEA' | 'NAY' | 'NOT_VOTING' | null {
  const s = String(v ?? '').trim().toUpperCase();
  if (!s || s === 'NA' || s === 'N/A' || s === 'NULL') return null;
  if (s === 'YEA' || s === 'AYE' || s === 'YES') return 'YEA';
  if (s === 'NAY' || s === 'NO') return 'NAY';
  // Not Voting and Present: the senator was there or not, and cast no side.
  return 'NOT_VOTING';
}

/**
 * One vote read against the bill's effect.
 *
 * ADVANCE + Yea = for, ADVANCE + Nay = against: the bill does what was asked.
 * HINDER flips it: a Nay on a bill that would do the opposite is a vote for.
 * This is also the Congressional Review Act rule. The evaluator reads a
 * disapproval of a rule that does X as HINDER, so a Nay (keeping the rule) is
 * a vote for X, with no special case here.
 * NEUTRAL, CONTESTED and ERROR are shown but never counted: the bill was not
 * read as doing what was asked, or could be read either way, or was not read.
 * Not voting is shown and not counted: it has explanations we cannot see.
 */
export function readVote(effect: BillEffect | string, vote: 'YEA' | 'NAY' | 'NOT_VOTING'): RecordReading {
  if (vote === 'NOT_VOTING') return 'no_vote';
  if (effect === 'ADVANCE') return vote === 'YEA' ? 'for' : 'against';
  if (effect === 'HINDER') return vote === 'YEA' ? 'against' : 'for';
  return 'not_counted';
}

/** Each action as rows: one per recorded stage, or one sponsorship row. */
export function rowsOf(a: AnswerInput): RecordRow[] {
  const effect = String(a.bill_effect ?? 'ERROR') as BillEffect;
  // A broad package (a stopgap funding bill, an omnibus) covered much more
  // than this provision. Shown, and never decides the label on its own.
  const broad = String(a.bill_class ?? '').toUpperCase() === 'BROAD_VEHICLE';
  const base = { action_uid: a.action_uid, bill_id: a.bill_id, bill_effect: effect, broad };
  const out: RecordRow[] = [];
  const cloture = voteOf(a.cloture_vote);
  const passage = voteOf(a.passage_vote);
  if (cloture) out.push({ ...base, stage: 'cloture', vote: cloture, reading: readVote(effect, cloture) });
  if (passage) out.push({ ...base, stage: 'passage', vote: passage, reading: readVote(effect, passage) });
  // The resolved vote only when neither stage says which it was.
  if (!cloture && !passage) {
    const plain = voteOf(a.vote);
    if (plain) out.push({ ...base, stage: 'vote', vote: plain, reading: readVote(effect, plain) });
  }
  // Sponsorship is its own row: weaker than a vote, and it never overrides one.
  if (isTrue(a.is_sponsor) || isTrue(a.is_cosponsor)) {
    const reading: RecordReading =
      effect === 'ADVANCE' ? 'for' : effect === 'HINDER' ? 'against' : 'not_counted';
    out.push({ ...base, stage: isTrue(a.is_sponsor) ? 'sponsor' : 'cosponsor', vote: null, reading });
  }
  return out;
}

/**
 * The label, from every row. Only votes on bills that are not broad packages
 * decide it; sponsorship decides it only when there is no such vote.
 */
export function answerLabel(actions: AnswerInput[], setAside = 0): RecordAnswer {
  const rows = actions.flatMap(rowsOf);
  const isVote = (r: RecordRow) => r.stage === 'cloture' || r.stage === 'passage' || r.stage === 'vote';
  const counted = rows.filter((r) => isVote(r) && !r.broad && (r.reading === 'for' || r.reading === 'against'));
  const broadVotes = rows.filter((r) => isVote(r) && r.broad && (r.reading === 'for' || r.reading === 'against'));
  const sponsored = rows.filter((r) => !isVote(r) && !r.broad && (r.reading === 'for' || r.reading === 'against'));

  const fors = counted.filter((r) => r.reading === 'for').length;
  const againsts = counted.filter((r) => r.reading === 'against').length;

  let label: AnswerLabel;
  let reason: RecordAnswer['reason'];
  if (counted.length) {
    // Votes on bills that do (or undo) what was asked decide it. A vote to end
    // debate one way and a final vote the other is a mixed record, not a
    // contradiction to resolve.
    label = fors && againsts ? 'MIXED_RECORD' : fors ? 'VOTED_FOR' : 'VOTED_AGAINST';
    reason = 'VOTES';
  } else if (sponsored.length) {
    // No vote on it, but their name is on a bill that would do it (or undo it).
    label = 'SPONSORSHIP_ONLY';
    reason = 'SPONSORSHIP';
  } else if (broadVotes.length) {
    // The only votes were on large packages that included this. Each one is
    // worth showing, and none says on its own how they stand on this piece.
    label = 'ONLY_BROAD_VOTES';
    reason = 'BROAD_ONLY';
  } else {
    label = 'NO_RECORDED_ACTION_FOUND';
    // "Nothing found" and "found bills, but none clearly does this" are
    // different claims, and the copy must never let the second read as the first.
    reason = rows.length || setAside ? 'NOTHING_COUNTED' : 'NOTHING_FOUND';
  }

  return { label, reason, rows, counted: { for: fors, against: againsts }, set_aside: setAside };
}
