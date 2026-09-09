import { createHash } from 'node:crypto';
import type { Corrections, StreamEvent } from '@receipts/shared';
import { config } from '../config.js';

// ===========================================================================
// A per-SESSION replay cache for `/api/query`.
//
// ── WHY THIS IS NOT IN QueryStore ─────────────────────────────────────────
//
// `QueryStore` enforces a rule in its shape: the only read is by id, because
// "the moment this interface can answer *what has anyone else asked about this
// senator*, it becomes possible to let that answer influence a verdict — and
// the influence would look like an ordinary feature in review."
//
// A content-addressed lookup over stored queries is exactly that read. So this
// cache does not go there and does not touch the database at all. It is process
// memory, it is scoped to one browser session, and it is discarded on restart.
//
// The scoping is STRUCTURAL, not a convention: `cacheKey` requires a session id
// and returns null without one, so no key exists that could match another
// session's entry. There is no code path that can widen it by accident — a
// future caller who forgets the session id gets no caching, never someone
// else's answer.
//
// ── WHAT IT IS ACTUALLY FOR ───────────────────────────────────────────────
//
// Not abuse; rate limiting handles that. Ordinary repetition:
//
//   - EventSource RECONNECTS BY ITSELF after a dropped stream and re-issues the
//     identical URL. Today that silently re-runs up to ~14 paid model calls.
//   - Refresh, double-submit, and back-then-rerun do the same.
//
// A correction does NOT hit this cache, and should not: corrections are part of
// the key, so a corrected query is a different question and gets a real answer.
// ===========================================================================

/** Everything that can change an answer. All of it goes into the key. */
export interface CacheKeyParts {
  /** REQUIRED. Without it there is no key, and therefore no caching at all. */
  sessionId: string | undefined;
  politicianId: string;
  promiseText: string;
  corrections?: Corrections;
  statementDate?: string;
  /**
   * Overrides the mode tag. TESTS ONLY — production never passes it, so the
   * live key always reflects the process's actual mode. It exists because mode
   * isolation is the second silent failure this cache could have, and an
   * untestable guard is not a guard.
   */
  mode?: string;
}

/**
 * Whitespace and case are not part of the question.
 *
 * "  Lower  drug PRICES " and "lower drug prices" are the same query and should
 * not cost twice. Nothing else is normalised — punctuation and wording reach
 * the embedder verbatim, so changing them really is a different query.
 */
const normalisePromise = (text: string): string =>
  text.trim().replace(/\s+/g, ' ').toLowerCase();

/** Corrections, order-independent: the same set is the same question. */
const canonicalCorrections = (c?: Corrections): string =>
  c ? JSON.stringify(Object.entries(c).sort(([a], [b]) => a.localeCompare(b))) : '';

/**
 * The mode the answer was produced in.
 *
 * Load-bearing. A fixture answer and a live answer to the same question are
 * different claims about the world, and serving one for the other would put
 * canned sample data behind a real senator's name with no banner to say so.
 */
const modeTag = (): string =>
  `${config.demoMode ? 'demo' : 'live'}:${config.fixtureMode ? 'fixture' : 'real'}`;

/**
 * The cache key, or null when there is no session to scope it to.
 *
 * Null is the safe answer and the common one for any non-browser caller: no
 * key means the query runs normally and nothing is stored.
 */
export function cacheKey(parts: CacheKeyParts): string | null {
  const sessionId = (parts.sessionId ?? '').trim();
  if (!sessionId) return null;

  // NUL-separated so no field can impersonate another by containing the
  // separator — a promise text ending in the delimiter must not be able to
  // forge a different politician id.
  const material = [
    sessionId,
    parts.politicianId.trim(),
    normalisePromise(parts.promiseText),
    canonicalCorrections(parts.corrections),
    (parts.statementDate ?? '').trim(),
    parts.mode ?? modeTag(),
  ].join('\0');

  return createHash('sha256').update(material).digest('hex');
}

interface Entry {
  events: StreamEvent[];
  expiresAt: number;
}

/**
 * Bounded, TTL'd, in-process.
 *
 * Insertion-ordered eviction (oldest first) rather than true LRU: entries live
 * minutes, so recency ranking buys nothing a plain FIFO does not.
 */
export class ResultCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs: number = config.resultCache.ttlSeconds * 1000,
    private readonly maxEntries: number = config.resultCache.maxEntries,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  /** The recorded stream, or null on a miss or an expired entry. */
  get(key: string | null, now: number = Date.now()): StreamEvent[] | null {
    if (!key) return null;
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= now) {
      this.entries.delete(key);
      return null;
    }
    // Copied on the way out so a replay cannot mutate the stored sequence.
    return [...hit.events];
  }

  set(key: string | null, events: StreamEvent[], now: number = Date.now()): void {
    if (!key || !events.length) return;

    // Re-inserting moves an existing key to the end of the eviction order,
    // which is what makes a refreshed entry outlive its neighbours.
    this.entries.delete(key);
    this.entries.set(key, { events: [...events], expiresAt: now + this.ttlMs });

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Test seam. Nothing in the request path clears the cache. */
  clear(): void {
    this.entries.clear();
  }
}

/**
 * Should this run be replayable?
 *
 * Only a run that reached a real conclusion. Two exclusions matter:
 *
 *   - an `error` run is never cached. A transient upstream failure that got
 *     stuck in a cache would become a sticky one, and the user would keep being
 *     told the same thing is broken after it had recovered.
 *   - a run with no `result` and no `halt` concluded nothing, so there is
 *     nothing to replay.
 *
 * A halt IS cacheable: it is a complete answer, and re-deciding it costs a
 * model call to reach the same conclusion.
 */
export function isCacheable(events: StreamEvent[]): boolean {
  if (events.some((e) => e.type === 'error')) return false;
  return events.some((e) => e.type === 'result' || e.type === 'halt');
}

export const resultCache = new ResultCache();
