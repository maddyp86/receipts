import { fail, ok, type Envelope, type MatchedAction, type MatchStrength } from '@receipts/shared';
import type { ActionStore, SearchParams } from './ActionStore.js';
import { config, namespaceFor } from '../config.js';
import { SIMILARITY } from '../scoring/config.js';

// ===========================================================================
// Live retrieval against the senator's already-embedded bill vectors.
//
// PORT of WF7a `Query Pinecone`. Receipts NEVER re-embeds or re-analyses a bill
// at query time — it searches vectors the batch pipeline already produced, which
// is what keeps a query result from contradicting the senator profile
// (ADR-005, docs/adr/README.md).
//
// Metadata is read defensively: a field that should be there and isn't gets
// recorded in `missing_fields` and surfaced, never quietly defaulted into a
// value that looks like evidence.
// ===========================================================================

interface PineconeMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

const bool = (v: unknown): boolean => {
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

function strengthOf(score: number): MatchStrength {
  if (score >= SIMILARITY.STRONG) return 'STRONG';
  if (score >= SIMILARITY.WEAK) return 'WEAK';
  return 'BELOW_THRESHOLD';
}

/**
 * congress.gov permalink from the bill identifiers. Every verdict has to trace
 * to a real document, so a match we cannot link is a match we flag.
 */
function sourceUrl(md: Record<string, unknown>): string {
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

export class PineconeActionStore implements ActionStore {
  readonly kind = 'pinecone' as const;

  async search(params: SearchParams): Promise<Envelope<MatchedAction[]>> {
    const { host, apiKey, embeddingVersion } = config.pinecone;
    if (!host || !apiKey) {
      return fail({
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Pinecone is not configured (PINECONE_HOST / PINECONE_API_KEY).',
        recoverable: false,
      });
    }

    const body: Record<string, unknown> = {
      vector: params.vector,
      topK: params.topK,
      includeMetadata: true,
      includeValues: false,
      namespace: namespaceFor(params.politicianId),
    };
    // Batch runs scope to one embedding_version. A live query has no run to
    // scope to, so this is opt-in: unset searches every version, which may
    // include vectors from superseded runs.
    if (embeddingVersion) {
      body.filter = { embedding_version: { $eq: embeddingVersion } };
    }

    let payload: { matches?: PineconeMatch[] };
    try {
      const res = await fetch(`${host}/query`, {
        method: 'POST',
        headers: {
          'Api-Key': apiKey,
          'Content-Type': 'application/json',
          'X-Pinecone-API-Version': '2025-01',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return fail({
          code: 'UPSTREAM_UNAVAILABLE',
          message: `Pinecone query failed (${res.status}).`,
          recoverable: res.status >= 500 || res.status === 429,
          details: { status: res.status, body: detail.slice(0, 400) },
        });
      }
      payload = (await res.json()) as { matches?: PineconeMatch[] };
    } catch (err) {
      return fail({
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Could not reach Pinecone.',
        recoverable: true,
        details: { cause: err instanceof Error ? err.message : String(err) },
      });
    }

    const raw = payload.matches ?? [];

    // ASSERTION — embedding_version must not turn a stale constant into an
    // honest-looking "no relevant bills".
    //
    // embedding_version doubles as the run_id join key. A value that no longer
    // matches any stored vector returns ZERO matches from a namespace that is
    // in fact full, and every downstream layer renders that as "nothing in his
    // record bears on this" — a finding, not a fault. The filter is opt-in, so
    // this only fires when a version was explicitly pinned: an empty result
    // under a pin is far more likely to be a stale pin than a real absence, and
    // it must be surfaced as such rather than answered.
    if (embeddingVersion && raw.length === 0) {
      return fail({
        code: 'UPSTREAM_UNAVAILABLE',
        message:
          `Pinecone returned zero vectors for embedding_version "${embeddingVersion}". ` +
          `That is far more likely a stale version pin than an empty record — refusing ` +
          `to report it as "no relevant bills". Clear PINECONE_EMBEDDING_VERSION to ` +
          `search every version, or set it to the current run.`,
        recoverable: true,
        details: {
          embedding_version: embeddingVersion,
          namespace: namespaceFor(params.politicianId),
          topK: params.topK,
        },
      });
    }

    const matches = raw
      .map((m) => this.toMatchedAction(m))
      .filter((m) => m.score >= SIMILARITY.WEAK)
      .sort((a, b) => b.score - a.score);

    return ok(matches);
  }

  private toMatchedAction(m: PineconeMatch): MatchedAction {
    const md = m.metadata ?? {};
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
      action_uid: m.id,
      bill_id: need('bill_id', m.id),
      bill_number: str(md.bill_number) || undefined,
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

      score: m.score,
      strength: strengthOf(m.score),
      missing_fields: missing,
    };
  }
}
