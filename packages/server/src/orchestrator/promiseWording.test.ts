import { afterEach, describe, expect, it } from 'vitest';
import type { StreamEvent } from '@receipts/shared';
import { runQuery } from './loop.js';
import { READER_PROMISE_WORDING, assertedPromiseProblems } from './dispatch.js';
import { resultCache } from '../data/ResultCache.js';

// ===========================================================================
// The reader's own promise (Matt, 17 Oct). "promised to protect tribal
// sovereignty" came back as "consistent with the position": a typed promise
// was always a position. It is now answered as a promise, and stays the
// READER'S premise (provenance 'asserted'): the card says so, and the
// explanation may never say the senator made it.
// ===========================================================================

afterEach(() => resultCache.clear());

async function interpretationOf(text: string) {
  const events: StreamEvent[] = [];
  await runQuery('S000148', text, (e) => events.push(e));
  const r = events.find((e): e is Extract<StreamEvent, { type: 'result' }> => e.type === 'result')?.result;
  return r?.interpretation;
}

describe('promise wording in the reader\'s own text', () => {
  it.each([
    'promised to protect tribal sovereignty',
    'He promised not to raise my taxes.',
    'pledged to expand background checks',
    'vowed to repeal the estate tax',
  ])('%s', (t) => {
    expect(READER_PROMISE_WORDING.test(t)).toBe(true);
  });

  it.each(['supports expanding background checks', 'Lower prescription drug prices.', 'promise-keeping in Congress'])(
    'not: %s',
    (t) => {
      expect(READER_PROMISE_WORDING.test(t)).toBe(false);
    },
  );

  it('a typed promise is checked as the reader\'s promise', async () => {
    const i = await interpretationOf('promised to protect clean air standards from rollback');
    expect(i).toMatchObject({ statement_type: 'Campaign Promise', provenance: 'asserted', user_asserted_premise: true });
  });

  it('a typed position is unchanged', async () => {
    const i = await interpretationOf('supports protecting clean air standards from rollback');
    expect(i).toMatchObject({ statement_type: 'Policy Position', provenance: 'default' });
  });
});

describe('the explanation of an asserted promise', () => {
  it('rejects saying the senator made it', () => {
    for (const bad of [
      'Thune promised to protect tribal sovereignty, and his record keeps it.',
      'He kept his promise on tribal land.',
      'Their campaign pledge is borne out by two bills.',
      'The senator had promised this in 2024.',
    ]) {
      expect(assertedPromiseProblems(bad, 'Thune').length, bad).toBeGreaterThan(0);
    }
  });

  it('accepts "this promise" and the reader\'s own words, reported as theirs', () => {
    expect(assertedPromiseProblems('The record shows evidence Thune kept this promise: two cosponsored bills.', 'Thune')).toEqual([]);
    expect(assertedPromiseProblems('You said Thune promised to protect tribal sovereignty. Two bills point toward keeping it.', 'Thune')).toEqual([]);
  });
});
