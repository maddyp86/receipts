// ===================================================================
// v2 PIPELINE: EMBEDDINGS, step 4. Store each new vector with the hash of the
// text it was made from; record the hash of adopted vectors.
// ===================================================================
const rows = $('Hash Texts').all().map((i) => i.json).filter((r) => r.impact_id);
const reqs = $('Embedding Requests').all().map((i) => i.json);
const resps = $input.all().map((i) => i.json);
const vectors = [];
const failed = [];
let tokens = 0;
for (let k = 0; k < reqs.length; k++) {
  const q = reqs[k];
  if (q.skip) continue;
  const r = resps[k] || {};
  if (!Array.isArray(r.data) || r.data.length !== q.ids.length) { failed.push(...q.ids); continue; }
  tokens += (r.usage && r.usage.total_tokens) || 0;
  for (const d of r.data) {
    const v = d.embedding;
    if (!Array.isArray(v) || v.length !== 1024) { failed.push(q.ids[d.index]); continue; }
    vectors.push({ impact_id: q.ids[d.index], md5: q.md5s[d.index], embedding: '[' + v.join(',') + ']' });
  }
}
// A statement whose content changed but whose embedding text did not keeps its
// vector; embedded_at moves so it is not picked up again tomorrow. embedded_at
// is "last time the vector was confirmed to match the text".
const same = rows.filter((r) => r.action === 'same').map((r) => ({ impact_id: r.impact_id }));

const statements = [];
for (let i = 0; i < vectors.length; i += 100) {
  statements.push({ table: 'bill_impacts', rows: Math.min(100, vectors.length - i), payload: JSON.stringify(vectors.slice(i, i + 100)),
    sql: "UPDATE core.bill_impacts t SET embedding = x.embedding::extensions.vector, embedded_text_md5 = x.md5, embedded_at = now(), " +
      "embedding_model = 'text-embedding-3-small', embedding_source = 'bill', updated_at = now() " +
      'FROM jsonb_to_recordset($1::jsonb) AS x(impact_id text, md5 text, embedding text) WHERE t.impact_id = x.impact_id;' });
}
if (same.length) {
  statements.push({ table: 'bill_impacts', rows: same.length, payload: JSON.stringify(same),
    sql: 'UPDATE core.bill_impacts t SET embedded_at = now() FROM jsonb_to_recordset($1::jsonb) AS x(impact_id text) WHERE t.impact_id = x.impact_id;' });
}
const count = (a) => rows.filter((r) => r.action === a).length;
return emit(statements, [], {
  workflow: 'embeddings',
  candidates: rows.length,
  to_embed: count('embed'),
  first_hash: rows.filter((r) => r.action === 'embed' && !r.embedded_text_md5).length,
  unchanged: count('same'),
  embedded: vectors.length,
  embedded_ids: vectors.map((v) => v.impact_id).slice(0, 100),
  model_tokens: tokens,
  failed,
  errors: failed.length ? [failed.length + ' statement(s) could not be embedded; they are retried next run'] : [],
});
