import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QueryResult, StreamEvent } from '@receipts/shared';
import { AnswerCache, answerCache, answerKey, isReusable, normaliseQuestion, stampReused } from './AnswerCache.js';
import { resultCache } from './ResultCache.js';
import { config } from '../config.js';
import { runQuery } from '../orchestrator/loop.js';
import { pipelineFingerprint } from '../orchestrator/pipelineFingerprint.js';
import { traceSinks } from '../services.js';
import { MemoryTraceSink } from '../trace/TraceStore.js';

// ===========================================================================
// ANSWER REUSE.
//
// The same senator and the same normalised question get the stored answer,
// until a prompt / model / code change, a mirror-data change, or 24 hours.
// Failed, degraded and withheld answers are never stored. The reader is told
// when the answer was produced.
// ===========================================================================

const result = (over: Partial<QueryResult['scored']> = {}, extra: Partial<QueryResult> = {}): StreamEvent =>
  ({
    type: 'result',
    result: {
      scored: { verdict: 'KEPT', band: 'Medium', nd_reason: null, evidence: [], ...over },
      ...extra,
    },
  }) as unknown as StreamEvent;
const trace: StreamEvent = { type: 'trace', run_id: 'run-1' } as StreamEvent;
const done: StreamEvent = { type: 'done' } as StreamEvent;
const run = (...events: StreamEvent[]) => [trace, ...events, done];

describe('the question', () => {
  const k = (promiseText: string, over = {}) => answerKey({ politicianId: 'S000148', promiseText, mode: 'live:real', ...over });

  it('case and spacing are not part of it', () => {
    expect(normaliseQuestion('  Lower  Drug PRICES ')).toBe('lower drug prices');
    expect(k('  Lower  Drug PRICES ')).toBe(k('lower drug prices'));
  });

  it('wording and punctuation are', () => {
    expect(k('lower drug prices')).not.toBe(k('lower drug prices.'));
    expect(k('lower drug prices')).not.toBe(k('cut drug prices'));
  });

  it('the senator, corrections, statement date and mode are', () => {
    const base = k('x');
    expect(k('x', { politicianId: 'T000250' })).not.toBe(base);
    expect(k('x', { corrections: { stance: 'Opposed' } })).not.toBe(base);
    expect(k('x', { statementDate: '2024-01-01' })).not.toBe(base);
    expect(k('x', { mode: 'demo:fixture' })).not.toBe(base);
  });

  it('the session is not', () => {
    // There is no session field at all: that is the difference from ResultCache.
    expect(answerKey({ politicianId: 'S000148', promiseText: 'x', mode: 'live:real' })).toBe(k('x'));
  });
});

describe('what is never stored', () => {
  it.each([
    ['an error', run({ type: 'error', error: { code: 'INTERNAL', message: 'x', recoverable: true } } as StreamEvent)],
    ['a failed evaluation', run(result({ verdict: 'NOT_DETERMINABLE', nd_reason: 'EVALUATION_FAILED' }))],
    ['a degraded read of the record', run(result({}, { enrichment_gaps: ['vote_records'] }))],
    ['a low-confidence withholding', run(result({ verdict: 'NOT_DETERMINABLE', nd_reason: 'WITHHELD_LOW_CONFIDENCE' }))],
    ['a review withholding', run(result({ verdict: 'NOT_DETERMINABLE', nd_reason: 'WITHHELD_PENDING_REVIEW' }))],
    ['a missing-text withholding', run(result({ verdict: 'NOT_DETERMINABLE', nd_reason: 'WITHHELD_TEXT_UNAVAILABLE' }))],
    ['a judge that withheld', run(result({}, { judge: { disposition: 'REVIEW_REQUIRED', withheld: true } as never }))],
    ['a judge that could not run', run(result({}, { judge: { disposition: 'JUDGE_ERROR', withheld: false, unavailable: true } as never }))],
    ['a bill the evaluator failed to read', run(result({ evidence: [{ scoring_flags: ['BILL_EFFECT_ERROR'], vote_flags: [] }] as never }))],
    ['a run that concluded nothing', run()],
  ])('%s', (_name, events) => {
    expect(isReusable(events)).toBe(false);
    expect(new AnswerCache().set('k', events, 'fp')).toBe(false);
  });

  it('a clean answer is stored, and so is a halt', () => {
    expect(isReusable(run(result()))).toBe(true);
    expect(isReusable(run({ type: 'halt', halt: { reason: 'NON_TESTABLE_SPEECH_ACT' } } as StreamEvent))).toBe(true);
  });
});

describe('when a stored answer is not reused', () => {
  const T0 = Date.UTC(2026, 9, 8, 4, 0);
  const H = 3600_000;

  it('within 24 hours, same pipeline and mirror: reused', () => {
    const c = new AnswerCache(24 * H);
    c.set('k', run(result()), 'p1|m1', T0);
    expect(c.get('k', 'p1|m1', T0 + 23 * H)).not.toBeNull();
  });

  it('after 24 hours regardless', () => {
    const c = new AnswerCache(24 * H);
    c.set('k', run(result()), 'p1|m1', T0);
    expect(c.get('k', 'p1|m1', T0 + 24 * H)).toBeNull();
  });

  it('after a prompt, model or code change', () => {
    const c = new AnswerCache(24 * H);
    c.set('k', run(result()), 'p1|m1', T0);
    expect(c.get('k', 'p2|m1', T0 + H)).toBeNull();
    // And it is gone, not merely skipped.
    expect(c.get('k', 'p1|m1', T0 + H)).toBeNull();
  });

  it('after the mirror data changes', () => {
    const c = new AnswerCache(24 * H);
    c.set('k', run(result()), 'p1|m1', T0);
    expect(c.get('k', 'p1|m2', T0 + H)).toBeNull();
  });

  it('when the mirror version could not be read: neither served nor stored', () => {
    const c = new AnswerCache(24 * H);
    expect(c.set('k', run(result()), null, T0)).toBe(false);
    c.set('k', run(result()), 'p1|m1', T0);
    expect(c.get('k', null, T0 + H)).toBeNull();
  });

  it('the TTL defaults to 24 hours', () => {
    expect(config.answerReuse.ttlHours).toBe(24);
  });
});

describe('the reader is told when it was produced', () => {
  it('stamps the result with the time and run that produced it, and nothing else', () => {
    const c = new AnswerCache();
    const T = Date.UTC(2026, 9, 8, 4, 12);
    c.set('k', run(result()), 'fp', T);
    const out = stampReused(c.get('k', 'fp', T + 1000)!);
    const r = out.find((e) => e.type === 'result') as Extract<StreamEvent, { type: 'result' }>;
    expect(r.result.reused_from).toEqual({ produced_at: '2026-10-08T04:12:00.000Z', run_id: 'run-1' });
    // Every other event replays unchanged, including the original trace id.
    expect(out.filter((e) => e.type !== 'result')).toEqual([trace, done]);
  });
});

describe('the fingerprint', () => {
  it('is stable within a process', () => {
    expect(pipelineFingerprint()).toBe(pipelineFingerprint());
    expect(pipelineFingerprint()).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('through runQuery (demo mode, reuse enabled for this block)', () => {
  const sink = new MemoryTraceSink();
  // config is typed read-only; the suite turns reuse off (vitest.config.ts)
  // and this block turns it on for itself.
  const reuse = config.answerReuse as { enabled: boolean };
  const enabled = reuse.enabled;

  beforeEach(() => {
    reuse.enabled = true;
    answerCache.clear();
    resultCache.clear();
    traceSinks.push(sink);
  });
  afterEach(() => {
    reuse.enabled = enabled;
    answerCache.clear();
    traceSinks.splice(traceSinks.indexOf(sink), 1);
    sink.runs.clear();
  });

  async function ask(politicianId: string, promise: string) {
    const events: StreamEvent[] = [];
    await runQuery(politicianId, promise, (e) => events.push(e));
    const res = events.find((e): e is Extract<StreamEvent, { type: 'result' }> => e.type === 'result');
    return { events, result: res?.result };
  }

  it('the second asking of the same question gets the stored answer, stamped', async () => {
    const first = await ask('S000148', 'Lower prescription drug prices.');
    expect(first.result).toBeDefined();
    expect(first.result!.reused_from).toBeUndefined();

    const second = await ask('S000148', '  lower PRESCRIPTION drug prices. ');
    expect(second.result!.reused_from?.run_id).toBe(first.events.find((e) => e.type === 'trace')!.run_id);
    expect(second.result!.scored).toEqual(first.result!.scored);
    // Logged as a reuse, with no model call.
    const reuseRun = [...sink.runs.values()].find((r) => r.steps.some((s) => s.stage === 'ANSWER_REUSE'));
    expect(reuseRun).toBeDefined();
  });

  it('another senator, or another question, is a fresh run', async () => {
    await ask('S000148', 'Lower prescription drug prices.');
    expect((await ask('T000250', 'Lower prescription drug prices.')).result!.reused_from).toBeUndefined();
    expect((await ask('S000148', 'Cut prescription drug prices.')).result!.reused_from).toBeUndefined();
  });
});
