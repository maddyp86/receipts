import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StreamEvent } from '@receipts/shared';
import { runQuery } from './loop.js';
import { recordExplanationProblems } from './dispatch.js';
import { traceSinks } from '../services.js';
import { resultCache } from '../data/ResultCache.js';
import { MemoryTraceSink } from '../trace/TraceStore.js';

// ===========================================================================
// A record question, end to end (demo + fixture: no model, canned retrieval;
// the routing, the gates, the label and the result are real).
//
// Run 3bf66a32 is why: "Did they vote to extend the enhanced ACA tax
// credits?" was rewritten into "supports extending …", scope-classified as a
// POSITION and graded as Collins's own. A question must take its own path:
// no rewrite, no scope check, no verdict, an answer label.
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

async function ask(text: string, meta: Parameters<typeof runQuery>[4] = {}) {
  const events: StreamEvent[] = [];
  await runQuery('S000148', text, (e) => events.push(e), undefined, meta);
  const trace = events.find((e): e is Extract<StreamEvent, { type: 'trace' }> => e.type === 'trace');
  const run = trace ? sink.runs.get(trace.run_id) : undefined;
  const result = events.find((e): e is Extract<StreamEvent, { type: 'result' }> => e.type === 'result')?.result;
  return { events, run, result, stages: run?.steps.map((s) => s.stage) ?? [] };
}

describe('a record question takes its own path', () => {
  it('is classified first, never scope-classified, and answered with a label', async () => {
    const { stages, result, events } = await ask('Did they vote to lower prescription drug prices?');
    expect(stages).toContain('INPUT_KIND');
    expect(stages).not.toContain('SCOPE_CLASSIFY');
    expect(stages).toContain('RECORD_ANSWER');
    expect(events.some((e) => e.type === 'rewritten')).toBe(false);
    expect(result?.record?.label).toBeDefined();
    expect(result?.interpretation.input_kind).toBe('RECORD_QUESTION');
    expect(result?.interpretation.provenance).toBe('voter_question');
    // The voter's words stay the voter's: nothing restated them as a statement.
    expect(result?.interpretation.raw).toBe('Did they vote to lower prescription drug prices?');
  });

  it('a statement is unchanged: no label, no input_kind, the usual path', async () => {
    const { stages, result } = await ask('Lower prescription drug prices.');
    expect(stages).toContain('INPUT_KIND');
    expect(stages).not.toContain('RECORD_ANSWER');
    expect(result?.record).toBeUndefined();
    expect(result?.interpretation.input_kind).toBeUndefined();
  });

  it('the reader’s own choice is used, never classified again', async () => {
    const { run, result } = await ask('her record on drug prices', { inputKind: 'RECORD_QUESTION' });
    expect(run?.steps.find((s) => s.stage === 'REQUEST')?.input).toMatchObject({ input_kind: 'RECORD_QUESTION', input_kind_decided_by: 'reader' });
    expect(result?.record).toBeDefined();
  });

  it('opens its explanation with the question as asked', async () => {
    const { result } = await ask('Did they vote to lower prescription drug prices?');
    expect(result?.explanation.why).toMatch(/^You asked: "Did they vote to lower prescription drug prices\?"/);
  });
});

describe('the record-mode wording check', () => {
  const q = 'Did they vote to extend the enhanced ACA tax credits?';

  it('rejects grading words and claims about belief', () => {
    for (const bad of [
      'Collins kept her promise on this.',
      'Her vote is consistent with her stated position.',
      'This runs counter to her position.',
      'She clearly believes in the credits.',
      'It shows she wants to extend them.',
    ]) {
      expect(recordExplanationProblems(bad, q).length, bad).toBeGreaterThan(0);
    }
  });

  it('accepts a plain account of what was done', () => {
    expect(
      recordExplanationProblems(
        `You asked: "${q}" Collins voted Yea to end debate on S.3385, which would have extended the credits. The motion failed 51 to 48, so the bill never got a final vote.`,
        q,
        true,
      ),
    ).toEqual([]);
  });

  // Trace 7b5181a8: a good draft was sent back three times for "Care".
  it('does not read a bill name or the voter\'s own words as a claim', () => {
    expect(recordExplanationProblems(`You asked: "${q}" Collins voted Yea on the Affordable Care Act credits bill.`, q, true)).toEqual([]);
    const asked = 'Did she vote for what she wanted on drug prices?';
    expect(recordExplanationProblems(`You asked: "${asked}" She voted Yea on S.1.`, asked, true)).toEqual([]);
    expect(recordExplanationProblems('Collins cares about health costs.', q).length).toBeGreaterThan(0);
  });

  it('requires the opening to quote the question', () => {
    expect(recordExplanationProblems('You asked whether Collins supports the credits.', q, true).join(' ')).toMatch(/open with the voter's question/);
  });
});
