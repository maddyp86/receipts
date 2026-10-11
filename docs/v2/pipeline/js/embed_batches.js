// ===================================================================
// v2 PIPELINE: EMBEDDINGS, step 3. Requests to the embeddings API, up to 100
// texts each. Same model and size as WF6: text-embedding-3-small, 1024.
//
// A vector with no record of the text it came from (the ones copied from
// Pinecone in Phase 1) is embedded again once, from core's own text. That costs
// about two cents for all of them, and it replaces the few Pinecone vectors made
// from merged, superseded stakeholders with ones made from the current statement.
//
// On a dry run, or when nothing needs embedding, one placeholder item goes on
// so the chain continues; it is not sent.
// ===================================================================
const rows = $('Hash Texts').all().map((i) => i.json).filter((r) => r.impact_id);
const texts = new Map($('Build Texts').first().json.texts.map((t) => [t.impact_id, t.text]));
const toEmbed = rows.filter((r) => r.action === 'embed');
const out = [];
if (!dryRun) {
  for (let i = 0; i < toEmbed.length; i += 100) {
    const slice = toEmbed.slice(i, i + 100);
    out.push({ json: { ids: slice.map((r) => r.impact_id), md5s: slice.map((r) => r.md5), body: { model: 'text-embedding-3-small', dimensions: 1024, input: slice.map((r) => texts.get(r.impact_id)) } } });
  }
}
if (!out.length) out.push({ json: { skip: true } });
return out;
