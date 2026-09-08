import type { CoverageWindow, MatchedAction } from '@receipts/shared';
import { config } from '../config.js';

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

/**
 * One sentence, safe to show, stating the boundary.
 *
 * Deliberately says what was SEARCHED, never what the senator did. The
 * distinction is the whole point: the tool can speak with authority about its
 * own corpus and has no standing to speak about anything outside it.
 */
export function coverageSentence(coverage: CoverageWindow): string {
  if (coverage.unknown) {
    return 'We could not establish which legislative record was searched, so treat an empty result as inconclusive rather than as an absence of action.';
  }

  // Prefer the DECLARED window; fall back to what was actually observed.
  // An unset COVERAGE_CONGRESSES with real candidates in hand is not "we don't
  // know" — the data says which congresses were searched, and saying so is
  // better than a vague disclaimer.
  const list = coverage.congresses.length
    ? coverage.congresses
    : coverage.observed
      ? Array.from(
          { length: coverage.observed.max - coverage.observed.min + 1 },
          (_, i) => coverage.observed!.min + i,
        )
      : [];

  if (!list.length) {
    return 'This covers only the legislation we have analyzed, which may not be a senator’s full record.';
  }

  const span =
    list.length === 1
      ? `the ${ordinal(list[0]!)} Congress`
      : `the ${list.slice(0, -1).map(ordinal).join(', ')} and ${ordinal(list[list.length - 1]!)} Congress`;

  return `We searched ${span}. Anything before that is outside the record we have analyzed, so an empty result here is not a finding that the senator has no record on the subject.`;
}

const ordinal = (n: number): string => {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
};
