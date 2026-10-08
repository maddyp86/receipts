import { createHash } from 'node:crypto';
import type { Corrections, StreamEvent } from '@receipts/shared';
import { config } from '../config.js';
import { isCacheable } from './ResultCache.js';

// ===========================================================================
// ANSWER REUSE — the same senator and the same question get the same answer.
//
// Decided 2026-10-07, after the stability measurement: the pipeline samples,
// so asking twice could give two different answers, and a reader who checks
// by asking again is owed the one they were given. A stored answer is
// returned when the same senator and the same normalised question come back.
//
// ── WHY THIS IS NOT A QueryStore READ ──────────────────────────────────────
// ResultCache.ts keeps answers per session because a content lookup over
// what OTHER people asked could let their answers influence a verdict. Reuse
// is that lookup, chosen deliberately — and kept to the shape that cannot
// influence one: the stored answer is replayed WHOLE, byte for byte, or not
// at all. Nothing from it ever feeds a new computation. It lives in process
// memory, like ResultCache; a deploy empties it (and a deploy is when code
// and prompts change, so that is the right moment to forget).
//
// ── WHEN A STORED ANSWER IS NOT REUSED ─────────────────────────────────────
//   - a prompt, a model or the code changed      → `pipelineFingerprint`
//   - the mirror data changed                    → latest synced_at, read per request
//   - it is more than 24 hours old               → config.answerReuse.ttlHours
//   - the mirror version cannot be read          → no reuse, nothing stored
// And it is never stored at all if it failed, was degraded, or was withheld
// (`isReusable`).
//
// The reader is told when the answer was produced (`reused_from`).
// ===========================================================================

export interface AnswerKeyParts {
  politicianId: string;
  promiseText: string;
  corrections?: Corrections;
  statementDate?: string;
  /** Overrides the mode tag. Tests only. */
  mode?: string;
}

/** Whitespace and case are not part of the question; wording and punctuation are. */
export const normaliseQuestion = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase();

const canonicalCorrections = (c?: Corrections): string =>
  c ? JSON.stringify(Object.entries(c).sort(([a], [b]) => a.localeCompare(b))) : '';

const modeTag = (): string => `${config.demoMode ? 'demo' : 'live'}:${config.fixtureMode ? 'fixture' : 'real'}`;

/**
 * The key: senator, normalised question, corrections, statement date, mode.
 * NOT the session — that is the point. A corrected question is a different
 * question, and a demo answer is never served as a live one.
 */
export function answerKey(parts: AnswerKeyParts): string {
  const material = [
    parts.politicianId.trim(),
    normaliseQuestion(parts.promiseText),
    canonicalCorrections(parts.corrections),
    (parts.statementDate ?? '').trim(),
    parts.mode ?? modeTag(),
  ].join('\0');
  return createHash('sha256').update(material).digest('hex');
}

const WITHHELD = new Set(['WITHHELD_LOW_CONFIDENCE', 'WITHHELD_PENDING_REVIEW', 'WITHHELD_TEXT_UNAVAILABLE']);
/** Row flags that mark an answer reached while part of the evaluation failed. */
const DEGRADED_ROW_FLAGS = new Set(['EFFECT_UNREAD', 'BILL_EFFECT_ERROR']);

/**
 * May this run be stored for reuse?
 *
 * Everything `isCacheable` refuses (an error, a failed evaluation, a read of
 * the record that failed), plus:
 *   - a WITHHELD verdict — the reading was not published; reusing the
 *     withholding would freeze a "we couldn't check this" that a fresh run
 *     might settle;
 *   - a judge that withheld or could not run;
 *   - a result with any bill the evaluator failed to read (partly degraded).
 * Only a run that reached a result or a halt is reusable.
 */
export function isReusable(events: StreamEvent[]): boolean {
  if (!isCacheable(events)) return false;
  for (const e of events) {
    if (e.type !== 'result') continue;
    const r = e.result;
    if (r.scored.nd_reason && WITHHELD.has(r.scored.nd_reason)) return false;
    if (r.judge?.withheld || r.judge?.unavailable) return false;
    if (r.scored.evidence.some((x) => [...(x.scoring_flags ?? []), ...(x.vote_flags ?? [])].some((f) => DEGRADED_ROW_FLAGS.has(f)))) return false;
  }
  return true;
}

interface Entry {
  events: StreamEvent[];
  fingerprint: string;
  producedAt: string;
  runId: string | null;
  expiresAt: number;
}

export interface ReusedAnswer {
  events: StreamEvent[];
  producedAt: string;
  runId: string | null;
}

/** Bounded, TTL'd, in-process; insertion-ordered eviction like ResultCache. */
export class AnswerCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs: number = config.answerReuse.ttlHours * 3600_000,
    private readonly maxEntries: number = config.answerReuse.maxEntries,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  /**
   * The stored answer, or null. A different fingerprint — a prompt, model,
   * code or mirror change since it was produced — is a miss, and drops it.
   */
  get(key: string, fingerprint: string | null, now: number = Date.now()): ReusedAnswer | null {
    if (!fingerprint) return null;
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= now || hit.fingerprint !== fingerprint) {
      this.entries.delete(key);
      return null;
    }
    return { events: [...hit.events], producedAt: hit.producedAt, runId: hit.runId };
  }

  /** Stores a reusable run. Refuses anything `isReusable` refuses, or with no fingerprint. */
  set(key: string, events: StreamEvent[], fingerprint: string | null, now: number = Date.now()): boolean {
    if (!fingerprint || !isReusable(events)) return false;
    const runId = events.find((e): e is Extract<StreamEvent, { type: 'trace' }> => e.type === 'trace')?.run_id ?? null;
    this.entries.delete(key);
    this.entries.set(key, {
      events: [...events],
      fingerprint,
      producedAt: new Date(now).toISOString(),
      runId,
      expiresAt: now + this.ttlMs,
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return true;
  }

  /** Test seam. */
  clear(): void {
    this.entries.clear();
  }
}

/**
 * The replayed stream, with the result stamped so the reader is told when it
 * was produced. Nothing else in it changes.
 */
export function stampReused(answer: ReusedAnswer): StreamEvent[] {
  return answer.events.map((e) =>
    e.type === 'result'
      ? { ...e, result: { ...e.result, reused_from: { produced_at: answer.producedAt, run_id: answer.runId } } }
      : e,
  );
}

export const answerCache = new AnswerCache();
