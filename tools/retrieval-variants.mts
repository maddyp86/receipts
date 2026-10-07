// ===========================================================================
// retrieval-variants — would a deterministic embedded text keep retrieval
// stable, and what would it cost in recall? Retrieval only: embedding + vector
// search, no judges, so it costs a fraction of a cent.
//
//   npx tsx tools/retrieval-variants.mts <stability-label>
//
// For every run recorded under <stability-label> (tools/stability.mts), rebuilds
// the embedded text from that run's own classifier answer three ways and runs
// retrieval on each:
//
//   current   as the pipeline builds it today (checked against the stored text)
//   D1        Key Policy Terms and Reasoning both 'NA'
//   D2        Key Policy Terms from the taxonomy lookup; Reasoning 'NA'
//
// The two lines are the only model-written prose in the template
// (promiseEmbeddingText.ts); everything else is the user's text, closed-list
// labels, or the taxonomy lookup. Nothing here changes the pipeline.
// ===========================================================================

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildPromiseEmbeddingText } from '../packages/server/src/embeddings/promiseEmbeddingText.ts';
import { lookupTaxonomyKeywords } from '../packages/server/src/embeddings/taxonomy.ts';
import { actionStore, embedder } from '../packages/server/src/services.ts';
import { config } from '../packages/server/src/config.ts';
import { QUERIES } from './query-lib.mts';

const label = process.argv[2];
if (!label) { console.error('usage: npx tsx tools/retrieval-variants.mts <stability-label>'); process.exit(2); }
const dir = fileURLToPath(new URL('../.data/query-runs/', import.meta.url));
const runs = JSON.parse(await readFile(`${dir}${label}.json`, 'utf8')) as Array<{
  id: string; rep: number; embedded_text: string | null; top10: string[]; classifier_input: Record<string, any> | null;
}>;

type Variant = 'current' | 'D1' | 'D2';
const VARIANTS: Variant[] = ['current', 'D1', 'D2'];

function textFor(v: Variant, promise: string, c: Record<string, any>): string {
  const primary = String(c.primary_issue ?? '').trim();
  const sub = String(c.sub_issue ?? '').trim();
  const { keywords } = lookupTaxonomyKeywords(primary, sub);
  const kpt = Array.isArray(c.key_policy_terms) ? c.key_policy_terms.map(String) : c.key_policy_terms;
  return buildPromiseEmbeddingText({
    statement: promise,
    stance: String(c.stance ?? 'Neutral/Unclear'),
    promise_type: String(c.promise_type ?? 'policy'),
    primary_issue: primary,
    sub_issue: sub,
    key_policy_terms: v === 'current' ? kpt : v === 'D1' ? 'NA' : keywords,
    taxonomy_keywords: keywords,
    reasoning: v === 'current' ? String(c.reasoning ?? '') : 'NA',
  });
}

const results: Array<{ id: string; rep: number; variant: Variant; text: string; top10: string[]; text_matches_stored?: boolean }> = [];
for (const r of runs) {
  const q = QUERIES.find((x) => x.id === r.id)!;
  if (!r.classifier_input) { console.warn(`skip ${r.id} #${r.rep}: no classifier answer recorded`); continue; }
  for (const v of VARIANTS) {
    const text = textFor(v, q.promise, r.classifier_input);
    const vec = await embedder.embed(text);
    if (!vec.ok) throw new Error(`embed failed: ${vec.error.message}`);
    const res = await actionStore.search({ politicianId: q.senator, vector: vec.data, queryText: text, topK: config.retrieval.topK });
    if (!res.ok) throw new Error(`search failed: ${res.error.message}`);
    const top10 = res.data.matches.map((m) => String(m.bill_id));
    results.push({ id: r.id, rep: r.rep, variant: v, text, top10, ...(v === 'current' ? { text_matches_stored: text === r.embedded_text } : {}) });
  }
  process.stdout.write('.');
}
console.log();
await writeFile(`${dir}${label}-variants.json`, JSON.stringify(results, null, 2) + '\n');
console.log(`wrote .data/query-runs/${label}-variants.json (${results.length} retrievals)`);
process.exit(0);
