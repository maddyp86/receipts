import { describe, expect, it } from 'vitest';
import type { MatchedAction, ScoredResult, Senator, StreamEvent } from '@receipts/shared';
import { coverageSentence } from '@receipts/shared';
import { finish } from './loop.js';
import { newSession, type QuerySession } from './dispatch.js';

// ===========================================================================
// What actually reaches the browser.
//
// `CoverageWindow` sat on `QueryResult` for a whole phase without anything ever
// assigning it: the type existed, `describeCoverage` existed, its tests passed,
// and the field was `undefined` on every real response. Nothing failed, because
// an optional field that is never set looks exactly like one that is.
//
// So these tests assert ATTACHMENT, not derivation. coverage.test.ts already
// covers what the window says; this covers whether the user is ever shown it.
// ===========================================================================

const senator: Senator = { politician_id: 'S000148', name: 'Chuck Schumer', cached: true };

const scored: ScoredResult = {
  verdict: 'NOT_DETERMINABLE',
  band: null,
  mode: 'not_determinable',
  nd_reason: 'NO_MATCHES',
  ranked: [],
  receipt: {
    match_count: 0,
    directed_count: 0,
    avg_strength: 0,
    strongest_score: 0,
    evidence_mix: { vote: 0, sponsorship: 0, procedural: 0, associative: 0 },
    direction_split: { keeps: 0, breaks: 0, neutral: 0 },
    weight_split: { keeps: 0, breaks: 0 },
    minority_share: 0,
    trace: [],
    scoring_flags: [],
  },
  evidence: [],
};

const match = (congress?: number): MatchedAction =>
  ({ action_uid: `a${congress}`, bill_id: 'b', congress }) as unknown as MatchedAction;

function run(over: Partial<QuerySession> = {}): { emitted: StreamEvent[]; ok: boolean } {
  const session: QuerySession = {
    ...newSession('S000148', 'I will lower drug prices'),
    senator,
    interpretation: { raw: 'x' } as QuerySession['interpretation'],
    scored,
    ...over,
  };
  const emitted: StreamEvent[] = [];
  const ok = finish(session, (e) => emitted.push(e));
  return { emitted, ok };
}

const resultOf = (emitted: StreamEvent[]) => {
  const event = emitted.find((e) => e.type === 'result');
  if (!event || event.type !== 'result') throw new Error('no result event emitted');
  return event.result;
};

describe('the coverage window reaches the browser', () => {
  it('is attached to the emitted result', () => {
    const { emitted, ok } = run({ matches: [match(118), match(119)] });
    expect(ok).toBe(true);
    expect(resultOf(emitted).coverage).toBeDefined();
  });

  it('is attached when NOTHING was retrieved — the case it exists for', () => {
    // "We didn't find any bills or votes in this senator's analyzed record" is
    // the sentence that needs the boundary beside it most, and it is exactly
    // the path where `matches` is empty and an unguarded derivation would be
    // skipped as pointless.
    const { emitted } = run({ matches: [] });
    const coverage = resultOf(emitted).coverage;
    expect(coverage).toBeDefined();
    expect(coverage!.observed).toBeNull();
    expect(coverageSentence(coverage!)).toBeTruthy();
  });

  it('is attached to a KEPT verdict too, not only to empty results', () => {
    // A verdict drawn from two 118th-Congress bills is bounded by the same
    // window as a no-match. Attaching it only to thin results would make the
    // disclosure look like an apology for a weak answer.
    const { emitted } = run({
      matches: [match(118)],
      scored: { ...scored, verdict: 'KEPT', band: 'Medium', mode: 'single', nd_reason: null },
    });
    expect(resultOf(emitted).coverage).toBeDefined();
  });

  it('derives the observed span from the PRE-gate candidate set', () => {
    // The question is what the SEARCH covered. A row the gates later closed was
    // still inside the searched window, so dropping it would narrow the stated
    // boundary on the strength of a decision made after retrieval.
    const { emitted } = run({ matches: [match(117), match(118), match(119)] });
    expect(resultOf(emitted).coverage!.observed).toEqual({ min: 117, max: 119 });
  });

  it('says nothing rather than guessing when there is no session state', () => {
    const { emitted } = run({ matches: undefined });
    expect(resultOf(emitted).coverage!.observed).toBeNull();
  });
});
