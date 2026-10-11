// ===================================================================
// v2 PIPELINE: EMBEDDINGS, step 1. The text each bill-level statement is
// embedded from, built exactly as Bill Embeddings (WF6) "Bill Embedding Code
// v13" builds pageContent. Nothing is added to it: the vector must stay
// comparable with the ones already stored.
//
// Candidates are statements with no embedding, no record of the text they
// were embedded from, or content changed since they were embedded. The next
// node hashes each text in the database and keeps only those whose hash
// differs from the one embedded.
// ===================================================================
const rows = $('Get Candidates').all().map((i) => i.json).filter((r) => r.impact_id);

// Approved Taxonomy: Taxonomy Keywords by (Primary Issue, Sub Issue), as WF6's
// "Merge Taxonomy Keywords" joins them.
const tax = new Map();
for (const it of $('Get Approved Taxonomy').all()) {
  const j = it.json || {};
  const key = S(pick(j, 'Primary Issue')) + '||' + S(pick(j, 'Sub Issue'));
  if (!tax.has(key)) tax.set(key, S(pick(j, 'Taxonomy Keywords')));
}

const out = [];
for (const r of rows) {
  const taxonomyKeywords = tax.get(S(r.primary_issue) + '||' + S(r.sub_issue)) || '';
  const billKeywords = r.keywords || '';
  let stakeholdersText = '';
  if (Array.isArray(r.stakeholders)) {
    stakeholdersText = r.stakeholders.map((sh) => {
      const parts = [];
      if (sh.group) parts.push('Stakeholder: ' + sh.group);
      if (sh.positive) parts.push('Benefits: ' + sh.positive);
      if (sh.negative) parts.push('Costs: ' + sh.negative);
      return parts.join(' | ');
    }).join('\n');
  }
  const text = [
    r.title ? 'Title: ' + r.title : '',
    r.summary ? 'Summary: ' + r.summary : '',
    r.intended_effects ? 'Intended Effects: ' + r.intended_effects : '',
    r.mechanisms ? 'Mechanisms: ' + r.mechanisms : '',
    r.policy_area ? 'Policy Area: ' + r.policy_area : '',
    r.primary_issue ? 'Primary Issue: ' + r.primary_issue : '',
    r.sub_issue ? 'Sub-Issue: ' + r.sub_issue : '',
    taxonomyKeywords ? 'Taxonomy Keywords: ' + taxonomyKeywords : '',
    billKeywords ? 'Bill Keywords: ' + billKeywords : '',
    r.subjects ? 'Legislative Subjects: ' + r.subjects : '',
    stakeholdersText ? 'Affected Stakeholders:\n' + stakeholdersText : '',
  ].filter(Boolean).join('\n\n');
  out.push({ impact_id: r.impact_id, bill_id: r.bill_id, text, has_embedding: r.has_embedding, embedded_text_md5: r.embedded_text_md5 });
}
return [{ json: { texts: out, candidates: rows.length } }];
