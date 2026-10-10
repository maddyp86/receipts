import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StreamEvent } from '@receipts/shared';
import { runQuery, withRewritten } from './loop.js';
import { config } from '../config.js';
import { traceSinks } from '../services.js';
import { resultCache } from '../data/ResultCache.js';
import { MemoryTraceSink } from '../trace/TraceStore.js';

// ===========================================================================
// INPUT CLEAN-UP, in a whole run.
//
// Demo + fixture, like every whole-run test here: no model is called and the
// stand-in fetcher answers. What is real is the wiring — where the step sits,
// what it emits, what it hands on, and that with the flag off or a statement
// in hand it is not in the path at all.
// ===========================================================================

const sink = new MemoryTraceSink();
const features = config.features as { queryCleanup: boolean };

beforeEach(() => {
  traceSinks.push(sink);
  resultCache.clear();
});
afterEach(() => {
  traceSinks.splice(traceSinks.indexOf(sink), 1);
  sink.runs.clear();
  resultCache.clear();
  features.queryCleanup = false;
});

async function run(promise: string, sessionKey?: string) {
  const events: StreamEvent[] = [];
  await runQuery('S000148', promise, (e) => events.push(e), undefined, { sessionKey });
  return events;
}
const types = (events: StreamEvent[]) => events.map((e) => e.type);
const of = <T extends StreamEvent['type']>(events: StreamEvent[], type: T) =>
  events.find((e): e is Extract<StreamEvent, { type: T }> => e.type === type);

const QUESTION = 'He said he was going to cancel student debt. Did he do that?';
const NO_SIDE = 'What is his stance on abortion?';
const STATEMENT = 'promised to cancel student debt';

describe('off (the default)', () => {
  it('ships off', () => {
    expect(config.features.queryCleanup).toBe(false);
  });

  it('a question is handled exactly as before: no rewrite, no clarify, one run', async () => {
    const events = await run(QUESTION);
    expect(types(events)).not.toContain('rewritten');
    expect(types(events)).not.toContain('clarify');
    expect(sink.runs.size).toBe(1);
    expect(of(events, 'result')?.result.interpretation.raw).toBe(QUESTION);
  });
});

describe('on', () => {
  beforeEach(() => {
    features.queryCleanup = true;
  });

  it('a statement never reaches it: same events, and no second run', async () => {
    features.queryCleanup = false;
    const before = types(await run(STATEMENT));
    sink.runs.clear();
    resultCache.clear();
    features.queryCleanup = true;
    const after = await run(STATEMENT);
    expect(types(after)).toEqual(before);
    expect(sink.runs.size).toBe(1);
  });

  describe('a question with a side is restated and checked', () => {
    it('says so right after the trace id, before any step', async () => {
      const events = await run(QUESTION);
      expect(events[0]?.type).toBe('trace');
      expect(events[1]).toEqual({ type: 'rewritten', original: QUESTION, statement: 'promised to cancel student debt' });
      expect(types(events).indexOf('step')).toBeGreaterThan(1);
    });

    it('everything after it is about the statement, not what was typed', async () => {
      const events = await run(QUESTION);
      const result = of(events, 'result')!.result;
      expect(result.interpretation.raw).toBe('promised to cancel student debt');
      expect(types(events).at(-1)).toBe('done');
    });

    it('leaves two linked runs: the clean-up, and the check it handed on to', async () => {
      const events = await run(QUESTION);
      expect(sink.runs.size).toBe(2);
      const main = sink.runs.get(of(events, 'trace')!.run_id)!;
      const cleanup = [...sink.runs.values()].find((r) => r.run.run_id !== main.run.run_id)!;

      expect(cleanup.run.status).toBe('cleanup');
      expect(cleanup.run.promise_text).toBe(QUESTION);
      expect(cleanup.steps.map((s) => s.stage)).toEqual(['REQUEST', 'CLEANUP', 'CLEANUP']);

      expect(main.run.promise_text).toBe('promised to cancel student debt');
      const request = main.steps.find((s) => s.stage === 'REQUEST')!;
      expect(request.input).toMatchObject({ rewritten_from: QUESTION, cleanup_run_id: cleanup.run.run_id });
    });

    it('an identical request in the same session replays it, rewrite included, with no new clean-up run', async () => {
      const first = await run(QUESTION, 'session-a');
      const runsAfterFirst = sink.runs.size;
      const second = await run(QUESTION, 'session-a');
      expect(second).toEqual(first);
      // The replay's own one-step run, and nothing else.
      expect(sink.runs.size).toBe(runsAfterFirst + 1);
    });
  });

  describe('a question with no side stops to ask', () => {
    it('emits the trace id, the question back to the reader, and done — nothing else', async () => {
      const events = await run(NO_SIDE);
      expect(types(events)).toEqual(['trace', 'clarify', 'done']);
      const { clarify } = of(events, 'clarify')!;
      expect(clarify.reason).toBe('SIDE_REQUIRED');
      expect(clarify.options.map((o) => o.statement)).toEqual(['supports abortion', 'opposes abortion']);
    });

    it('checks nothing: one run, closed as a clarify, with no search, score or stored query', async () => {
      const events = await run(NO_SIDE);
      expect(sink.runs.size).toBe(1);
      const record = sink.runs.get(of(events, 'trace')!.run_id)!;
      expect(record.run.status).toBe('clarify');
      const stages = record.steps.map((s) => s.stage);
      expect(stages).toEqual(['REQUEST', 'CLEANUP', 'CLARIFY']);
      for (const never of ['RETRIEVE', 'SCORE', 'PERSIST', 'RESULT']) expect(stages).not.toContain(never);
    });

    it('the option a reader taps is a statement, and runs as one', async () => {
      const { clarify } = of(await run(NO_SIDE), 'clarify')!;
      sink.runs.clear();
      const events = await run(clarify.options[0]!.statement);
      expect(types(events)).not.toContain('clarify');
      expect(types(events)).not.toContain('rewritten');
      expect(of(events, 'result')).toBeDefined();
    });
  });

  it('a question the step leaves alone goes on as typed', async () => {
    const events = await run('How did he do on healthcare?');
    expect(types(events)).not.toContain('rewritten');
    expect(types(events)).not.toContain('clarify');
    expect(of(events, 'result')?.result.interpretation.raw).toBe('How did he do on healthcare?');
  });
});

describe('a stored answer served to a reader who typed a question', () => {
  const stored: StreamEvent[] = [{ type: 'trace', run_id: 'r1' }, { type: 'done' }];
  it('gets that reader’s rewrite, after the trace id', () => {
    const rewritten = { type: 'rewritten' as const, original: 'Q?', statement: 's' };
    expect(withRewritten(stored, rewritten)).toEqual([stored[0], rewritten, stored[1]]);
  });
  it('is untouched for a reader who typed the statement', () => {
    expect(withRewritten(stored, null)).toBe(stored);
  });
});
