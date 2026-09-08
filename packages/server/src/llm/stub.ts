import type { MatchedAction, ScoredResult, Senator, Stance } from '@receipts/shared';
import { VERDICT_PHRASE, ND_REASON_COPY } from '@receipts/shared';
import taxonomyData from '../embeddings/taxonomy.json' with { type: 'json' };

// ===========================================================================
// DEMO MODE stubs.
//
// These exist so the whole slice is clickable with no API keys at all — the
// entry screen, the streamed steps, the gates, the bands, the ranked mode and
// every honest state are exercised end to end.
//
// They are NOT a fallback for a failed model call, and they are not clever. The
// UI states plainly that interpretation and explanation are canned whenever
// these run, because a stubbed judgement presented as a real one would be
// exactly the fabricated answer this product exists to avoid.
// ===========================================================================

interface TaxonomyRow {
  primary_issue: string;
  sub_issue: string;
  taxonomy_keywords: string;
}

const rows: TaxonomyRow[] = taxonomyData.rows;

// Cues that the promise wants to STOP something. Note "protect", "preserve" and
// "defend" are deliberately absent: they mean the speaker wants the thing to
// continue, which is an In Favor stance toward that goal. Reading them as
// opposition inverts the chip the user sees.
const OPPOSING_CUES = ['oppose', 'block', 'stop', 'prevent', 'repeal', 'reject', 'overturn'];

export interface StubInterpretation {
  restated: string;
  primary_issue: string;
  sub_issue: string;
  stance: Stance;
  promise_type: 'policy' | 'process' | 'rhetorical' | 'non_legislative';
  is_evaluable: boolean;
  key_policy_terms: string[];
  reasoning: string;
}

/** Pick the taxonomy row with the most keyword overlap; no match is honest too. */
export function stubInterpretation(promiseText: string): StubInterpretation {
  const text = promiseText.toLowerCase();

  let best: { row: TaxonomyRow; hits: number } | null = null;
  for (const row of rows) {
    let hits = 0;
    // The cell is an opaque string upstream; split only here, for scoring.
    for (const kw of row.taxonomy_keywords.split(',').map((k) => k.trim()).filter(Boolean)) {
      const head = kw.toLowerCase().split(/\s+/)[0]!;
      if (text.includes(kw.toLowerCase()) || (head.length > 4 && text.includes(head))) hits += 1;
    }
    if (text.includes(row.sub_issue.toLowerCase())) hits += 2;
    if (!best || hits > best.hits) best = { row, hits };
  }

  const matched = best && best.hits > 0 ? best.row : null;
  const stance: Stance = OPPOSING_CUES.some((c) => text.includes(c)) ? 'Opposed' : 'In Favor';

  const key_policy_terms = text
    .split(/[^a-z0-9-]+/)
    .filter((w) => w.length > 4)
    .slice(0, 6);

  // No taxonomy row matched. Do NOT fall back to a real classification: the
  // taxonomy keywords it would inject go straight into the embedded query text
  // and will match bills on that unrelated subject with high confidence. That
  // is how "build a colony on Mars" comes back as a kept drug-pricing promise.
  // Report that we couldn't tell what to check, and let G0 handle it.
  if (!matched) {
    return {
      restated: promiseText.trim().replace(/\s+/g, ' '),
      primary_issue: '',
      sub_issue: '',
      stance,
      promise_type: 'policy',
      is_evaluable: false,
      key_policy_terms,
      reasoning:
        'Demo mode: no approved-taxonomy row matched this promise, so there is no specific commitment to check.',
    };
  }

  return {
    restated: promiseText.trim().replace(/\s+/g, ' '),
    primary_issue: matched.primary_issue,
    sub_issue: matched.sub_issue,
    stance,
    promise_type: 'policy',
    is_evaluable: true,
    key_policy_terms,
    reasoning: `Demo mode: matched the approved taxonomy row "${matched.primary_issue} / ${matched.sub_issue}" by keyword overlap.`,
  };
}

/**
 * Stand-in for the bill-effect judgement.
 *
 * Deliberately reproduces the one rule that matters most: a disapproval
 * resolution nullifies the underlying policy, so where the promise wants that
 * policy to exist, the resolution HINDERS. This is what makes the CRA fixture
 * resolve correctly in demo mode rather than only under a live model.
 */
export function stubBillEffects(
  matches: MatchedAction[],
  interpretation: { primary_issue: string; sub_issue: string; stance: Stance },
): Array<{
  action_uid: string;
  bill_effect: string;
  bill_effect_reasoning: string;
  alignment_confidence: number;
}> {
  return matches.map((m) => {
    const title = m.title.toLowerCase();
    const isDisapproval =
      /disapprov|terminat|repeal|rescind|nullif/.test(title) ||
      ['hjres', 'sjres'].includes((m.bill_type ?? '').toLowerCase());

    const sameIssue =
      m.primary_issue.toLowerCase() === interpretation.primary_issue.toLowerCase() &&
      m.sub_issue.toLowerCase() === interpretation.sub_issue.toLowerCase();

    if (!sameIssue) {
      return {
        action_uid: m.action_uid,
        bill_effect: 'NEUTRAL',
        bill_effect_reasoning:
          'Demo mode: this bill sits outside the promise’s issue area, so it does not move the goal either way.',
        // NEUTRAL carries no direction, so contract 3 never looks at it.
        alignment_confidence: 0.55,
      };
    }

    if (isDisapproval) {
      return {
        action_uid: m.action_uid,
        bill_effect: 'HINDER',
        bill_effect_reasoning:
          'Demo mode: this resolution would nullify the underlying rule the promise depends on, so passing it sets the goal back.',
        // Above contract 3's 0.7 floor, deliberately. Without a confidence the
        // rule fails closed and every demo BROKE withholds — correct by the
        // rule, but it would leave the demo unable to show the verdict it
        // exists to demonstrate. A stub asserting its own confidence is honest;
        // silently exempting demo mode from the rule would not be.
        alignment_confidence: 0.82,
      };
    }

    return {
      action_uid: m.action_uid,
      bill_effect: 'ADVANCE',
      bill_effect_reasoning:
        'Demo mode: the bill’s mechanisms move the promise’s goal forward in the same issue area.',
      alignment_confidence: 0.82,
    };
  });
}

/** A plain, verdict-faithful explanation with no motive language. */
export function stubExplanation(
  scored: ScoredResult,
  senator: Senator,
): { why: string; connectors: Array<{ action_uid: string; line: string }>; confidence: number } {
  const name = senator.name;
  const n = scored.evidence.filter((e) => e.direction !== 'neutral').length;

  let why: string;
  if (scored.verdict === 'NOT_DETERMINABLE') {
    why = `${ND_REASON_COPY[scored.nd_reason ?? 'NO_MATCHES']} (Demo mode: this explanation is canned, not written for your promise.)`;
  } else if (scored.mode === 'ranked') {
    why = `${name}'s record here points both ways. We found ${n} recorded actions on this promise, and they do not all line up — the larger share points toward "${VERDICT_PHRASE[scored.verdict]}", with real evidence on the other side shown below. (Demo mode: this explanation is canned, not written for your promise.)`;
  } else {
    why = `We found ${n} recorded ${n === 1 ? 'action' : 'actions'} by ${name} on this promise, and ${n === 1 ? 'it points' : 'they all point'} the same way. (Demo mode: this explanation is canned, not written for your promise.)`;
  }

  const connectors = scored.evidence.map((e) => ({
    action_uid: e.action_uid,
    line: e.bill_keywords.length
      ? `This bill covers ${e.bill_keywords.slice(0, 3).join(', ')} — the subject you asked about.`
      : `${e.title} sits in the same issue area as your promise.`,
  }));

  return { why, connectors, confidence: 0.5 };
}
