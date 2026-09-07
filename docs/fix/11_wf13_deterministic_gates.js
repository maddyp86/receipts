// ===================================================================
// WF13 VERDICT JUDGE — DETERMINISTIC GATES (node 8) + METRICS (node 30)
// ===================================================================
// Paste-ready n8n Code node ("Run Once for All Items").
//
// Input items: alignment rows from `Promise Alignment - Matches` (one per item),
//   optionally pre-joined with:
//     - gold row from wf10a_broke_gold_set.csv (fields prefixed `gold_`)
//     - Senator Role, Cloture Result, Statement Date, Scope, Valid Until,
//       Anchor Entity, Action Date  (Steps 1-4 of the plan add these; grader
//       fails open when they're missing and reports coverage)
//
// Output: one item per row with `gate_results`, `deterministic_grade`, plus one
//   trailing METRICS item. Feed each row + gate_results to the LLM grader
//   (wf10a_grader_system_prompt.md) as the second layer.
//
// This is the layer the LLM cannot talk its way past. It is independent of
// WF10a: it reads only the row and reference data, never the evaluator prompt.
// ===================================================================

const S  = (v) => (v === null || v === undefined ? '' : String(v).trim());
const U  = (v) => S(v).toUpperCase();
const pick = (o, name) => {
  const t = S(name).toLowerCase();
  for (const k of Object.keys(o || {})) if (S(k).toLowerCase() === t) return o[k];
  return undefined;
};
const truthy = (v) => ['TRUE','YES','Y','1'].includes(U(v));
const voteOf = (v) => {
  const t = U(v);
  if (['YEA','AYE','YES'].includes(t)) return 'YEA';
  if (['NAY','NO'].includes(t)) return 'NAY';
  if (t.includes('NOT')) return 'NOT_VOTING';
  return null;
};
const parseDate = (v) => {
  const t = S(v);
  if (!t || t === 'NA' || t === 'N/A') return null;
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d;
};

// ---------------- REFERENCE DATA ----------------
// Floor leaders by Congress. Extend as the cohort grows.
const FLOOR_LEADERS = {
  '118': { S000148: 'MAJORITY_LEADER', M000355: 'MINORITY_LEADER' },
  '119': { T000250: 'MAJORITY_LEADER', S000148: 'MINORITY_LEADER' }
};
// Administration by Congress (for ADMIN_MISMATCH).
const PRESIDENT_BY_CONGRESS = { '117': 'BIDEN', '118': 'BIDEN', '119': 'TRUMP' };

const BROAD_VEHICLE_RE = /continuing appropriations|consolidated appropriations|further appropriations|omnibus|minibus|authorize appropriations for fiscal year|making appropriations for the department|making appropriations for military construction|en bloc consideration/i;
const GENERIC_STAKEHOLDER_RE = /^(federal agencies|federal agencies and executive branch departments|department of defense|active duty military personnel|senators|u\.s\. senators|federal government|congress)$/i;
const BOUNDED_RE = /\b(this (bill|resolution|continuing resolution|CR|funding|legislation|year's)|these nominees|next week|this week|today|tomorrow|before (the )?(end of the week|[A-Z][a-z]+ \d{1,2})|fiscal year 20\d\d|FY ?20\d\d|President (Biden|Trump)|(Biden|Trump)'s (judicial )?nominees|the upcoming (NDAA|omnibus))\b/i;
const CONTESTED_BILLS = new Set(['s3386-119']); // seed; grows from grader findings

const congressOf = (billId) => { const m = S(billId).match(/-(\d{3})$/); return m ? m[1] : ''; };

// ---------------- GATES ----------------
function runGates(r) {
  const fired = [];
  const coverage = {};

  const verdict   = U(pick(r, 'Promise Alignment'));
  const effect    = U(pick(r, 'Bill Effect'));
  const conf      = parseFloat(pick(r, 'Alignment Confidence'));
  const pol       = S(pick(r, 'Politician ID'));
  const billId    = S(pick(r, 'Bill ID'));
  const congress  = congressOf(billId);
  const promise   = S(pick(r, 'Promise Text'));
  const title     = S(pick(r, 'Bill Title'));
  const stake     = S(pick(r, 'Stakeholder Group'));
  const cloture   = voteOf(pick(r, 'Cloture Vote'));
  const passage   = voteOf(pick(r, 'Passage Vote'));
  const whip      = voteOf(pick(r, 'Party Whip Vote'));
  const sponsored = truthy(pick(r, 'Is Sponsor')) || truthy(pick(r, 'Is Co-Sponsor'));
  const clotureDate = parseDate(pick(r, 'Cloture Vote Date'));
  const passageDate = parseDate(pick(r, 'Passage Vote Date'));
  const actionDate  = passageDate || clotureDate || parseDate(pick(r, 'Action Date'));

  // ---- G0: statement integrity (cheap heuristics only; LLM grader does the rest)
  if (/\bour senators\b/i.test(promise) || /\bour delegation\b/i.test(promise)) {
    fired.push({ gate: 'G0_statement_qa', class: 'STATEMENT_EXTRACTION', detail: 'first-person plural inconsistent with a senator speaking' });
  }

  // ---- G1: temporal / administration scope
  const scope = U(pick(r, 'Scope'));
  const validUntil = parseDate(pick(r, 'Valid Until'));
  const stmtDate = parseDate(pick(r, 'Statement Date'));
  coverage.scope_fields = !!(scope && (validUntil || scope === 'STANDING'));
  const looksBounded = BOUNDED_RE.test(promise);
  if (scope === 'BOUNDED' && validUntil && actionDate && actionDate > validUntil) {
    fired.push({ gate: 'G1_scope', class: 'BOUNDED_PROMISE', detail: `action ${actionDate.toISOString().slice(0,10)} after Valid Until ${validUntil.toISOString().slice(0,10)}` });
  } else if (!coverage.scope_fields && looksBounded && stmtDate && actionDate && (actionDate - stmtDate) > 180*86400000) {
    // Fallback when Step 1 columns are absent: bounded language + >180 days = flag.
    fired.push({ gate: 'G1_scope', class: 'BOUNDED_PROMISE', detail: 'bounded language, action >180 days after statement (scope columns absent)' });
  } else if (!coverage.scope_fields && looksBounded && !stmtDate) {
    fired.push({ gate: 'G1_scope', class: 'BOUNDED_PROMISE_UNVERIFIED', detail: 'bounded language, no statement date to test window' });
  }
  const adminMatch = promise.match(/President (Biden|Trump)|(Biden|Trump)'s (judicial )?nominees/i);
  if (adminMatch && congress) {
    const named = (adminMatch[1] || adminMatch[2]).toUpperCase();
    if (PRESIDENT_BY_CONGRESS[congress] && PRESIDENT_BY_CONGRESS[congress] !== named) {
      fired.push({ gate: 'G1_scope', class: 'ADMIN_MISMATCH', detail: `promise names ${named}; bill is ${congress}th Congress (${PRESIDENT_BY_CONGRESS[congress]})` });
    }
  }

  // ---- G2: split votes and vote pairing
  if (cloture && passage && cloture !== passage && !['NOT_VOTING'].includes(cloture) && !['NOT_VOTING'].includes(passage)) {
    const reasoning = S(pick(r, 'Alignment Reasoning'));
    const namesBoth = /cloture/i.test(reasoning) && /passage/i.test(reasoning);
    const flagged = U(pick(r, 'Vote Flags')).includes('SPLIT_VOTE');
    if (!flagged || !namesBoth || (['BROKE','INCONSISTENT'].includes(verdict) && conf > 0.75)) {
      fired.push({ gate: 'G2_split_vote', class: 'SPLIT_VOTE', detail: `cloture ${cloture} / passage ${passage}; flagged=${flagged} namesBoth=${namesBoth} conf=${conf}` });
    }
  }
  if (clotureDate && passageDate && clotureDate > passageDate) {
    fired.push({ gate: 'G2_split_vote', class: 'VOTE_PAIRING_ERROR', detail: 'cloture dated after passage — different bill version or bad join' });
  }

  // ---- G3: leader reconsideration switch
  const role = U(pick(r, 'Senator Role')) || (FLOOR_LEADERS[congress] || {})[pol] || 'NONE';
  const clotureResult = U(pick(r, 'Cloture Result'));
  coverage.cloture_result = !!clotureResult;
  if (role !== 'NONE' && cloture === 'NAY' && whip === 'YEA') {
    if (!clotureResult || clotureResult === 'REJECTED' || clotureResult === 'FAILED') {
      if (verdict !== 'PROCEDURAL_SWITCH') {
        fired.push({ gate: 'G3_leader_switch', class: 'LEADER_SWITCH', detail: `${role} NAY on cloture vs whip YEA${clotureResult ? ' (' + clotureResult + ')' : ' (result unknown — verify)'}` });
      }
    }
  }
  if (sponsored && [cloture, passage, voteOf(pick(r,'Vote'))].includes('NAY') && verdict !== 'PROCEDURAL_SWITCH') {
    fired.push({ gate: 'G3_leader_switch', class: 'SPONSOR_NAY_NOT_SWITCH', detail: 'sponsor/co-sponsor with NAY must be PROCEDURAL_SWITCH' });
  }

  // ---- G4: broad vehicle / object
  const broad = BROAD_VEHICLE_RE.test(title);
  const genericStake = GENERIC_STAKEHOLDER_RE.test(stake);
  if (broad && genericStake && effect !== 'NEUTRAL' && !['NOT_DETERMINABLE','PROCEDURAL_SWITCH'].includes(verdict)) {
    fired.push({ gate: 'G4_vehicle', class: 'BROAD_VEHICLE', detail: `broad vehicle "${title.slice(0,60)}…" with generic stakeholder "${stake}"` });
  }
  const pIssue = S(pick(r,'Promise Primary Issue')), bIssue = S(pick(r,'Bill Primary Issue'));
  const pSub = S(pick(r,'Promise Sub Issue')),  bSub = S(pick(r,'Bill Sub Issue'));
  if (pIssue && bIssue && pIssue !== bIssue && pSub !== bSub && ['BROKE','INCONSISTENT'].includes(verdict) && conf > 0.6) {
    fired.push({ gate: 'G4_vehicle', class: 'OBJECT_MISMATCH_OVERCONFIDENT', detail: `issue ${pIssue}/${pSub} vs ${bIssue}/${bSub} at conf ${conf}` });
  }
  if (CONTESTED_BILLS.has(billId.toLowerCase()) && effect !== 'CONTESTED' && effect !== 'NEUTRAL') {
    fired.push({ gate: 'G4_vehicle', class: 'CONTESTED_DIRECTION', detail: 'bill on contested-direction list' });
  }
  if (effect === 'HINDER' && /does not (provide|include|add)|not provide .*specific/i.test(S(pick(r,'Bill Effect Reasoning')))) {
    fired.push({ gate: 'G5_prompt', class: 'HINDER_BY_OMISSION', detail: 'HINDER justified by absence of a provision' });
  }

  // ---- G6: confidence policy for accusations
  if (['BROKE','INCONSISTENT'].includes(verdict)) {
    const partial = U(pick(r,'Match Verdict')) === 'PARTIAL';
    if (conf >= 0.85 && (partial || broad || (cloture && passage && cloture !== passage))) {
      fired.push({ gate: 'G6_confidence', class: 'OVERCONFIDENT', detail: `conf ${conf} on partial/broad/split evidence` });
    }
  }

  return { fired, coverage };
}

// ---------------- MAIN ----------------
const items = $input.all();
const out = [];
const metrics = {
  rows: 0, broke_rows: 0, broke_flagged: 0, broke_passed_gates: 0,
  by_class: {}, by_gate: {},
  gold: { rows: 0, agree: 0, disagree: 0, gate_attribution_match: 0, fp_still_broke: [] },
  coverage: { scope_fields: 0, cloture_result: 0 }
};

for (const item of items) {
  const r = item.json;
  const { fired, coverage } = runGates(r);
  const verdict = U(pick(r, 'Promise Alignment'));
  const isAccusation = ['BROKE','INCONSISTENT'].includes(verdict);

  metrics.rows++;
  if (coverage.scope_fields) metrics.coverage.scope_fields++;
  if (coverage.cloture_result) metrics.coverage.cloture_result++;
  if (isAccusation) {
    metrics.broke_rows++;
    if (fired.length) metrics.broke_flagged++; else metrics.broke_passed_gates++;
  }
  for (const f of fired) {
    metrics.by_class[f.class] = (metrics.by_class[f.class] || 0) + 1;
    metrics.by_gate[f.gate]   = (metrics.by_gate[f.gate]   || 0) + 1;
  }

  // ---- gold comparison (if joined)
  const goldExpected = U(pick(r, 'gold_expected_verdict'));
  const goldGate = S(pick(r, 'gold_gate_that_should_catch'));
  let goldAgreement = 'NO_GOLD';
  if (goldExpected) {
    metrics.gold.rows++;
    const ok = verdict === goldExpected
      || (goldExpected.startsWith('NOT_APPLICABLE') && verdict.startsWith('NOT_APPLICABLE'));
    if (ok) { metrics.gold.agree++; goldAgreement = 'AGREE'; }
    else {
      metrics.gold.disagree++; goldAgreement = 'DISAGREE';
      if (isAccusation && goldExpected !== 'BROKE') metrics.gold.fp_still_broke.push(S(pick(r,'row_number')) || S(pick(r,'Promise Alignment UID')));
    }
    if (goldGate && goldGate !== 'none' && fired.some(f => f.gate === goldGate)) metrics.gold.gate_attribution_match++;
    else if (goldGate === 'none' && !fired.length) metrics.gold.gate_attribution_match++;
  }

  out.push({ json: {
    ...r,
    gate_results: fired,
    gate_coverage: coverage,
    deterministic_grade: fired.length ? 'FAIL' : (isAccusation ? 'PENDING_LLM' : 'PASS'),
    gold_agreement: goldAgreement
  }});
}

// ---- metrics item
const m = metrics;
m.broke_precision_proxy = m.broke_rows ? (m.broke_passed_gates / m.broke_rows) : null; // share of accusations with no gate hit
m.gold_agreement_rate   = m.gold.rows ? (m.gold.agree / m.gold.rows) : null;
m.gate_attribution_rate = m.gold.rows ? (m.gold.gate_attribution_match / m.gold.rows) : null;
m.gate_pass = m.gold.rows ? (m.gold.fp_still_broke.length === 0) : null; // Step 8 criterion 1
console.log('[GRADER] ' + JSON.stringify(m));
out.push({ json: { _metrics: true, ...m } });

return out;
