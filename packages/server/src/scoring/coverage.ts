import type { CoverageWindow, MatchedAction } from '@receipts/shared';
import { config } from '../config.js';

// The SENTENCE lives in `shared` — the client renders it and the server persists
// it, and two copies would drift. The DERIVATION stays here: it reads config,
// and `observed` must come from the retrieved candidates rather than from
// anything the browser could assert.
export { coverageSentence } from '@receipts/shared';

// ===========================================================================
// What record was actually searched.
//
// The tool's most dangerous sentence is not an accusation — it is
// "We didn't find any bills or votes in this senator's analyzed record."
//
// Every word of that is true and a reader hears "he has no record on this".
// For anything outside the collected window it is false: Schumer PASSED the
// Inflation Reduction Act, the defining drug-pricing law of the era, in the
// 117th Congress. The corpus starts at the 118th, so the tool reported it as
// an absence of action.
//
// That is the mirror of the false-positive class, and it is the less protected
// of the two. An accusation has to clear a confidence floor, carry a
// counterargument, and survive a judge. An absence gets a clean sentence and
// no scrutiny at all.
//
// DERIVED, NOT ASSERTED. `observed` comes from the retrieved candidates' own
// metadata. A hardcoded "we cover the 118th and 119th" would keep saying that
// after collection was extended — lying in the opposite direction, and
// silently, because nothing would fail.
// ===========================================================================

export function describeCoverage(candidates: MatchedAction[]): CoverageWindow {
  const declared = config.coverage.congresses;

  const seen = candidates
    .map((c) => c.congress)
    .filter((c): c is number => typeof c === 'number' && Number.isFinite(c));

  const observed = seen.length ? { min: Math.min(...seen), max: Math.max(...seen) } : null;

  return {
    congresses: declared,
    observed,
    // Unknown when nothing declares the window and nothing was retrieved to
    // infer it from. The UI must then make a weaker claim — "we found nothing
    // in what we searched" — rather than one about the senator's record.
    unknown: declared.length === 0 && observed === null,
  };
}
