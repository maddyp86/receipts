import type { NotCountedAction } from '@receipts/shared';
import type { EvaluatedCandidate } from '../evaluation/relevance.js';
import { sourceUrl } from '../data/actionRecord.js';

// ===========================================================================
// The bills the relevance check read and did not count.
//
// The evidence gate admits only bills directly about the statement. Everything
// else it read was reported to the reader as a count ("8 bills we found were
// read as being about a different subject"), so a voter saw two bills and no
// sign of the eight beside them. These rows carry no direction and no weight —
// they never reach the verdict — but they are the record around the answer,
// and the reason for each is the honest account of why it was set aside.
// ===========================================================================

const ABSENT = new Set(['', 'NA', 'N/A', 'NULL', 'UNDEFINED', 'FALSE']);
const present = (v: unknown): string => {
  const s = String(v ?? '').trim();
  return ABSENT.has(s.toUpperCase()) ? '' : s;
};

/** "Sponsored", "Cosponsored", "Voted Nay on passage" — what the senator did on this bill. */
export function actionPhrase(c: EvaluatedCandidate): string {
  if (present(c.is_sponsor)) return 'Sponsored';
  if (present(c.is_cosponsor)) return 'Cosponsored';
  const passage = present(c.passage_vote) || present(c.vote);
  if (passage) return `Voted ${passage} on passage`;
  const cloture = present(c.cloture_vote);
  if (cloture) return `Voted ${cloture} on ending debate`;
  return 'Took action';
}

/**
 * The relevance check's reasoning, with its opening bookkeeping removed.
 *
 * The check writes for the pipeline first ("This is a sponsorship action, but
 * the bill is about…"); the reader needs only the substance after it. Nothing
 * else is reworded: a paraphrase here would put our summary in front of the
 * check's own words.
 */
export function readerReason(reasoning: string): string {
  let s = String(reasoning ?? '').trim();
  // "This is a sponsorship action, but the bill…" → "The bill…"
  const joined = s.replace(/^This is (?:a|an) [^.]{0,60}?,\s*(?:but|and|so)\s+/i, '');
  if (joined !== s) s = joined;
  // "This is a sponsorship-path case because … . The promise is…" and
  // "This uses the Sponsorship Path, since … . The promise is…" → "The promise is…"
  else s = s.replace(/^This (?:is (?:a|an)|uses the) [^.]{0,160}\.\s+(?=\S)/i, '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** congress.gov link from a bill id like `s1026-118`. */
export function billUrl(billId: string): string {
  const m = /^([a-z]+)(\d+)-(\d+)$/i.exec(String(billId ?? '').trim());
  return m ? sourceUrl({ bill_type: m[1], bill_number: m[2], congress: m[3] }) : '';
}

/**
 * Every evaluated candidate the gate did not admit, once per action, related
 * ones first. A bill already counted (through another of the senator's
 * actions on it) or already shown as gated is left out, so no bill appears
 * both as evidence and as "not counted".
 */
export function buildNotCounted(
  evaluated: EvaluatedCandidate[],
  admittedUids: Set<string>,
  shownElsewhere: { bill_ids: Set<string>; action_uids: Set<string> },
): NotCountedAction[] {
  const seen = new Set<string>();
  const rows: (NotCountedAction & { score: number })[] = [];
  for (const c of evaluated) {
    const uid = String(c.action_uid ?? '');
    const bill = String(c.bill_id ?? '');
    if (!uid || seen.has(uid) || admittedUids.has(uid)) continue;
    if (shownElsewhere.action_uids.has(uid) || shownElsewhere.bill_ids.has(bill)) continue;
    seen.add(uid);
    const r = c.relevance;
    const verdict = String(r?.verdict ?? '').toUpperCase();
    const errored = r?.evaluation_status === 'ERROR' || Boolean(r?.error);
    const related = errored || verdict === 'PARTIAL' || String(r?.topic_relevant ?? '') === 'Yes';
    rows.push({
      action_uid: uid,
      bill_id: bill,
      title: String(c.bill_title ?? '') || bill,
      action: actionPhrase(c),
      tier: related ? 'related' : 'unrelated',
      reason: errored
        ? 'Our check could not read this bill against the statement, so it was not counted. Read it and judge for yourself.'
        : readerReason(r?.reasoning ?? ''),
      source_url: billUrl(bill) || undefined,
      score: Number(c.similarity_score) || 0,
    });
  }
  return rows
    .sort((a, b) => (a.tier === b.tier ? b.score - a.score : a.tier === 'related' ? -1 : 1))
    .map(({ score: _score, ...row }) => row);
}
