import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  TEXT_AT_ACTION_UNAVAILABLE,
  evidenceTallySentence,
  likelyOutcomeHeadline,
  type GatedAction,
  type NotDeterminableReason,
  type ProvenanceSource,
  type QueryResult,
  type ScoredResult,
  type StatementType,
} from '@receipts/shared';
import { scoreMatches, type ScorableMatch } from '../../../server/src/scoring/score.js';
import { AnalystTrace, Verdict } from './Verdict.js';
import { HowWeGotHere } from './HowWeGotHere.js';

// The test runner compiles JSX with the classic transform.
(globalThis as { React?: unknown }).React = React;

// ===========================================================================
// THE COUNT-FIRST LINE.
//
// The receipts before the explanation, built from the result's own fields.
// Scored by the real scorer; rendered by the real components.
// ===========================================================================

let uid = 0;
function row(over: Partial<ScorableMatch> = {}): ScorableMatch {
  uid += 1;
  return {
    action_uid: `ACT-${uid}`, bill_id: `s${uid}-119`, title: 'A bill', summary: 'S.', intended_effects: 'E.',
    mechanisms: 'M.', action_type: 'voted', is_sponsor: false, is_cosponsor: false, vote: 'Yea',
    cloture_vote: 'NA', passage_vote: 'Yea', bill_keywords: [], primary_issue: 'x', sub_issue: 'y', source_url: '',
    score: 0.8, strength: 'STRONG', missing_fields: [], bill_effect: 'ADVANCE', bill_effect_reasoning: 'r',
    alignment_confidence: 0.9,
    ...over,
  } as ScorableMatch;
}
const KEEP = {};
const BREAK = { vote: 'Nay', passage_vote: 'Nay' };
const NEUTRAL = { bill_effect: 'NEUTRAL' as const };
const ABSTAIN = { vote: 'Not Voting', passage_vote: 'Not Voting' };

const gatedRow = (n: number): GatedAction => ({
  action_uid: `G-${n}`, bill_id: `s9${n}-119`, title: 'A vehicle', gate: 'G4_vehicle', outcome: 'NOT_APPLICABLE', reason: 'r',
});

function result(
  scored: ScoredResult,
  over: { statement_type?: StatementType; provenance?: ProvenanceSource; gated?: number } = {},
): QueryResult {
  return {
    senator: { politician_id: 'X000001', name: 'Jane Q. Example, Jr.', cached: true },
    interpretation: {
      raw: 'x', restated: 'x', primary_issue: 'Health', sub_issue: '', stance: 'In Favor',
      statement_type: over.statement_type ?? 'Policy Position', provenance: over.provenance ?? 'default',
      promise_type: 'policy',
    },
    scored,
    explanation: { why: 'Because.', connectors: {}, confidence: 0.5 },
    gated: Array.from({ length: over.gated ?? 0 }, (_, i) => gatedRow(i)),
    search: {
      returned: null, below_floor: null, evaluated: scored.evidence.length, admitted: scored.evidence.length,
      relevance_applied: true, exclusions: [],
    },
  } as unknown as QueryResult;
}

const score = (matches: ScorableMatch[], statement_type: StatementType = 'Policy Position') =>
  scoreMatches({ promise_type: 'policy', statement_type, matches });

const text = (html: string) =>
  html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const render = (el: React.ReactElement) => text(renderToStaticMarkup(el));

/** A NOT_DETERMINABLE that still carries the directed rows, as a withholding leaves them. */
function withheld(reason: NotDeterminableReason, matches: ScorableMatch[]): ScoredResult {
  return { ...score(matches), verdict: 'NOT_DETERMINABLE', band: null, mode: 'not_determinable', nd_reason: reason, ranked: [] };
}

describe('the sentence', () => {
  it('counts the senator’s alignment, not the bill’s effect', () => {
    // A no vote on a bill that sets the goal back keeps the statement.
    const r = score([row({ bill_effect: 'HINDER', ...BREAK }), row(KEEP)]);
    expect(r.verdict).toBe('KEPT');
    expect(evidenceTallySentence(result(r))).toBe(
      'We found 2 actions by Example related to this statement. Both are consistent with it.',
    );
  });

  it('one action', () => {
    expect(evidenceTallySentence(result(score([row(KEEP)])))).toBe(
      'We found 1 action by Example related to this statement. That action is consistent with it.',
    );
  });

  it('every part, with singular and plural grammar, and the set-aside count', () => {
    const r = score([row(KEEP), row(KEEP), row(BREAK), row(NEUTRAL)]);
    expect(r.mode).toBe('ranked');
    expect(evidenceTallySentence(result(r, { gated: 1 }))).toBe(
      'We found 4 actions by Example related to this statement. 2 are consistent with it, 1 runs counter to it, ' +
        "and 1 doesn't count either way. 1 more was found but set aside — see “Found, but not evaluated”.",
    );
    expect(evidenceTallySentence(result(r, { gated: 3 }))).toMatch(/3 more were found but set aside/);
  });

  it('zero parts are left out', () => {
    const s = evidenceTallySentence(result(score([row(KEEP), row(KEEP), row(NEUTRAL)])))!;
    expect(s).toBe("We found 3 actions by Example related to this statement. 2 are consistent with it and 1 doesn't count either way.");
    expect(s).not.toMatch(/counter|set aside|0 /);
  });

  // An abstention on a bill read as advancing the goal is undirected. Saying it
  // "doesn't move it either way" would contradict "How we got here", which says
  // the bill would move the goal forward.
  it('an undirected action is one that does not count, not one that does not move the goal', () => {
    const s = evidenceTallySentence(result(score([row(KEEP), row(ABSTAIN)])))!;
    expect(s).toMatch(/1 doesn't count either way/);
    expect(s).not.toMatch(/move/);
  });
});

describe('the statement’s vocabulary', () => {
  const mixed = () => score([row(KEEP), row(KEEP), row(BREAK)], 'Campaign Promise');

  it('a policy position: consistent / runs counter', () => {
    const s = evidenceTallySentence(result(score([row(KEEP), row(KEEP), row(BREAK)])))!;
    expect(s).toMatch(/2 are consistent with it and 1 runs counter to it\./);
  });

  it('an asserted promise: the same position language', () => {
    const s = evidenceTallySentence(result(mixed(), { statement_type: 'Campaign Promise', provenance: 'asserted' }))!;
    expect(s).toMatch(/2 are consistent with it and 1 runs counter to it\./);
    expect(s).not.toMatch(/keeping|breaking/);
  });

  it('a corpus-verified promise: toward keeping / toward breaking', () => {
    const s = evidenceTallySentence(result(mixed(), { statement_type: 'Campaign Promise', provenance: 'corpus' }))!;
    expect(s).toMatch(/2 point toward keeping it and 1 points toward breaking it\./);
  });
});

describe('guards', () => {
  const ALL_REASONS: NotDeterminableReason[] = [
    'NO_MATCHES', 'ALL_BELOW_FLOOR', 'ALL_NEUTRAL', 'NO_ACTION', 'PROCEDURAL_SWITCH', 'NON_LEGISLATIVE',
    'NOT_EVALUABLE', 'UNDIRECTABLE_METADATA', 'WITHHELD_LOW_CONFIDENCE', 'WITHHELD_PENDING_REVIEW',
    'WITHHELD_TEXT_UNAVAILABLE', 'EVALUATION_FAILED', 'ABSTAINED', 'CONTESTED_READING', 'GATED',
  ];

  // The breaking rows stay on a withheld result. A count would publish them.
  it.each(['WITHHELD_LOW_CONFIDENCE', 'WITHHELD_PENDING_REVIEW', 'WITHHELD_TEXT_UNAVAILABLE'] as const)(
    '%s with breaking rows on the result: no line, and the card shows no count',
    (reason) => {
      const r = result(withheld(reason, [row(BREAK), row(BREAK), row(KEEP)]), { gated: 1 });
      expect(r.scored.evidence.filter((e) => e.direction === 'breaks')).toHaveLength(2);
      expect(evidenceTallySentence(r)).toBeNull();
      const card = renderToStaticMarkup(React.createElement(Verdict, { result: r }));
      expect(card).not.toContain('verdict-tally');
      expect(text(card)).not.toMatch(/We found \d+ action/);
    },
  );

  it('a row read against unavailable text, withheld: no line', () => {
    const scored = withheld('WITHHELD_TEXT_UNAVAILABLE', [row(BREAK)]);
    scored.evidence[0]!.vote_flags = [TEXT_AT_ACTION_UNAVAILABLE];
    expect(evidenceTallySentence(result(scored))).toBeNull();
  });

  it.each(['NO_MATCHES', 'NO_ACTION', 'ALL_NEUTRAL', 'ALL_BELOW_FLOOR'] as const)(
    '%s: no line; the reason’s own copy stands',
    (reason) => {
      const r = result(withheld(reason, [row(NEUTRAL)]));
      expect(evidenceTallySentence(r)).toBeNull();
      expect(render(React.createElement(Verdict, { result: r }))).toMatch(/Here’s why\./);
    },
  );

  it('no NOT_DETERMINABLE ever gets keeps or breaks counts', () => {
    for (const reason of ALL_REASONS) {
      expect(evidenceTallySentence(result(withheld(reason, [row(KEEP), row(BREAK)])))).toBeNull();
    }
  });

  // Every sentence this can produce, across shapes and vocabularies.
  it('never says the senator did nothing, or that the search was complete', () => {
    const shapes = [
      [row(KEEP)], [row(BREAK)], [row(KEEP), row(BREAK)], [row(KEEP), row(NEUTRAL)], [row(BREAK), row(ABSTAIN)],
      [row(KEEP), row(KEEP), row(BREAK), row(NEUTRAL), row(ABSTAIN)],
    ];
    const vocab: Array<[StatementType, ProvenanceSource]> = [
      ['Policy Position', 'default'], ['Campaign Promise', 'asserted'], ['Campaign Promise', 'corpus'],
    ];
    let checked = 0;
    for (const m of shapes) {
      for (const [type, prov] of vocab) {
        for (const gated of [0, 2]) {
          const s = evidenceTallySentence(result(score(m, type), { statement_type: type, provenance: prov, gated }));
          if (!s) continue;
          checked += 1;
          expect(s).toMatch(/^We found \d+ actions? by Example related to this statement\./);
          expect(s).not.toMatch(
            /\b(took|did nothing|didn't act|never|no other|only|every|complete|entire|full record|all (of )?(his|her|their))\b/i,
          );
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('ranked: both sides’ counts are shown', () => {
    const r = score([row(KEEP), row(KEEP), row(KEEP), row(BREAK), row(BREAK)]);
    expect(r.mode).toBe('ranked');
    const s = evidenceTallySentence(result(r))!;
    expect(s).toMatch(/3 are consistent with it/);
    expect(s).toMatch(/2 run counter to it/);
  });
});

describe('the counts agree with "How we got here" and the analyst trace', () => {
  // One fixture, all three renderings, every count compared.
  it('total, each direction, and the set-aside count', () => {
    const scored = score([row(KEEP), row(KEEP), row(KEEP), row(BREAK), row(BREAK), row(NEUTRAL), row(ABSTAIN)]);
    expect(scored.mode).toBe('ranked');
    const r = result(scored, { gated: 2 });

    const tally = evidenceTallySentence(r)!;
    const trace = render(React.createElement(AnalystTrace, { result: r }));
    const walk = render(React.createElement(HowWeGotHere, { result: r }));
    const num = (s: string, re: RegExp) => Number(re.exec(s)?.[1] ?? NaN);

    // The tally.
    const t = {
      total: num(tally, /We found (\d+) actions?/),
      keeps: num(tally, /(\d+) (?:is|are) consistent/),
      breaks: num(tally, /(\d+) runs? counter/),
      neutral: num(tally, /(\d+) (?:doesn't|don't) count/),
      gated: num(tally, /(\d+) more (?:was|were) found but set aside/),
    };
    expect(t).toEqual({ total: 7, keeps: 3, breaks: 2, neutral: 2, gated: 2 });

    // The analyst trace.
    expect(num(trace, /Actions matched (\d+)/)).toBe(t.total);
    const split = /Direction split (\d+) keeping \/ (\d+) breaking \/ (\d+) neutral/.exec(trace)!;
    expect([Number(split[1]), Number(split[2]), Number(split[3])]).toEqual([t.keeps, t.breaks, t.neutral]);
    expect(trace.match(/G4_vehicle/g)).toHaveLength(t.gated);

    // How we got here: the set-aside step, the both-ways step, and the
    // per-bill step, whose parts cover every action counted.
    expect(num(walk, /(\d+) bills? (?:was|were) set aside before being weighed/)).toBe(t.gated);
    const both = /The evidence points both ways — (\d+) one way, (\d+) the other/.exec(walk)!;
    expect([Number(both[1]), Number(both[2])]).toEqual([t.keeps, t.breaks]);
    const step5 = /As we read them: ([^.]*)\./.exec(walk)![1]!;
    const perBill = [...step5.matchAll(/(\d+) (?:would|does|do|could)/g)].reduce((a, m) => a + Number(m[1]), 0);
    expect(perBill).toBe(t.total);
  });
});

describe('the headline', () => {
  it.each([
    ['Campaign Promise', 'corpus', 'KEPT', 'Likely kept'],
    ['Campaign Promise', 'corpus', 'BROKE', 'Likely broke'],
    ['Policy Position', 'default', 'KEPT', 'Their record is likely consistent with this position'],
    ['Policy Position', 'default', 'BROKE', 'Their record likely runs counter to this position'],
    ['Campaign Promise', 'asserted', 'KEPT', 'You indicated this was a campaign promise. On that basis, their record is likely consistent with it'],
  ] as const)('%s / %s / %s → %s', (type, prov, verdict, h) => {
    expect(likelyOutcomeHeadline(verdict, type, prov)).toBe(h);
  });

  const headline = (r: QueryResult) => /<h2 class="verdict-label">([\s\S]*?)<\/h2>/.exec(
    renderToStaticMarkup(React.createElement(Verdict, { result: r })),
  )![1]!.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/^[✓✕—]/, '');

  it('keeps the band suffix', () => {
    const r = score([row(KEEP)], 'Campaign Promise');
    expect(headline(result(r, { statement_type: 'Campaign Promise', provenance: 'corpus' }))).toBe(
      `Likely kept — ${r.band === 'High' ? 'strong evidence' : r.band === 'Medium' ? 'moderate evidence' : 'low confidence'}`,
    );
  });

  it('keeps the mixed suffix in ranked mode', () => {
    const r = score([row(KEEP), row(KEEP), row(BREAK)]);
    expect(r.mode).toBe('ranked');
    expect(headline(result(r))).toMatch(/^Their record is likely consistent with this position — .+, but it’s mixed$/);
  });

  it('NOT_DETERMINABLE headlines are unchanged', () => {
    expect(headline(result(withheld('NO_MATCHES', [])))).toBe("We couldn't find enough to say");
    expect(headline(result(withheld('WITHHELD_PENDING_REVIEW', [row(BREAK)])))).toBe("We can't make a reliable call on this");
  });
});

describe('the order on the card', () => {
  it('headline → you asked about → the count → Here’s why', () => {
    const card = render(React.createElement(Verdict, { result: result(score([row(KEEP), row(BREAK), row(KEEP)])) }));
    const at = (s: string) => card.indexOf(s);
    expect(at('likely consistent')).toBeGreaterThanOrEqual(0);
    expect(at('likely consistent')).toBeLessThan(at('you asked about'));
    expect(at('you asked about')).toBeLessThan(at('We found 3 actions'));
    expect(at('We found 3 actions')).toBeLessThan(at('Here’s why. Because.'));
  });
});
