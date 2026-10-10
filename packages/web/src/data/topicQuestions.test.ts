import { describe, expect, it } from 'vitest';
import { topics } from './topics.js';

// ===========================================================================
// Topic starters are asked the way a reader asks: a question with a side.
// Each was run through the live input clean-up on 2026-10-10 and restated as
// a position ("supports …" / "opposes …"); none stopped to ask which way.
// ===========================================================================

const all = topics.flatMap((t) => t.examples.map((e) => e.text));

describe('topic starters', () => {
  it('are questions, asked about "they"', () => {
    expect(all.length).toBeGreaterThan(20);
    for (const q of all) expect(q).toMatch(/^(Did|Do) they .+\?$/);
  });

  it('each names a side: "vote to/for", "support" or "oppose"', () => {
    for (const q of all) expect(q).toMatch(/^Did they vote (to|for) |^Do they (support|oppose) /);
  });

  it('name no member', () => {
    for (const q of all) expect(q).not.toMatch(/Schumer|Thune|senator/i);
  });
});
