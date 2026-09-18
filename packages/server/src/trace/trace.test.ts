import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_STRING,
  QueryTrace,
  bound,
  currentTrace,
  traceBegin,
  traceStep,
  withTrace,
} from './Trace.js';
import type { TraceSink } from './Trace.js';
import { CompositeTraceReader, FileTraceSink, MemoryTraceSink, parseJsonl } from './TraceStore.js';

// ===========================================================================
// The recorder's contract. Three things matter more than the rest:
//
//   1. Outside a run, every helper is a no-op. Every existing unit test calls
//      into modules that now record — and none of them may start failing or
//      writing files because a trace was not opened.
//   2. A sink failure never propagates. The trace is for us, not the user.
//   3. Nothing in a payload can grow without bound. A truncated field says so.
// ===========================================================================

const open = (sinks: readonly TraceSink[] = []) =>
  new QueryTrace(sinks, { politicianId: 'S000148', promiseText: 'A promise.' });

describe('QueryTrace records in order', () => {
  it('numbers steps from zero and stamps the run id on each', () => {
    const t = open();
    t.record({ stage: 'REQUEST', kind: 'control', label: 'a' });
    t.record({ stage: 'DONE', kind: 'control', label: 'b' });
    expect(t.steps.map((s) => s.seq)).toEqual([0, 1]);
    expect(new Set(t.steps.map((s) => s.run_id))).toEqual(new Set([t.runId]));
  });

  it('defaults status to ok and nulls every optional field', () => {
    const [s] = [open().record({ stage: 'SCORE', kind: 'deterministic', label: 'x' })];
    expect(s!.status).toBe('ok');
    expect(s!.subject).toBeNull();
    expect(s!.model).toBeNull();
    expect(s!.usage).toBeNull();
    expect(s!.prompt_sha256).toBeNull();
    expect(s!.error).toBeNull();
    expect(s!.duration_ms).toBeNull();
  });

  it('hashes the prompt text and never stores it', () => {
    const s = open().record({
      stage: 'JUDGE_MODEL', kind: 'model', label: 'x', prompt_text: 'SYSTEM PROMPT TEXT',
    });
    expect(s.prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(s)).not.toContain('SYSTEM PROMPT TEXT');
  });

  it('measures a timed step', async () => {
    const t = open();
    const end = t.begin();
    await new Promise((r) => setTimeout(r, 5));
    const s = end({ stage: 'EMBED', kind: 'io', label: 'x' });
    expect(s.duration_ms).toBeGreaterThanOrEqual(4);
  });
});

describe('payloads are bounded', () => {
  it('truncates a long string with a marker that says how much was dropped', () => {
    const long = 'x'.repeat(MAX_STRING + 500);
    const cut = bound(long) as string;
    expect(cut.length).toBeLessThan(long.length);
    expect(cut).toMatch(/…\[truncated 500 chars\]$/);
  });

  it('bounds strings nested inside objects and arrays, and drops undefined', () => {
    const v = bound({ a: [{ b: 'y'.repeat(MAX_STRING + 1) }], c: undefined, d: 1 }) as Record<string, unknown>;
    expect((v.a as Array<{ b: string }>)[0]!.b).toMatch(/truncated 1 chars/);
    expect('c' in v).toBe(false);
    expect(v.d).toBe(1);
  });

  it('leaves a short string alone', () => {
    expect(bound('short')).toBe('short');
  });
});

describe('outside a run, recording is a no-op', () => {
  it('has no ambient trace', () => {
    expect(currentTrace()).toBeUndefined();
    expect(traceStep({ stage: 'SCORE', kind: 'deterministic', label: 'x' })).toBeUndefined();
    expect(traceBegin()({ stage: 'SCORE', kind: 'deterministic', label: 'x' })).toBeUndefined();
  });

  it('inside withTrace, the same helpers record against that trace', async () => {
    const t = open();
    await withTrace(t, async () => {
      expect(currentTrace()).toBe(t);
      traceStep({ stage: 'SCORE', kind: 'deterministic', label: 'inside' });
      // Survives an await: the whole point of AsyncLocalStorage over a global.
      await Promise.resolve();
      traceBegin()({ stage: 'DONE', kind: 'control', label: 'after await' });
    });
    expect(t.steps.map((s) => s.label)).toEqual(['inside', 'after await']);
    expect(currentTrace()).toBeUndefined();
  });
});

describe('close flushes every sink, and a failing sink is contained', () => {
  it('writes the run and steps to each sink', async () => {
    const a = new MemoryTraceSink();
    const b = new MemoryTraceSink();
    const t = open([a, b]);
    t.record({ stage: 'REQUEST', kind: 'control', label: 'x' });
    t.setQueryId('11111111-1111-1111-1111-111111111111');
    await t.close('result');
    for (const sink of [a, b]) {
      const rec = sink.runs.get(t.runId)!;
      expect(rec.run.status).toBe('result');
      expect(rec.run.query_id).toBe('11111111-1111-1111-1111-111111111111');
      expect(rec.run.ended_at).not.toBeNull();
      expect(rec.steps).toHaveLength(1);
    }
  });

  it('does not throw when a sink throws, and still writes the others', async () => {
    const bad = { kind: 'bad', write: async () => { throw new Error('disk on fire'); } };
    const good = new MemoryTraceSink();
    const t = open([bad, good]);
    await expect(t.close('error')).resolves.toBeUndefined();
    expect(good.runs.has(t.runId)).toBe(true);
  });

  it('closes once — a second close is ignored', async () => {
    const sink = new MemoryTraceSink();
    const t = open([sink]);
    await t.close('result');
    await t.close('error');
    expect(sink.runs.get(t.runId)!.run.status).toBe('result');
  });
});

describe('FileTraceSink', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a run through JSONL, by run id', async () => {
    dir = await mkdtemp(join(tmpdir(), 'receipts-trace-'));
    const sink = new FileTraceSink(dir, 10);
    const t = open([sink]);
    t.record({ stage: 'REQUEST', kind: 'control', label: 'first', input: { promise: 'x' } });
    t.record({ stage: 'RESULT', kind: 'control', label: 'last', output: { verdict: 'KEPT' } });
    await t.close('result');

    const names = await readdir(dir);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(new RegExp(`_${t.runId}\\.jsonl$`));

    const back = await sink.get(t.runId);
    expect(back?.run.run_id).toBe(t.runId);
    expect(back?.steps.map((s) => s.label)).toEqual(['first', 'last']);
    expect((back?.steps[1]?.output as { verdict: string }).verdict).toBe('KEPT');
  });

  it('returns null for an unknown or malformed id rather than scanning', async () => {
    dir = await mkdtemp(join(tmpdir(), 'receipts-trace-'));
    const sink = new FileTraceSink(dir, 10);
    expect(await sink.get('not-a-uuid')).toBeNull();
    expect(await sink.get('11111111-1111-1111-1111-111111111111')).toBeNull();
  });

  it('prunes to maxFiles, oldest first', async () => {
    dir = await mkdtemp(join(tmpdir(), 'receipts-trace-'));
    const sink = new FileTraceSink(dir, 2);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const t = open([sink]);
      ids.push(t.runId);
      await t.close('result');
      // Distinct start times, so the name sort is deterministic.
      await new Promise((r) => setTimeout(r, 3));
    }
    expect(await readdir(dir)).toHaveLength(2);
    expect(await sink.get(ids[0]!)).toBeNull();
    expect(await sink.get(ids[2]!)).not.toBeNull();
  });

  it('parses a file with a torn last line rather than losing the run', async () => {
    dir = await mkdtemp(join(tmpdir(), 'receipts-trace-'));
    const sink = new FileTraceSink(dir, 10);
    const t = open([sink]);
    t.record({ stage: 'REQUEST', kind: 'control', label: 'x' });
    await t.close('result');
    const [name] = await readdir(dir);
    const text = await readFile(join(dir, name!), 'utf8');
    const torn = parseJsonl(`${text}{"type":"step","seq":`);
    expect(torn?.steps).toHaveLength(1);
  });
});

describe('CompositeTraceReader', () => {
  it('returns the first hit and skips a reader that throws', async () => {
    const boom = { kind: 'boom', get: async () => { throw new Error('down'); } };
    const mem = new MemoryTraceSink();
    const t = open([mem]);
    await t.close('result');
    const reader = new CompositeTraceReader([boom, mem]);
    expect((await reader.get(t.runId))?.run.run_id).toBe(t.runId);
    expect(await reader.get('22222222-2222-2222-2222-222222222222')).toBeNull();
  });
});
