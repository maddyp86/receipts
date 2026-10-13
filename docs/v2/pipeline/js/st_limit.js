// ===================================================================
// v2 PIPELINE: IMPACT STATEMENTS, step 4. The bills that go through WF5's
// loop this run, in order. Named "Limit" because WF5's Parse JSON pairs each
// model answer with this node's rows by position.
//
//   plan    every candidate (up to the caps): the bill context is built and
//           measured, and no model is called. The daily mode until cutover.
//   sample  the bills named in sample_bills, or else the first sample_size
//           candidates, go to the model; the statements
//           go to core.impact_drafts, never to core.bill_impacts.
//   live    up to cap bill-level statements and max_pairs version statements,
//           written to core.bill_impacts. Only after cutover.
//
// BUDGET STOP. sample and live stop before calling the model when this month's
// estimated spend has reached monthly_budget_usd.
// ===================================================================
const cand = $('Get Candidates').first().json;
const versions = $('Build Version Requests').first().json;
const mode = S(cfg.statements_mode || 'plan').toLowerCase();
if (['plan', 'sample', 'live'].indexOf(mode) === -1) throw new Error('[v2 statements] statements_mode must be plan, sample or live, not "' + mode + '".');
const cap = Number(cfg.cap) || 60;
const main = (cand.main || []).slice(0, cap).map((r) => Object.assign({}, r, { requested_version: '' }));
const vers = versions.requests || [];
let rows = main.concat(vers);
const spent = Number(cand.month_spend_usd) || 0;
const budget = Number(cfg.monthly_budget_usd) || 0;
let stopped = false;
// sample_bills names the bills to sample; otherwise the first candidates.
const named = (cand.named || []).map((r) => Object.assign({}, r, { requested_version: '' }));
if (mode === 'sample') rows = (named.length ? named : rows).slice(0, Number(cfg.sample_size) || 10);
if (mode !== 'plan' && budget && spent >= budget) { stopped = true; rows = []; }
console.log('[v2 statements] mode ' + mode + ' | ' + (cand.main || []).length + ' bills without a statement (cap ' + cap + ') | ' + vers.length + ' version pairs | ' + rows.length + ' to process' + (stopped ? ' | BUDGET STOP: ' + spent + ' of ' + budget + ' USD spent this month' : ''));
return rows.map((r) => ({ json: Object.assign(r, { _mode: mode, _budget_stop: stopped }) }));
