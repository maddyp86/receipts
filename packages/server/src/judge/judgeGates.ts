// ===========================================================================
// JUDGE DETERMINISTIC GATES — G0..G6.
//
// SOURCE: docs/fix/11_wf13_deterministic_gates.js (2026-09-05), node 8 of WF13.
// Ported 2026-09-07, minus the metrics tail (that node's trailing METRICS item
// and the gold-set comparison are a batch-run concern; a single query has no
// run to aggregate and no gold row to join).
//
// ── THIS IS NOT THE SAME LAYER AS evaluation/preEvaluatorGates.ts ──────────
// Both are called "gates" and both carry G1..G4 labels, and they are different
// things:
//
//   preEvaluatorGates  runs BEFORE the evaluator, on the candidate action, and
//                      assigns a TERMINAL VERDICT. A row it gates never reaches
//                      the model at all.
//   judgeGates (here)  runs AFTER a verdict exists, on the finished row, and
//                      assigns nothing. It reports what a reviewer should
//                      dispute. Its output is an input to the LLM judge.
//
// The overlap is deliberate defence in depth, not duplication: the pre-gates
// fail open on missing inputs, so this layer catches what those let through.
// A row that passed the pre-gates can still fail here.
//
// "This is the layer the LLM cannot talk its way past. It is independent of
// WF10a: it reads only the row and reference data, never the evaluator prompt."
// That independence is the point — it never reads `alignment_reasoning` as
// evidence, only as a thing to check claims against.
// ===========================================================================

const S = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const U = (v: unknown): string => S(v).toUpperCase();

const truthy = (v: unknown): boolean => ['TRUE', 'YES', 'Y', '1'].includes(U(v));

function voteOf(v: unknown): 'YEA' | 'NAY' | 'NOT_VOTING' | null {
  const t = U(v);
  if (t === 'YEA' || t === 'AYE' || t === 'YES') return 'YEA';
  if (t === 'NAY' || t === 'NO') return 'NAY';
  if (t.includes('NOT')) return 'NOT_VOTING';
  return null;
}

function parseDate(v: unknown): Date | null {
  const t = S(v);
  // Accepts both 'NA' and the legacy 'N/A': handoff v2 §3 says read both
  // spellings, write only 'NA'.
  if (!t || t === 'NA' || t === 'N/A') return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

const congressOf = (billId: unknown): string => /-(\d{3})$/.exec(S(billId))?.[1] ?? '';

// ---- Reference data, transcribed verbatim from the source -----------------

const FLOOR_LEADERS: Record<string, Record<string, string>> = {
  '118': { S000148: 'MAJORITY_LEADER', M000355: 'MINORITY_LEADER' },
  '119': { T000250: 'MAJORITY_LEADER', S000148: 'MINORITY_LEADER' },
};

const PRESIDENT_BY_CONGRESS: Record<string, string> = {
  '117': 'BIDEN',
  '118': 'BIDEN',
  '119': 'TRUMP',
};

const BROAD_VEHICLE_RE =
  /continuing appropriations|consolidated appropriations|further appropriations|omnibus|minibus|authorize appropriations for fiscal year|making appropriations for the department|making appropriations for military construction|en bloc consideration/i;

const GENERIC_STAKEHOLDER_RE =
  /^(federal agencies|federal agencies and executive branch departments|department of defense|active duty military personnel|senators|u\.s\. senators|federal government|congress)$/i;

const BOUNDED_RE =
  /\b(this (bill|resolution|continuing resolution|CR|funding|legislation|year's)|these nominees|next week|this week|today|tomorrow|before (the )?(end of the week|[A-Z][a-z]+ \d{1,2})|fiscal year 20\d\d|FY ?20\d\d|President (Biden|Trump)|(Biden|Trump)'s (judicial )?nominees|the upcoming (NDAA|omnibus))\b/i;

const HINDER_BY_OMISSION_RE = /does not (provide|include|add)|not provide .*specific/i;

/**
 * Bills whose DIRECTION is itself the partisan dispute. Seeded from the audit;
 * grows from judge findings. Handoff v2 §8 lists s3386-119 as contested, so a
 * directional effect on it is a finding the tool is not entitled to make.
 */
const CONTESTED_BILLS = new Set(['s3386-119']);

const ACCUSATIONS = new Set(['BROKE', 'INCONSISTENT']);

// ---- Types ----------------------------------------------------------------

export type JudgeGateId =
  | 'G0_statement_qa'
  | 'G1_scope'
  | 'G2_split_vote'
  | 'G3_leader_switch'
  | 'G4_vehicle'
  | 'G5_prompt'
  | 'G6_confidence';

/** The failure classes the judge prompt's `failure_class` enum also carries. */
export type JudgeFailureClass =
  | 'STATEMENT_EXTRACTION'
  | 'BOUNDED_PROMISE'
  | 'BOUNDED_PROMISE_UNVERIFIED'
  | 'ADMIN_MISMATCH'
  | 'SPLIT_VOTE'
  | 'VOTE_PAIRING_ERROR'
  | 'LEADER_SWITCH'
  | 'SPONSOR_NAY_NOT_SWITCH'
  | 'BROAD_VEHICLE'
  | 'OBJECT_MISMATCH_OVERCONFIDENT'
  | 'CONTESTED_DIRECTION'
  | 'HINDER_BY_OMISSION'
  | 'OVERCONFIDENT';

export interface JudgeGateHit {
  gate: JudgeGateId;
  class: JudgeFailureClass;
  detail: string;
}

/** Which reference inputs were actually available, so a blind gate is visible. */
export interface JudgeGateCoverage {
  scope_fields: boolean;
  cloture_result: boolean;
}

export interface JudgeGateResult {
  fired: JudgeGateHit[];
  coverage: JudgeGateCoverage;
  /**
   * FAIL         a gate fired; the judge confirms or disputes it.
   * PENDING_LLM  an accusation with no gate hit — the judge decides.
   * PASS         not an accusation and nothing fired.
   */
  deterministic_grade: 'FAIL' | 'PENDING_LLM' | 'PASS';
}

/** The finished alignment row, as the judge layer reads it. */
export interface JudgeGateRow {
  promise_alignment: string;
  bill_effect: string;
  alignment_confidence: number | null;
  politician_id: string;
  bill_id: string;
  promise_text: string;
  bill_title: string;
  stakeholder_group?: string | null;
  cloture_vote?: string | null;
  passage_vote?: string | null;
  vote?: string | null;
  party_whip_vote?: string | null;
  is_sponsor?: boolean | string | null;
  is_cosponsor?: boolean | string | null;
  cloture_vote_date?: string | null;
  passage_vote_date?: string | null;
  action_date?: string | null;
  alignment_reasoning?: string | null;
  bill_effect_reasoning?: string | null;
  vote_flags?: string[] | string | null;
  match_verdict?: string | null;
  senator_role?: string | null;
  cloture_result?: string | null;
  scope?: string | null;
  valid_until?: string | null;
  statement_date?: string | null;
  promise_primary_issue?: string | null;
  promise_sub_issue?: string | null;
  bill_primary_issue?: string | null;
  bill_sub_issue?: string | null;
}

/**
 * Run G0..G6 over one finished row.
 *
 * Pure. Returns what a reviewer should dispute; assigns no verdict. A caller
 * that turns a hit into a verdict without the judge has skipped the layer this
 * exists to feed.
 */
export function judgeGates(r: JudgeGateRow): JudgeGateResult {
  const fired: JudgeGateHit[] = [];

  const verdict = U(r.promise_alignment);
  const effect = U(r.bill_effect);
  // §3: `Alignment Confidence` can legitimately hold the string NOT_EVALUATED,
  // so any numeric read needs a guard. NaN here means "no number", and every
  // comparison below is written so NaN never satisfies a threshold.
  const conf = typeof r.alignment_confidence === 'number' ? r.alignment_confidence : Number.NaN;
  const pol = S(r.politician_id);
  const billId = S(r.bill_id);
  const congress = congressOf(billId);
  const promise = S(r.promise_text);
  const title = S(r.bill_title);
  const stake = S(r.stakeholder_group);

  const cloture = voteOf(r.cloture_vote);
  const passage = voteOf(r.passage_vote);
  const whip = voteOf(r.party_whip_vote);
  const sponsored = truthy(r.is_sponsor) || truthy(r.is_cosponsor);

  const clotureDate = parseDate(r.cloture_vote_date);
  const passageDate = parseDate(r.passage_vote_date);
  const actionDate = passageDate ?? clotureDate ?? parseDate(r.action_date);

  const isAccusation = ACCUSATIONS.has(verdict);

  // ---- G0: statement integrity (cheap heuristics; the LLM judge does the rest)
  if (/\bour senators\b/i.test(promise) || /\bour delegation\b/i.test(promise)) {
    fired.push({
      gate: 'G0_statement_qa',
      class: 'STATEMENT_EXTRACTION',
      detail: 'first-person plural inconsistent with a senator speaking',
    });
  }

  // ---- G1: temporal / administration scope --------------------------------
  const scope = U(r.scope);
  const validUntil = parseDate(r.valid_until);
  const stmtDate = parseDate(r.statement_date);
  const coverage: JudgeGateCoverage = {
    scope_fields: Boolean(scope && (validUntil || scope === 'STANDING')),
    cloture_result: Boolean(S(r.cloture_result)),
  };
  const looksBounded = BOUNDED_RE.test(promise);

  if (scope === 'BOUNDED' && validUntil && actionDate && actionDate > validUntil) {
    fired.push({
      gate: 'G1_scope',
      class: 'BOUNDED_PROMISE',
      detail: `action ${actionDate.toISOString().slice(0, 10)} after Valid Until ${validUntil
        .toISOString()
        .slice(0, 10)}`,
    });
  } else if (
    !coverage.scope_fields &&
    looksBounded &&
    stmtDate &&
    actionDate &&
    actionDate.getTime() - stmtDate.getTime() > 180 * 86400000
  ) {
    // Fallback for when the scope columns are absent: bounded language plus a
    // >180-day gap is enough to ask the question, not to answer it.
    fired.push({
      gate: 'G1_scope',
      class: 'BOUNDED_PROMISE',
      detail: 'bounded language, action >180 days after statement (scope columns absent)',
    });
  } else if (!coverage.scope_fields && looksBounded && !stmtDate) {
    fired.push({
      gate: 'G1_scope',
      class: 'BOUNDED_PROMISE_UNVERIFIED',
      detail: 'bounded language, no statement date to test window',
    });
  }

  const adminMatch = /President (Biden|Trump)|(Biden|Trump)'s (judicial )?nominees/i.exec(promise);
  if (adminMatch && congress) {
    const named = U(adminMatch[1] ?? adminMatch[2]);
    if (PRESIDENT_BY_CONGRESS[congress] && PRESIDENT_BY_CONGRESS[congress] !== named) {
      fired.push({
        gate: 'G1_scope',
        class: 'ADMIN_MISMATCH',
        detail: `promise names ${named}; bill is ${congress}th Congress (${PRESIDENT_BY_CONGRESS[congress]})`,
      });
    }
  }

  // ---- G2: split votes and vote pairing ------------------------------------
  if (cloture && passage && cloture !== passage && cloture !== 'NOT_VOTING' && passage !== 'NOT_VOTING') {
    // Reads the reasoning ONLY to check it disclosed the split — never as
    // evidence for the verdict itself.
    const reasoning = S(r.alignment_reasoning);
    const namesBoth = /cloture/i.test(reasoning) && /passage/i.test(reasoning);
    const flags = Array.isArray(r.vote_flags) ? r.vote_flags.join(';') : S(r.vote_flags);
    const flagged = U(flags).includes('SPLIT_VOTE');
    if (!flagged || !namesBoth || (isAccusation && conf > 0.75)) {
      fired.push({
        gate: 'G2_split_vote',
        class: 'SPLIT_VOTE',
        detail: `cloture ${cloture} / passage ${passage}; flagged=${flagged} namesBoth=${namesBoth} conf=${conf}`,
      });
    }
  }
  if (clotureDate && passageDate && clotureDate > passageDate) {
    fired.push({
      gate: 'G2_split_vote',
      class: 'VOTE_PAIRING_ERROR',
      detail: 'cloture dated after passage — different bill version or bad join',
    });
  }

  // ---- G3: leader reconsideration switch -----------------------------------
  const role = U(r.senator_role) || FLOOR_LEADERS[congress]?.[pol] || 'NONE';
  const clotureResult = U(r.cloture_result);
  if (role !== 'NONE' && cloture === 'NAY' && whip === 'YEA') {
    if (!clotureResult || clotureResult === 'REJECTED' || clotureResult === 'FAILED') {
      if (verdict !== 'PROCEDURAL_SWITCH') {
        fired.push({
          gate: 'G3_leader_switch',
          class: 'LEADER_SWITCH',
          detail: `${role} NAY on cloture vs whip YEA${
            clotureResult ? ` (${clotureResult})` : ' (result unknown — verify)'
          }`,
        });
      }
    }
  }
  if (
    sponsored &&
    [cloture, passage, voteOf(r.vote)].includes('NAY') &&
    verdict !== 'PROCEDURAL_SWITCH'
  ) {
    fired.push({
      gate: 'G3_leader_switch',
      class: 'SPONSOR_NAY_NOT_SWITCH',
      detail: 'sponsor/co-sponsor with NAY must be PROCEDURAL_SWITCH',
    });
  }

  // ---- G4: broad vehicle / object ------------------------------------------
  const broad = BROAD_VEHICLE_RE.test(title);
  const genericStake = GENERIC_STAKEHOLDER_RE.test(stake);
  if (
    broad &&
    genericStake &&
    effect !== 'NEUTRAL' &&
    !['NOT_DETERMINABLE', 'PROCEDURAL_SWITCH'].includes(verdict)
  ) {
    fired.push({
      gate: 'G4_vehicle',
      class: 'BROAD_VEHICLE',
      detail: `broad vehicle "${title.slice(0, 60)}…" with generic stakeholder "${stake}"`,
    });
  }

  const pIssue = S(r.promise_primary_issue);
  const bIssue = S(r.bill_primary_issue);
  const pSub = S(r.promise_sub_issue);
  const bSub = S(r.bill_sub_issue);
  if (pIssue && bIssue && pIssue !== bIssue && pSub !== bSub && isAccusation && conf > 0.6) {
    fired.push({
      gate: 'G4_vehicle',
      class: 'OBJECT_MISMATCH_OVERCONFIDENT',
      detail: `issue ${pIssue}/${pSub} vs ${bIssue}/${bSub} at conf ${conf}`,
    });
  }

  if (CONTESTED_BILLS.has(billId.toLowerCase()) && effect !== 'CONTESTED' && effect !== 'NEUTRAL') {
    fired.push({
      gate: 'G4_vehicle',
      class: 'CONTESTED_DIRECTION',
      detail: 'bill on contested-direction list',
    });
  }

  // ---- G5: HINDER justified by the absence of a provision ------------------
  // v7 states the rule ("Absence of a provision is never HINDER"); this catches
  // the model asserting it anyway.
  if (effect === 'HINDER' && HINDER_BY_OMISSION_RE.test(S(r.bill_effect_reasoning))) {
    fired.push({
      gate: 'G5_prompt',
      class: 'HINDER_BY_OMISSION',
      detail: 'HINDER justified by absence of a provision',
    });
  }

  // ---- G6: confidence policy for accusations -------------------------------
  if (isAccusation) {
    const partial = U(r.match_verdict) === 'PARTIAL';
    const split = Boolean(cloture && passage && cloture !== passage);
    if (conf >= 0.85 && (partial || broad || split)) {
      fired.push({
        gate: 'G6_confidence',
        class: 'OVERCONFIDENT',
        detail: `conf ${conf} on partial/broad/split evidence`,
      });
    }
  }

  return {
    fired,
    coverage,
    deterministic_grade: fired.length ? 'FAIL' : isAccusation ? 'PENDING_LLM' : 'PASS',
  };
}
