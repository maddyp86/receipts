import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StreamEvent } from '@receipts/shared';
import { runQuery } from './loop.js';
import { traceSinks } from '../services.js';
import { resultCache } from '../data/ResultCache.js';
import { MemoryTraceSink } from '../trace/TraceStore.js';
import type { TraceStage } from '../trace/Trace.js';

// ===========================================================================
// A whole run, traced end to end.
//
// The suite runs with no credentials, so this is the DEMO + FIXTURE path: no
// model is called, retrieval is canned, and the stubs stand in for the
// judgements. What is real is everything that happens to the candidates
// afterwards — the gates, the scorer, the judge policy, persistence — and
// that is what this asserts the trace records, in order, with a decision on
// every line.
//
// Cheap to run and the one test that would catch a gate silently going
// unrecorded: the unit tests above prove the recorder works, this proves the
// pipeline actually calls it.
// ===========================================================================

const sink = new MemoryTraceSink();

beforeEach(() => {
  traceSinks.push(sink);
  resultCache.clear();
});
afterEach(() => {
  traceSinks.splice(traceSinks.indexOf(sink), 1);
  sink.runs.clear();
  resultCache.clear();
});

async function run(politicianId: string, promise: string, sessionKey?: string) {
  const events: StreamEvent[] = [];
  await runQuery(politicianId, promise, (e) => events.push(e), undefined, { sessionKey });
  const traceEvent = events.find((e): e is Extract<StreamEvent, { type: 'trace' }> => e.type === 'trace');
  const record = traceEvent ? sink.runs.get(traceEvent.run_id) : undefined;
  return { events, traceEvent, record };
}

describe('a demo run leaves a full trace', () => {
  it('announces the run id as the FIRST event of the stream', async () => {
    const { events, traceEvent } = await run('S000148', 'Lower prescription drug prices.');
    expect(events[0]?.type).toBe('trace');
    expect(traceEvent?.run_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('records every gate the context passed through, in order', async () => {
    const { record } = await run('S000148', 'Lower prescription drug prices.');
    expect(record).toBeDefined();
    const stages = record!.steps.map((s) => s.stage);

    // The spine of the pipeline. Each of these is a gate the answer depends
    // on; a missing one here means a gate went dark.
    const spine: TraceStage[] = [
      'REQUEST', 'CLASSIFY', 'INTERPRET', 'RESOLVE_SENATOR', 'EMBED', 'RETRIEVE',
      'EVIDENCE_GATE', 'SEARCH', 'ENRICHMENT', 'SCORE', 'JUDGE', 'EVALUATE_EFFECTS',
      'EXPLAIN_CHECK', 'EXPLAIN', 'RESULT', 'PERSIST', 'DONE',
    ];
    let cursor = -1;
    for (const stage of spine) {
      const at = stages.indexOf(stage, cursor + 1);
      expect(at, `${stage} missing or out of order in [${stages.join(', ')}]`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('says plainly which legs did NOT run, rather than omitting them', async () => {
    const { record } = await run('S000148', 'Lower prescription drug prices.');
    const byStage = (stage: TraceStage) => record!.steps.filter((s) => s.stage === stage);

    // No OpenAI key: the evidence gate is skipped and labelled, not silent.
    expect(byStage('EVIDENCE_GATE')[0]?.status).toBe('skipped');
    expect(byStage('EVIDENCE_GATE')[0]?.label).toMatch(/UNCHECKED/);
    // No enrichment source: the gates failed open, and the trace says so.
    expect(byStage('ENRICHMENT')[0]?.status).toBe('skipped');
    // The judge either was not consulted (not an accusation) or had no
    // credential (accusation withheld). Either way it is a step with a reason.
    const judge = byStage('JUDGE')[0];
    expect(judge).toBeDefined();
    expect(['skipped', 'error']).toContain(judge!.status);
    // No DATABASE_URL: persistence is a skipped step, not an absent one.
    expect(byStage('PERSIST')[0]?.status).toBe('skipped');
    expect(byStage('PERSIST')[0]?.label).toMatch(/DATABASE_URL/);
  });

  it('carries the decision on every line', async () => {
    const { record } = await run('S000148', 'Lower prescription drug prices.');
    for (const s of record!.steps) {
      expect(s.label, `${s.stage} has an empty label`).not.toBe('');
    }
  });

  it('records one PRE_EVALUATOR_GATE step per candidate, with the candidate as subject', async () => {
    const { record } = await run('S000148', 'Lower prescription drug prices.');
    const retrieve = record!.steps.find((s) => s.stage === 'RETRIEVE')!;
    const above = (retrieve.output as { above_floor: number }).above_floor;
    const gates = record!.steps.filter((s) => s.stage === 'PRE_EVALUATOR_GATE');
    expect(gates).toHaveLength(above);
    for (const g of gates) expect(g.subject).toBeTruthy();
  });

  it('puts the embedded text and the scorer inputs where a reader can find them', async () => {
    const { record } = await run('S000148', 'Lower prescription drug prices.');
    const classify = record!.steps.find((s) => s.stage === 'CLASSIFY')!;
    expect((classify.output as { embedding_text: string }).embedding_text).toContain('Lower prescription drug prices');
    const score = record!.steps.find((s) => s.stage === 'SCORE')!;
    const out = score.output as { verdict: string };
    expect(['KEPT', 'BROKE', 'NOT_DETERMINABLE']).toContain(out.verdict);
    const result = record!.steps.find((s) => s.stage === 'RESULT')!;
    expect((result.output as { scored: { verdict: string } }).scored.verdict).toBe(out.verdict);
  });

  it('closes the run with the same conclusion the stream reached', async () => {
    const { record, events } = await run('S000148', 'Lower prescription drug prices.');
    expect(events.some((e) => e.type === 'result')).toBe(true);
    expect(record!.run.status).toBe('result');
    expect(record!.run.ended_at).not.toBeNull();
    expect(record!.run.query_id).toBeNull(); // NullQueryStore — nothing persisted
  });
});

describe('the runs that never write an app_queries row are still traced', () => {
  it('an uncached senator: UNCACHED step, persistence skipped, run concluded as uncached', async () => {
    const { record, events } = await run('W000817', 'Lower prescription drug prices.');
    expect(events.some((e) => e.type === 'uncached')).toBe(true);
    const stages = record!.steps.map((s) => s.stage);
    expect(stages).toContain('UNCACHED');
    expect(stages).toContain('QUEUE_SENATOR');
    expect(record!.steps.find((s) => s.stage === 'PERSIST')?.status).toBe('skipped');
    expect(record!.run.status).toBe('uncached');
  });
});

describe('a cache replay is its own run, pointing at the original', () => {
  it('replays the ORIGINAL trace id to the browser and logs a CACHE_REPLAY run', async () => {
    const first = await run('S000148', 'Lower prescription drug prices.', 'session-1');
    const second = await run('S000148', 'Lower prescription drug prices.', 'session-1');

    // The browser sees the original id: that run produced the answer.
    expect(second.traceEvent?.run_id).toBe(first.traceEvent?.run_id);

    // And a separate run recorded that a replay happened, with no model steps.
    const replay = [...sink.runs.values()].find((r) => r.run.status === 'replay');
    expect(replay).toBeDefined();
    expect(replay!.steps).toHaveLength(1);
    expect(replay!.steps[0]!.stage).toBe('CACHE_REPLAY');
    expect((replay!.steps[0]!.input as { original_run_id: string }).original_run_id).toBe(first.traceEvent?.run_id);
  });
});
