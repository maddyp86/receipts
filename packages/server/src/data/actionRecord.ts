import type { MatchedAction, MatchStrength } from '@receipts/shared';
import type { SearchResult } from './ActionStore.js';
import { SIMILARITY, NEAR_MISS_REVIEW_LIMIT } from '../scoring/config.js';

// ===========================================================================
// One searched action, from the record a live store returns, and the search
// result built from all of them.
//
// Split out of the Pinecone store when it was removed (2026-10-14): the
// Supabase store builds a record keyed as the bill-embedding workflow (WF6)
// keyed Pinecone metadata and hands it here, so the floor, the counts and the
// missing-field rules stayed one piece of code across the cut-over.
//
// Fields are read defensively: a field that should be there and isn't gets
// recorded in `missing_fields` and surfaced, never quietly defaulted into a
// value that looks like evidence.
// ===========================================================================

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

/** Exported for the sheet-flag regression test; see evaluation/sheetFlags.test.ts. */
export const bool = (v: unknown): boolean => {
  const t = str(v).toUpperCase();
  return v === true || t === 'TRUE' || t === 'YES' || t === '1';
};

/** Metadata may store keyword lists as arrays or as a delimited string. */
const list = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(str).filter(Boolean);
  const s = str(v);
  if (!s) return [];
  return s
    .split(/[;,|]/)
    .map((x) => x.trim())
    .filter(Boolean);
};

export function strengthOf(score: number): MatchStrength {
  // The card's wording line, not the evidence floor: see SIMILARITY.CLOSE.
  if (score >= SIMILARITY.CLOSE) return 'STRONG';
  if (score >= SIMILARITY.WEAK) return 'WEAK';
  return 'BELOW_THRESHOLD';
}

/**
 * congress.gov permalink from the bill identifiers. Every verdict has to trace
 * to a real document, so a match we cannot link is a match we flag.
 */
export function sourceUrl(md: Record<string, unknown>): string {
  const explicit = str(md.source_url) || str(md.url) || str(md.congress_url);
  if (explicit) return explicit;

  const congress = str(md.congress).replace(/\D/g, '');
  const type = str(md.bill_type).toLowerCase();
  const number = str(md.bill_number).replace(/\D/g, '');
  if (!congress || !type || !number) return '';

  const slug: Record<string, string> = {
    hr: 'house-bill',
    s: 'senate-bill',
    hjres: 'house-joint-resolution',
    sjres: 'senate-joint-resolution',
    hconres: 'house-concurrent-resolution',
    sconres: 'senate-concurrent-resolution',
    hres: 'house-resolution',
    sres: 'senate-resolution',
  };
  const path = slug[type];
  return path ? `https://www.congress.gov/bill/${congress}th-congress/${path}/${number}` : '';
}

/**
 * The search result from every action the backend returned: floor applied,
 * pre-floor counts kept, near misses named.
 *
 * Shared by every live store, so the floor and the counts cannot drift apart
 * between them.
 */
export function searchResultOf(returned: MatchedAction[], label: string, topK: number): SearchResult {
  const all = [...returned].sort((a, b) => b.score - a.score);
  const matches = all.filter((m) => m.score >= SIMILARITY.WEAK);

  // Logged as well as returned: when a query comes back empty this is the
  // first thing anyone will want, and it should not require a database read.
  console.info(
    `[retrieval] ${label} topK=${topK} ` +
      `returned=${all.length} aboveFloor=${matches.length} ` +
      `belowFloor=${all.length - matches.length} ` +
      `topScore=${all[0]?.score?.toFixed(3) ?? 'n/a'}`,
  );

  return {
    matches,
    returned: all.length,
    belowFloor: all.length - matches.length,
    topScore: all[0]?.score ?? null,
    nearMisses: all
      .filter((m) => m.score < SIMILARITY.WEAK)
      .map((m) => ({
        action_uid: m.action_uid,
        bill_id: String(m.bill_id ?? ''),
        title: String(m.title ?? ''),
        score: m.score,
      })),
    reviewable: all
      .filter((m) => m.score < SIMILARITY.WEAK && m.score >= SIMILARITY.REVIEW)
      .slice(0, NEAR_MISS_REVIEW_LIMIT),
  };
}

/**
 * One returned action, from fields named as the bill-embedding workflow (WF6)
 * named them in Pinecone metadata. SupabaseActionStore builds that record from
 * `core` and passes it here.
 */
export function toMatchedAction(id: string, score: number, md: Record<string, unknown>): MatchedAction {
  const missing: string[] = [];

  /** Read a field, recording its absence rather than defaulting silently. */
  const need = (key: string, fallback = ''): string => {
    const v = str(md[key]);
    if (!v) missing.push(key);
    return v || fallback;
  };

  // The three vote fields are distinct. 'NA' is the upstream convention for
  // "no such vote was recorded" and is NOT the same as an abstention, so it is
  // preserved rather than normalised away here — deriveAlignment decides.
  //
  // These commonly read 'NA' in current vectors: the bill-embedding step was
  // not writing them as of 2026-08-07. Their absence is expected rather than
  // exceptional, so it is not counted as missing metadata.
  const vote = str(md.vote) || 'NA';
  const cloture = str(md.cloture_vote) || 'NA';
  const passage = str(md.passage_vote) || 'NA';

  const url = sourceUrl(md);
  if (!url) missing.push('source_url');

  const keywords = list(md.bill_keywords);
  if (!keywords.length) missing.push('bill_keywords');

  return {
    action_uid: id,
    bill_id: need('bill_id', id),
    bill_number: str(md.bill_number) || undefined,
    // Drives the OBSERVED coverage window. Read defensively: a vector
    // embedded before the field existed simply has no congress, which is
    // 'unknown', not zero.
    congress: Number.parseInt(String(md.congress ?? ''), 10) || undefined,
    bill_type: str(md.bill_type) || undefined,
    title: need('title', 'Untitled action'),
    summary: need('summary'),
    intended_effects: need('intended_effects'),
    mechanisms: need('mechanisms'),
    affected_stakeholders: str(md.affected_stakeholders) || undefined,

    action_type: str(md.action_type) || 'unknown',
    is_sponsor: bool(md.is_sponsor),
    is_cosponsor: bool(md.is_cosponsor),

    vote,
    cloture_vote: cloture,
    passage_vote: passage,

    bill_keywords: keywords,
    primary_issue: str(md.primary_issue),
    sub_issue: str(md.sub_issue),
    source_url: url,

    score,
    strength: strengthOf(score),
    missing_fields: missing,
  };
}
