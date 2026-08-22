/**
 * Evidence gate — port of WF10A's `Filter` + `Dedupe Accepted Matches`.
 *
 * Verified against BuA0XMoRIeA8K-IziChwR on 2026-08-17 (published).
 *
 * The rule, exactly as live:
 *
 *   admit  TRUE_POSITIVE
 *   admit  PARTIAL where the derived subtype is SPECIFICITY
 *   drop   PARTIAL/DIRECTIONAL    — the evaluator explicitly said this action
 *                                    tells you nothing about this promise
 *   drop   PARTIAL/AMBIGUOUS      — confidence < 0.70, a policy gate
 *   drop   PARTIAL/UNCLASSIFIED   — PARTIAL with no axis explaining why
 *   drop   FALSE_POSITIVE, ERROR
 *
 * Subtype ordering matters and is not arbitrary: AMBIGUOUS is checked first
 * because it is a policy decision rather than a model signal, then DIRECTIONAL
 * before SPECIFICITY because a row can carry both and "not evidence about this
 * promise" is the more fundamental statement.
 *
 * ⚠ This rule is duplicated in three places in the pipeline (W7b's
 * `Derive Partial Subtype`, B2P's copy, and WF10A's recompute-when-blank
 * fallback). WF10A's own comment says: "The rule is byte-identical to Derive
 * Partial Subtype; if one changes, both must." This file is now the fourth.
 * It is a pure function of four fields, so the test suite pins it — but the
 * count is worth knowing.
 *
 * WHY THE FRESH-EVALUATION PATH STILL NEEDS THIS
 * The query tool has no pre-computed alignment rows, so the subtype is never
 * read from a sheet — it is always derived here from the axes the relevance
 * evaluator just returned. The `storedSubtype` branch in WF10A exists only for
 * rows written before Derive Partial Subtype shipped, and has no analogue here.
 */

import type { EvaluatedCandidate } from './relevance.js';

export const AMBIGUOUS_CONFIDENCE_FLOOR = 0.7;

export type PartialSubtype =
  | 'NA'
  | 'AMBIGUOUS'
  | 'DIRECTIONAL'
  | 'SPECIFICITY'
  | 'UNCLASSIFIED';

export interface GatedCandidate extends EvaluatedCandidate {
  match_verdict: 'TRUE_POSITIVE' | 'PARTIAL';
  partial_subtype: PartialSubtype;
}

export interface EvidenceGateResult {
  admitted: GatedCandidate[];
  /** Counts by exclusion reason, e.g. { 'PARTIAL/DIRECTIONAL': 3, FALSE_POSITIVE: 2 }. */
  dropped: Record<string, number>;
  /** Admitted tiers, e.g. { TRUE_POSITIVE: 2, 'PARTIAL/SPECIFICITY': 1 }. */
  tiers: Record<string, number>;
  /** Before dedupe. `admitted.length` is after. */
  admittedBeforeDedupe: number;
  candidatesIn: number;
}

const S = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

/**
 * Derives the PARTIAL subtype from axes the evaluator already emits.
 *
 * DERIVED, NOT GENERATED — the model is never asked for this label. Asking for
 * it would create a fifth field that can contradict the four it is derived
 * from, which needs a tiebreak rule and manufactures a new inconsistency class.
 */
export function derivePartialSubtype(r: {
  verdict?: string;
  confidence?: number;
  effort_relevant?: string;
  action_relevant?: string;
  specificity_match?: string;
}): PartialSubtype {
  const v = S(r.verdict).toUpperCase();
  if (v !== 'PARTIAL') return 'NA';

  // Non-numeric or missing confidence is treated as low, which routes to
  // review rather than into scoring. Conservative on an unreadable value.
  const conf = typeof r.confidence === 'number' ? r.confidence : NaN;
  if (!Number.isFinite(conf) || conf < AMBIGUOUS_CONFIDENCE_FLOOR) return 'AMBIGUOUS';

  // DIRECTIONAL before SPECIFICITY: a row can carry both.
  if (S(r.effort_relevant) === 'No' || S(r.action_relevant) === 'No') return 'DIRECTIONAL';

  if (S(r.specificity_match) === 'No') return 'SPECIFICITY';

  return 'UNCLASSIFIED';
}

const TIER: Record<string, number> = { TRUE_POSITIVE: 2, PARTIAL: 1 };

/**
 * Grades and admits evidence, then collapses to one decision per
 * (promise, bill, action).
 *
 * Dedupe preference: evidence tier first, then similarity, then
 * promise_to_bill. Tier MUST outrank similarity — a PARTIAL with a higher
 * cosine score is still weaker evidence than a TRUE_POSITIVE.
 *
 * @param strict when true, throws if candidates came in and none were admitted.
 *   WF10A does throw, because there an empty result means the verdict column
 *   moved. Here the same outcome is a legitimate user-facing answer ("nothing
 *   in his record bears on this"), so it defaults to false and the caller reads
 *   `dropped` to say WHY nothing was admitted. Do not report an empty admitted
 *   set as "no legislative activity" — see the note at the end of this file.
 */
export function applyEvidenceGate(
  candidates: EvaluatedCandidate[],
  opts: { strict?: boolean } = {}
): EvidenceGateResult {
  const admitted: GatedCandidate[] = [];
  const dropped: Record<string, number> = {};

  for (const c of candidates) {
    const verdict = S(c.relevance.verdict).toUpperCase();
    const subtype = derivePartialSubtype({
      verdict,
      confidence: c.relevance.confidence,
      effort_relevant: c.relevance.effort_relevant,
      action_relevant: c.relevance.action_relevant,
      specificity_match: c.relevance.specificity_match,
    });

    const keep = verdict === 'TRUE_POSITIVE' || (verdict === 'PARTIAL' && subtype === 'SPECIFICITY');

    if (!keep) {
      const reason = verdict === 'PARTIAL' ? `PARTIAL/${subtype}` : verdict || 'BLANK';
      dropped[reason] = (dropped[reason] || 0) + 1;
      continue;
    }

    admitted.push({
      ...c,
      match_verdict: verdict as 'TRUE_POSITIVE' | 'PARTIAL',
      partial_subtype: subtype,
    });
  }

  // ---------------- dedupe ----------------
  const best = new Map<string, GatedCandidate>();

  for (const item of admitted) {
    const key = `${S(item.promise_uid)}||${S(item.bill_id)}||${S(item.action_uid)}`;
    const tier = TIER[item.match_verdict] || 0;
    const sim = Number(item.similarity_score) || 0;

    const cur = best.get(key);
    if (!cur) {
      best.set(key, item);
      continue;
    }

    const curTier = TIER[cur.match_verdict] || 0;
    const curSim = Number(cur.similarity_score) || 0;

    const replace =
      tier > curTier ||
      (tier === curTier && sim > curSim) ||
      (tier === curTier &&
        sim === curSim &&
        S(item.match_direction) === 'promise_to_bill' &&
        S(cur.match_direction) !== 'promise_to_bill');

    if (replace) best.set(key, item);
  }

  const out = Array.from(best.values());

  const tiers = out.reduce<Record<string, number>>((a, i) => {
    const k = i.match_verdict === 'PARTIAL' ? `PARTIAL/${i.partial_subtype}` : i.match_verdict;
    a[k] = (a[k] || 0) + 1;
    return a;
  }, {});

  if (opts.strict && candidates.length > 0 && admitted.length === 0) {
    throw new Error(
      `[EVIDENCE] ${candidates.length} candidates in, 0 admitted. ` +
        `Excluded breakdown: ${JSON.stringify(dropped)}.`
    );
  }

  // ASSERTION (build spec §5): admitted ≤ candidates.
  if (out.length > candidates.length) {
    throw new Error(
      `[EVIDENCE] dedupe emitted ${out.length} decisions from ${candidates.length} ` +
        `candidates — the gate cannot create rows.`
    );
  }

  return {
    admitted: out,
    dropped,
    tiers,
    admittedBeforeDedupe: admitted.length,
    candidatesIn: candidates.length,
  };
}

/**
 * Turns the `dropped` counts into user-facing copy.
 *
 * This exists because "0 admitted" has at least four distinct meanings and the
 * UI must not render them identically:
 *
 *   FALSE_POSITIVE only    → bills came back but none were on this subject
 *   PARTIAL/DIRECTIONAL    → on-subject bills, but the action is not evidence
 *   PARTIAL/AMBIGUOUS      → the evaluator could not tell
 *   ERROR                  → the tool failed; say so, do not imply a finding
 *
 * None of them is "this senator did nothing." Retrieval coverage is ~48–52%,
 * so absence of matched evidence is never evidence of inaction.
 */
export function describeExclusions(dropped: Record<string, number>): string[] {
  const lines: string[] = [];
  const n = (k: string) => dropped[k] || 0;

  if (n('FALSE_POSITIVE')) {
    lines.push(
      `${n('FALSE_POSITIVE')} retrieved bill(s) were judged to be about a different subject.`
    );
  }
  if (n('PARTIAL/DIRECTIONAL')) {
    lines.push(
      `${n('PARTIAL/DIRECTIONAL')} bill(s) were on this subject, but the senator's action on ` +
        `them was judged not to be evidence about this position either way.`
    );
  }
  if (n('PARTIAL/AMBIGUOUS')) {
    lines.push(
      `${n('PARTIAL/AMBIGUOUS')} pairing(s) fell below the confidence floor and were set aside ` +
        `rather than scored.`
    );
  }
  if (n('PARTIAL/UNCLASSIFIED')) {
    lines.push(
      `${n('PARTIAL/UNCLASSIFIED')} pairing(s) could not be categorised and were excluded.`
    );
  }
  if (n('ERROR')) {
    lines.push(
      `${n('ERROR')} evaluation(s) failed to complete. This is a tool failure, not a finding ` +
        `about the senator.`
    );
  }
  return lines;
}
