// ===================================================================
// v2 PIPELINE: IMPACT STATEMENTS, last step. What the run produced.
//   plan    no writes beyond the run row: how many bills, from what source,
//           how many title-only, and the estimated model cost
//   sample  each parsed and taxonomy-checked statement -> core.impact_drafts
//   live    each statement -> core.bill_impacts (bill-level keyed as WF5 keys
//           the Impact Statements tab, versions as it keys the Versions tab);
//           source_changed is cleared on the changed bills it handled
//
// The statement itself comes from WF5's own Parse JSON and Flatten Impact
// Statements, unchanged. Model tokens and web searches are read from each
// Create Impact Statements run and priced with the Config rates.
// ===================================================================
const mode = S(cfg.statements_mode || 'plan').toLowerCase();
const limitRows = $('Limit').all().map((i) => i.json).filter((r) => !r._empty);
const runOf = (node, idx) => { try { const it = $(node).all(0, idx); return it && it[0] ? it[0].json : null; } catch (e) { return null; } };
const rates = { input: Number(cfg.usd_per_m_input) || 0, output: Number(cfg.usd_per_m_output) || 0, search: Number(cfg.usd_per_web_search) || 0 };

// ---- per bill: what context the model got ----
const perBill = limitRows.map((r, idx) => {
  const p = runOf('Prepare Bill Context', idx) || {};
  const x = runOf('Extract Bill Summary', idx) || {};
  const textChars = S(x.bill_summary_text).length;
  // Title only: no published text and no summary either. Text that was fetched
  // but unusable is flagged instead, so the bill is not re-run every day.
  const titleOnly = !S(r.requested_version) && !S(p.bill_text_url) && !textChars;
  return { bill_id: r['Bill ID'], version: S(r.requested_version) || null, content_source: p.bill_content_source || null,
    text_chars: textChars, title_only: titleOnly, summary_error: S(x.bill_summary_error) || null, redo_title_only: !!r.redo_title_only };
});

// ---- model usage, per run of the model node ----
let inTok = 0, outTok = 0, searches = 0;
const usageByIdx = [];
if (mode !== 'plan') {
  for (let idx = 0; idx < limitRows.length; idx++) {
    const resp = runOf('Create Impact Statements', idx) || {};
    const u = resp.usage || {};
    const ws = (resp.output || []).filter((o) => o && o.type === 'web_search_call').length;
    inTok += Number(u.input_tokens) || 0; outTok += Number(u.output_tokens) || 0; searches += ws;
    usageByIdx.push({ input_tokens: u.input_tokens || null, output_tokens: u.output_tokens || null, web_searches: ws, model: resp.model || null });
  }
}
const costUsd = Math.round((inTok / 1e6 * rates.input + outTok / 1e6 * rates.output + searches * rates.search) * 10000) / 10000;

// ---- plan: estimate what a live run would cost ----
const refs = ['Policy Area Code Node', 'Taxonomy Code Node', 'Subject Area Code'].map((n) => { try { return JSON.stringify($(n).first().json).length; } catch (e) { return 0; } });
const promptChars = PROMPT_CHARS + refs.reduce((a, b) => a + b, 0);
const estInput = perBill.reduce((a, b) => a + Math.ceil((promptChars + b.text_chars) / 4), 0);
const estCost = Math.round((estInput / 1e6 * rates.input + perBill.length * 1500 / 1e6 * rates.output + perBill.length * rates.search) * 100) / 100;

// ---- the statements WF5 would write ----
let parsed = [], flat = [];
if (mode !== 'plan') {
  try { parsed = $('Parse JSON').all().map((i) => i.json); } catch (e) { parsed = []; }
  try { flat = $('Flatten Impact Statements').all().map((i) => i.json).filter((f) => f && f.bill_id); } catch (e) { flat = []; }
}
const keyOf = (bill, ver) => bill + '|' + (S(ver) || '');
const flatByKey = new Map(flat.map((f) => [keyOf(f.bill_id, f.requested_version), f]));
const idxByKey = new Map(limitRows.map((r, i) => [keyOf(r['Bill ID'], r.requested_version), i]));
const notWritten = parsed.filter((p) => !flatByKey.has(keyOf(p.bill_id, p.requested_version)))
  .map((p) => ({ bill_id: p.bill_id, version: p.requested_version || null, why: p.error || 'skipped by the taxonomy gate or a guard (see the Flatten log)' }));

// WF5 "Add Impact Version": the Impact Version UID.
const versionUid = (bill, ver) => {
  const key = String(bill || '') + '|' + String(ver || '');
  let h1 = 5381, h2 = 52711, h3 = 104729;
  for (let i = 0; i < key.length; i++) { const c = key.charCodeAt(i); h1 = (((h1 << 5) + h1) ^ c) >>> 0; h2 = (((h2 << 7) + h2) + c * 31) >>> 0; h3 = (((h3 ^ (c * 131)) >>> 0) * 17) >>> 0; }
  return (h1.toString(36) + h2.toString(36) + h3.toString(36)).toUpperCase().slice(0, 10);
};

const statements = [];
const drafts = [];
const impacts = [];
for (const f of flat) {
  const idx = idxByKey.get(keyOf(f.bill_id, f.requested_version));
  const pb = idx === undefined ? {} : perBill[idx];
  const p = parsed.find((x) => keyOf(x.bill_id, x.requested_version) === keyOf(f.bill_id, f.requested_version)) || {};
  const ver = S(f.requested_version) || null;
  const ra = f.regulatory_action || {};
  const flags = { flag_for_review: !!p.flag_for_review, missing_fields: p.missing_fields || [], keywords_valid: p.keywords_valid,
    taxonomy_valid: p.taxonomy_valid, source_version_mismatch: !!p.source_version_mismatch, schema_normalized: !!p.schema_normalized,
    taxonomy_divergent: !!f.taxonomy_divergent, summary_error: pb.summary_error || null };
  if (mode === 'sample') {
    drafts.push({ bill_id: f.bill_id, version_code: ver, model: (usageByIdx[idx] || {}).model || 'gpt-5.4-mini', content_source: pb.content_source || null,
      title_only: !!pb.title_only, statement: f, flags, usage: usageByIdx[idx] || null });
  } else if (mode === 'live') {
    // Flatten Stakeholders: S1, S2... under the statement's UID; blank sides read "None identified".
    const stake = ver
      ? (f.affected_stakeholders || []).map((s) => ({ stakeholder_uid: null, group: s.stakeholder_group || null, positive: s.positive_impact || null, negative: s.negative_impact || null }))
      : (f.affected_stakeholders || []).map((s, i) => ({ stakeholder_uid: f.impact_uid + '-S' + (i + 1), group: s.stakeholder_group || null,
        positive: s.positive_impact || 'None identified', negative: s.negative_impact || 'None identified' }));
    impacts.push({
      impact_id: ver ? versionUid(f.bill_id, ver) : f.impact_uid, bill_id: f.bill_id, version_code: ver,
      version_type: ver ? (f.requested_version_type || null) : null, version_date: ver ? (f.requested_version_date || null) : null,
      text_url: ver ? (f.requested_text_url || null) : null, summary_action_date: ver ? (f.summary_action_date || null) : null,
      run_id: ver ? S(cfg.run_label) || null : null, generated_at: ver ? new Date().toISOString() : null,
      title: ver ? (f.version_title || f.title) : f.title, policy_area: f.policy_area_raw || null, primary_issue: f.issue_primary || null,
      sub_issue: f.issue_sub || null, keywords: f.bill_keywords || null, intended_effects: f.intended_effects || null,
      mechanisms: f.mechanisms || null, summary: f.neutral_summary || null,
      reverses_existing_policy: ra.reverses_existing_policy === true, target_type: ra.target_type || null, target_name: ra.target_name || null,
      target_source: ra.target_source || null, target_effect: ra.target_effect || null, direction_confidence: ra.direction_confidence,
      // WF5 flags version rows only; v2 flags bill-level rows too, now that their text is fetched.
      flagged_for_review: flags.flag_for_review || /unusable/.test(S(pb.summary_error)),
      taxonomy_divergent: ver ? !!f.taxonomy_divergent : null, taxonomy_divergence_detail: ver ? (f.taxonomy_divergence_detail || 'NA') : null,
      version_mismatch: ver ? flags.source_version_mismatch : null, version_title_source: ver ? (p.version_title_source || 'NA') : null,
      title_only: !!pb.title_only, stakeholders: stake,
    });
  }
}

if (drafts.length) {
  statements.push({ table: 'impact_drafts', rows: drafts.length, payload: JSON.stringify(drafts),
    sql: 'INSERT INTO core.impact_drafts (run_id, bill_id, version_code, model, content_source, title_only, statement, flags, usage) ' +
      'SELECT $2::bigint, x.bill_id, x.version_code, x.model, x.content_source, x.title_only, x.statement, x.flags, x.usage ' +
      'FROM jsonb_to_recordset($1::jsonb) AS x(bill_id text, version_code text, model text, content_source text, title_only boolean, statement jsonb, flags jsonb, usage jsonb);' });
}
const SPEC = {
  impact_id: 'text', bill_id: 'text', version_code: 'text', version_type: 'text', version_date: 'date', text_url: 'text',
  summary_action_date: 'date', run_id: 'text', generated_at: 'timestamptz', title: 'text', policy_area: 'text', primary_issue: 'text',
  sub_issue: 'text', keywords: 'text', intended_effects: 'text', mechanisms: 'text', summary: 'text', reverses_existing_policy: 'boolean',
  target_type: 'text', target_name: 'text', target_source: 'text', target_effect: 'text', direction_confidence: 'numeric',
  flagged_for_review: 'boolean', taxonomy_divergent: 'boolean', taxonomy_divergence_detail: 'text', version_mismatch: 'boolean',
  version_title_source: 'text', title_only: 'boolean', stakeholders: 'jsonb',
};
const previews = [];
if (impacts.length) {
  for (const s of upsert('bill_impacts', SPEC, ['impact_id'], impacts, { chunk: 100, guard: true, changedAt: 'content_changed_at' })) statements.push(s);
  previews.push(preview('bill_impacts', SPEC, ['impact_id'], impacts));
  const handled = Array.from(new Set(limitRows.filter((r) => S(r.requested_version)).map((r) => r['Bill ID'])))
    .concat(($('Build Version Requests').first().json.queue || []).filter((q) => q.reason !== 'FETCH_FAILED').map((q) => q.bill_id));
  if (handled.length) statements.push({ table: 'bills', rows: handled.length, payload: JSON.stringify(handled.map((b) => ({ bill_id: b }))),
    sql: 'UPDATE core.bills t SET source_changed = false, updated_at = now() FROM jsonb_to_recordset($1::jsonb) AS x(bill_id text) WHERE t.bill_id = x.bill_id AND t.source_changed;' });
}

const cand = $('Get Candidates').first().json;
const ver = $('Build Version Requests').first().json;
return emit(statements, previews, {
  workflow: 'impact statements',
  mode,
  budget_stop: !!(limitRows[0] && limitRows[0]._budget_stop) || !!($('Limit').first().json._budget_stop),
  month_spend_usd_before: Number(cand.month_spend_usd) || 0,
  bills_without_statement: (cand.main || []).length,
  title_only_to_redo: (cand.main || []).filter((r) => r.redo_title_only).length,
  changed_bills: (cand.changed || []).length,
  version_check: ver.counts,
  processed: limitRows.length,
  by_content_source: perBill.reduce((a, b) => { a[b.content_source || 'none'] = (a[b.content_source || 'none'] || 0) + 1; return a; }, {}),
  title_only: perBill.filter((b) => b.title_only).map((b) => b.bill_id),
  est_input_tokens: estInput,
  est_cost_usd_if_live: estCost,
  model_input_tokens: inTok,
  model_output_tokens: outTok,
  web_searches: searches,
  cost_usd: costUsd,
  rates,
  written: mode === 'sample' ? drafts.length : impacts.length,
  not_written: notWritten,
  bills: perBill.slice(0, 80),
  errors: [],
});
