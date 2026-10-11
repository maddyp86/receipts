// ===================================================================
// v2 PIPELINE: DAILY STATEMENT COPY (parallel run only; retired at cutover).
//   Impact Statements             -> core.bill_impacts, version_code NULL
//   Affected Stakeholders         -> the stakeholders on that row
//   Impact Statements - Versions  -> core.bill_impacts, one per text version
//
// Until cutover the old pipeline writes the impact statements; this copies
// them into core each day with the Phase 1 import's rules, so the statements
// are generated once and paid for once. Bills are NOT copied: the new
// pipeline fills core.bills itself, and copying them would hide its mistakes.
//
// A row changes only when one of its values differs; content_changed_at then
// moves, which is how the embeddings workflow finds what to re-embed.
// A statement whose bill is not in core.bills is not written; it is reported,
// because it means the new pipeline has not picked the bill up.
// ===================================================================
const val = (o, n) => nz(pick(o, n));
const bool = (o, n) => { const s = S(pick(o, n)).toUpperCase(); return s === 'TRUE' || s === 'YES' ? true : (s === 'FALSE' || s === 'NO' ? false : null); };
const num = (o, n, id) => { const s = val(o, n); if (s === null) return null; const x = Number(s.replace(/,/g, '')); if (!Number.isFinite(x)) { problem(id, n, s, 'not a number'); return null; } return x; };
const day = (o, n, id) => {
  const s = val(o, n);
  if (s === null) return null;
  let m = s.match(/^([0-9]{4})-([0-9]{2})-([0-9]{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = s.match(/^([0-9]{1,2})[/]([0-9]{1,2})[/]([0-9]{4})$/);
  if (m) return m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0');
  problem(id, n, s, 'not a date');
  return null;
};
const ts = (o, n, id) => { const s = val(o, n); if (s === null) return null; const d = new Date(s); if (isNaN(d)) { problem(id, n, s, 'not a timestamp'); return null; } return d.toISOString(); };

const stmtRows = $('Read Impact Statements').all().map((i) => i.json).filter((r) => S(pick(r, 'Impact UID')));
const stakeRows = $('Read Affected Stakeholders').all().map((i) => i.json).filter((r) => S(pick(r, 'Stakeholder UID')) || S(pick(r, 'Impact UID')));
const versionRows = $('Read Statement Versions').all().map((i) => i.json).filter((r) => S(pick(r, 'Impact Version UID')));
if (!stmtRows.length) throw new Error('[v2 statement copy] Impact Statements came back empty; refusing to treat that as "no statements".');

const stakeByImpact = new Map();
for (const r of stakeRows) {
  const suid = S(pick(r, 'Stakeholder UID'));
  const iuid = S(pick(r, 'Impact UID')) || suid.replace(/-S[0-9]+$/, '');
  if (!stakeByImpact.has(iuid)) stakeByImpact.set(iuid, []);
  stakeByImpact.get(iuid).push({ stakeholder_uid: suid || null, group: val(r, 'Stakeholder Group'), positive: val(r, 'Positive Impacts'), negative: val(r, 'Negative Impacts') });
}
const statementFields = (r, id) => ({
  title: val(r, 'Title'), policy_area: val(r, 'Policy Area'), primary_issue: val(r, 'Primary Issue'), sub_issue: val(r, 'Sub Issue'),
  keywords: val(r, 'Bill Keywords'), intended_effects: val(r, 'Intended Effects'), mechanisms: val(r, 'Mechanisms'), summary: val(r, 'Summary'),
  reverses_existing_policy: bool(r, 'Reverses Existing Policy'), target_type: val(r, 'Target Type'), target_name: val(r, 'Target Name'),
  target_source: val(r, 'Target Source'), target_effect: val(r, 'Target Effect'), direction_confidence: num(r, 'Direction Confidence', id),
  flagged_for_review: bool(r, 'Flagged For Review') === true,
});

const impacts = [];
const ids = new Set();
const billLevel = new Set();
for (const r of stmtRows) {
  const id = S(pick(r, 'Impact UID'));
  const bill = S(pick(r, 'Bill ID'));
  if (ids.has(id)) { problem(id, 'Impact UID', id, 'duplicate statement; first kept'); continue; }
  if (billLevel.has(bill)) { problem(id, 'Bill ID', bill, 'second bill-level statement for this bill; skipped'); continue; }
  ids.add(id); billLevel.add(bill);
  impacts.push(Object.assign({
    impact_id: id, bill_id: bill, version_code: null, version_type: null, version_date: null, text_url: null,
    summary_action_date: null, run_id: null, generated_at: null, reviewed: val(r, 'Reviewed'),
    taxonomy_divergent: null, taxonomy_divergence_detail: null, version_mismatch: null, version_title_source: null,
    stakeholders: stakeByImpact.get(id) || [],
  }, statementFields(r, id)));
}
const versionKey = new Set();
for (const r of versionRows) {
  const id = S(pick(r, 'Impact Version UID'));
  const bill = S(pick(r, 'Bill ID'));
  const code = S(pick(r, 'Text Version Code')).toLowerCase();
  if (!code) { problem(id, 'Text Version Code', '', 'blank version code; skipped'); continue; }
  if (ids.has(id)) { problem(id, 'Impact Version UID', id, 'duplicate id; first kept'); continue; }
  if (versionKey.has(bill + '|' + code)) { problem(id, 'Text Version Code', bill + ' ' + code, 'second statement for this bill and version; skipped'); continue; }
  let stake = [];
  const raw = val(r, 'Affected Stakeholders JSON');
  if (raw) {
    try { stake = JSON.parse(raw).map((x) => ({ stakeholder_uid: null, group: S(x.stakeholder_group) || null, positive: S(x.positive_impact) || null, negative: S(x.negative_impact) || null })); }
    catch (e) { problem(id, 'Affected Stakeholders JSON', raw, 'not valid JSON; stakeholders left empty'); }
  }
  ids.add(id); versionKey.add(bill + '|' + code);
  impacts.push(Object.assign({
    impact_id: id, bill_id: bill, version_code: code, version_type: val(r, 'Text Version Type'), version_date: day(r, 'Text Version Date', id),
    text_url: val(r, 'Text URL'), summary_action_date: day(r, 'Summary Action Date', id), run_id: val(r, 'Run ID'),
    generated_at: ts(r, 'Generated At', id), reviewed: null, taxonomy_divergent: bool(r, 'Taxonomy Divergent'),
    taxonomy_divergence_detail: val(r, 'Taxonomy Divergence Detail'), version_mismatch: bool(r, 'Version Mismatch'),
    version_title_source: val(r, 'Version Title Source'), stakeholders: stake,
  }, statementFields(r, id)));
}

const SPEC = {
  impact_id: 'text', bill_id: 'text', version_code: 'text', version_type: 'text', version_date: 'date',
  text_url: 'text', summary_action_date: 'date', run_id: 'text', generated_at: 'timestamptz', title: 'text',
  policy_area: 'text', primary_issue: 'text', sub_issue: 'text', keywords: 'text', reviewed: 'text',
  intended_effects: 'text', mechanisms: 'text', summary: 'text', reverses_existing_policy: 'boolean',
  target_type: 'text', target_name: 'text', target_source: 'text', target_effect: 'text',
  direction_confidence: 'numeric', flagged_for_review: 'boolean', taxonomy_divergent: 'boolean',
  taxonomy_divergence_detail: 'text', version_mismatch: 'boolean', version_title_source: 'text',
  stakeholders: 'jsonb',
};
// Only statements whose bill core already holds; the rest are reported below.
const onlyHeldBills = (s) => Object.assign(s, { sql: s.sql.replace(' ON CONFLICT', ' WHERE EXISTS (SELECT 1 FROM core.bills b WHERE b.bill_id = x."bill_id") ON CONFLICT') });
const statements = upsert('bill_impacts', SPEC, ['impact_id'], impacts, { chunk: 150, guard: true, changedAt: 'content_changed_at' }).map(onlyHeldBills);
const previews = [
  preview('bill_impacts', SPEC, ['impact_id'], impacts),
  { table: 'statements_without_bill_in_core', rows: impacts.length,
    sql: "SELECT 'statements_without_bill_in_core' AS \"table\", count(*) AS rows, count(*) AS new_rows, jsonb_agg(x.bill_id ORDER BY x.bill_id) AS new_keys, '{}'::jsonb AS changes " +
      'FROM jsonb_to_recordset($1::jsonb) AS x(bill_id text) WHERE NOT EXISTS (SELECT 1 FROM core.bills b WHERE b.bill_id = x.bill_id);',
    payload: JSON.stringify(impacts.map((i) => ({ bill_id: i.bill_id }))) },
];

return emit(statements, previews, {
  workflow: 'statement copy',
  statements_in: stmtRows.length,
  bill_level: billLevel.size,
  versions_in: versionRows.length,
  versions: versionKey.size,
  stakeholder_rows_in: stakeRows.length,
  bill_impacts: impacts.length,
  errors: [],
});
