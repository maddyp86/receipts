import { describe, expect, it } from 'vitest';
import type { MatchedAction } from '@receipts/shared';
import { coverageSentence, describeCoverage } from './coverage.js';

const match = (congress?: number): MatchedAction =>
  ({ action_uid: 'a', bill_id: 'b', congress }) as unknown as MatchedAction;

// ===========================================================================
// The disclosure that stops "we found nothing" reading as "he did nothing".
// ===========================================================================

describe('the observed window is derived, not asserted', () => {
  it('reads the span from the candidates themselves', () => {
    // Hardcoding the sentence would keep claiming 118-119 after collection was
    // extended - lying in the other direction, and silently.
    const c = describeCoverage([match(118), match(119), match(118)]);
    expect(c.observed).toEqual({ min: 118, max: 119 });
  });

  it('is null when nothing was retrieved, rather than guessed', () => {
    expect(describeCoverage([]).observed).toBeNull();
  });

  it('ignores candidates whose congress is missing', () => {
    // A vector embedded before the field existed has no congress. That is
    // unknown, not zero - and a zero would drag the observed minimum to a
    // congress that never existed.
    const c = describeCoverage([match(119), match(undefined), match(118)]);
    expect(c.observed).toEqual({ min: 118, max: 119 });
  });
});

describe('the sentence talks about the SEARCH, never the senator', () => {
  it('states the window and refuses the stronger claim', () => {
    const s = coverageSentence(describeCoverage([match(118)]));
    expect(s).toContain('Congress');
    // The load-bearing half: it must actively deny the inference a reader makes.
    expect(s).toContain('not a finding that the senator has no record');
  });

  it('renders a multi-congress window readably', () => {
    // config defaults to [] in tests, so drive it directly.
    const s = coverageSentence({
      congresses: [118, 119],
      observed: null,
      unknown: false,
    });
    expect(s).toContain('118th and 119th Congress');
  });

  it('makes a weaker claim when the window is unknown', () => {
    const s = coverageSentence({ congresses: [], observed: null, unknown: true });
    expect(s).toContain('inconclusive');
    expect(s).not.toContain('no record');
  });

  it('only ever mentions the senator to DENY an inference, never to assert one', () => {
    // The sentence does contain "the senator has no record" — inside "not a
    // finding that the senator has no record". Naively banning the phrase would
    // ban the disclaimer itself. What must never appear is an unqualified claim.
    for (const c of [
      describeCoverage([match(118)]),
      { congresses: [], observed: null, unknown: true },
      { congresses: [117, 118, 119], observed: null, unknown: false },
    ]) {
      const s = coverageSentence(c);
      const claims = /senator (has|did|voted|sponsored) /i.test(s);
      if (claims) {
        // Permitted only when explicitly negated in the same sentence.
        expect(s).toMatch(/not a finding that/i);
      }
    }
  });
});

describe('the sentence has exactly one definition', () => {
  it('is the shared one, so the client and the server cannot drift', async () => {
    // The client renders this sentence and the server persists it. Two copies
    // would diverge silently — the screen saying one window, the audit row
    // another — so `scoring/coverage.ts` re-exports rather than reimplements.
    const shared = await import('@receipts/shared');
    expect(coverageSentence).toBe(shared.coverageSentence);
  });
});

describe('a NOT_DETERMINABLE with no reason does not borrow NO_MATCHES', () => {
  it('claims no absence and offers no exoneration', async () => {
    const { ND_NO_REASON_COPY, ND_REASON_COPY } = await import('@receipts/shared');

    // The specific failure this guards: falling back to NO_MATCHES makes the
    // tool assert "we searched and found nothing in this senator's record" on
    // the strength of a field that was simply never set.
    expect(ND_NO_REASON_COPY).not.toBe(ND_REASON_COPY.NO_MATCHES);
    expect(ND_NO_REASON_COPY).not.toMatch(/didn't find any|no bills or votes/i);

    // Nor may it read as a clearing. Same posture as the withholding copy.
    expect(ND_NO_REASON_COPY).not.toMatch(/\bkept\b|cleared|no wrongdoing/i);
  });
});
