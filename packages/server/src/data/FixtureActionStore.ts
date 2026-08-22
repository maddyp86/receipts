import { ok, type Envelope, type MatchedAction, type MatchStrength } from '@receipts/shared';
import type { ActionStore, SearchParams, SearchResult } from './ActionStore.js';
import { FIXTURE_ACTIONS, type FixtureAction } from './fixtures/actions.js';
import { SIMILARITY } from '../scoring/config.js';

// ===========================================================================
// Fixture retrieval.
//
// Stands in for Pinecone so the slice is playable with no credentials. It scores
// lexically rather than semantically — a deliberate stand-in, not an attempt to
// reimplement embeddings.
//
// The scores it produces are mapped into the SAME band structure the live store
// uses (WEAK floor 0.50, STRONG floor 0.575), so every downstream gate, band and
// honest state is exercised for real. What is fake is which bills come back;
// what is real is everything that happens to them afterwards.
// ===========================================================================

const STOP_WORDS = new Set([
  'promise',
  'stance',
  'type',
  'primary',
  'issue',
  'sub',
  'key',
  'policy',
  'terms',
  'related',
  'reasoning',
  'the',
  'a',
  'an',
  'to',
  'of',
  'and',
  'or',
  'in',
  'on',
  'for',
  'will',
  'would',
  'that',
  'this',
  'with',
  'is',
  'are',
  'be',
  'by',
  'at',
  'from',
  'favor',
  'opposed',
  'neutral',
  'unclear',
  'i',
  'we',
  'they',
  'he',
  'she',
  'senator',
  'promised',
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9-]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 2 && !STOP_WORDS.has(t)),
  );
}

/**
 * Map lexical overlap onto a plausible cosine range.
 *
 * Zero overlap lands at 0.42 — below the WEAK floor, so an unrelated promise
 * genuinely returns nothing and the NOT_DETERMINABLE path is real rather than
 * simulated. Full overlap approaches 0.90, which is about where a strong
 * semantic match sits in the live index.
 */
function lexicalScore(queryTokens: Set<string>, action: FixtureAction): number {
  const terms = action.match_terms;
  if (!terms.length) return 0;

  let hits = 0;
  for (const term of terms) if (queryTokens.has(term)) hits += 1;

  // Also credit issue-level agreement, which the query text carries explicitly.
  const issueHit =
    queryTokens.has(action.primary_issue.toLowerCase()) ||
    action.sub_issue
      .toLowerCase()
      .split(/\s+/)
      .some((w) => w.length > 3 && queryTokens.has(w));

  const ratio = hits / terms.length;
  const boosted = Math.min(1, ratio * 1.6 + (issueHit ? 0.18 : 0));
  return Number.parseFloat((0.42 + 0.48 * boosted).toFixed(4));
}

function strengthOf(score: number): MatchStrength {
  if (score >= SIMILARITY.STRONG) return 'STRONG';
  if (score >= SIMILARITY.WEAK) return 'WEAK';
  return 'BELOW_THRESHOLD';
}

export class FixtureActionStore implements ActionStore {
  readonly kind = 'fixture' as const;

  async search(params: SearchParams): Promise<Envelope<SearchResult>> {
    const queryTokens = tokenize(params.queryText);

    const all = FIXTURE_ACTIONS.filter((a) => a.politician_id === params.politicianId)
      .map((action) => {
        const score = lexicalScore(queryTokens, action);
        const { match_terms, politician_id, ...rest } = action;
        return { ...rest, score, strength: strengthOf(score) } satisfies MatchedAction;
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, params.topK);

    // Same floor the live store applies, so "nothing close enough" is a real
    // outcome here rather than something only the live path can produce — and
    // the pre-filter counts are reported the same way, so a fixture run
    // diagnoses identically to a live one.
    const matches = all.filter((m) => m.score >= SIMILARITY.WEAK);

    return ok({
      matches,
      returned: all.length,
      belowFloor: all.length - matches.length,
      topScore: all[0]?.score ?? null,
    });
  }
}
