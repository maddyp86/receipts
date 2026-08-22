// ===========================================================================
// PORT of WF7a `Promise Embedding Text`.
// Workflow: Promise to Bill Evaluation (W7A) — UOpu690tosAwbvMB
//
// Embedding parity is not just "same model, same dimensions". The stored bill
// vectors are searched by a query vector built from a STRUCTURED TEMPLATE, and
// a bare user sentence lands somewhere else in the space. Match quality then
// degrades silently — no error, just worse results — which is the worst kind of
// bug to ship in a tool whose entire claim is traceability.
//
// ── There are two promise templates live. This is the right one. ────────────
// `Promise Embeddings` (ibhoY5j8ooe26a7r) builds the vectors stored in the
// {politician_id}_statements namespace using a v6 template that begins
// "Statement:", carries a "Statement Type:" line, and labels taxonomy terms
// "Taxonomy Keywords:".
//
// WF7a builds the QUERY text that searches {politician_id}_bills, and differs
// on all three points. Receipts searches bills, so it ports WF7a's. Do not
// "unify" these two templates — they are not the same string by design.
// ===========================================================================

export interface PromiseEmbeddingFields {
  /** The promise text itself. */
  statement: string;
  /** Classifier vocabulary: "In Favor" | "Opposed" | "Neutral/Unclear". */
  stance: string;
  /** Classifier vocabulary: policy | process | rhetorical | non_legislative. */
  promise_type: string;
  primary_issue: string;
  sub_issue: string;
  /** From the classifier. Omitted from the text when empty. */
  key_policy_terms?: string[] | string;
  /** Looked up from the approved taxonomy — never generated. Omitted when empty. */
  taxonomy_keywords?: string[] | string;
  /** The classifier's one-line rationale. Omitted when empty. */
  reasoning?: string;
}

/**
 * Separator for `Key Policy Terms`.
 *
 * CONFIRMED, not assumed: `key_policy_terms` is per-statement classifier
 * output, and WF3's parser writes `keyTerms.join(', ')` — or the literal 'NA'
 * when the array is empty. So this is the sheet's own value, reproduced.
 *
 * It does NOT apply to `Taxonomy Keywords` / `Related Terms`. That field is a
 * lookup from the Approved Taxonomy sheet (gid 1287072268) keyed on
 * (Primary Issue, Sub Issue), and upstream reads the CELL as an opaque string
 * and drops it in unchanged. Pass it through verbatim; joining it here would
 * substitute our separator for the sheet's.
 */
export const TERM_SEPARATOR = ', ';

/**
 * The literal WF3 writes when a statement yielded no key terms or no reasoning.
 * A real value in the corpus, not a placeholder for absence.
 */
export const NA_VALUE = 'NA';

function terms(value: string[] | string | undefined): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.filter(Boolean).join(TERM_SEPARATOR).trim();
  return String(value).trim();
}

/**
 * Build the exact text WF7a embeds, verbatim: `\n\n`-joined.
 *
 * Every line except `Related Terms` is unconditional. The template literal is
 * truthy regardless of its value, so `filter(Boolean)` never removes one —
 * `Stance: ` with a blank value is still a line. That is upstream behaviour,
 * not an oversight; reproducing it matters more than tidying it.
 */
export function buildPromiseEmbeddingText(fields: PromiseEmbeddingFields): string {
  // WF3's parser writes `keyTerms.join(', ')` or the literal string 'NA', so
  // every corpus vector carries a Key Policy Terms line and a Reasoning line.
  // The upstream conditional therefore never fires on corpus data, which means
  // reproducing the DOCUMENT requires supplying 'NA' rather than dropping the
  // line. Omit them and a sparse query is two lines shorter than every vector
  // it is compared against — a silent similarity shift, not a visible error.
  const keyPolicyTerms = terms(fields.key_policy_terms) || NA_VALUE;
  const reasoning = (fields.reasoning ?? '').trim() || NA_VALUE;

  // `Related Terms` is the ONLY legitimately-omitted line. It comes from the
  // Approved Taxonomy merge on (Primary Issue, Sub Issue); a taxonomy miss
  // leaves it blank upstream too, so the line drops there as well.
  const taxonomyKeywords = terms(fields.taxonomy_keywords);

  return [
    `Promise: ${fields.statement ?? ''}`,
    `Stance: ${fields.stance ?? ''}`,
    `Promise Type: ${fields.promise_type ?? ''}`,
    `Primary Issue: ${fields.primary_issue ?? ''}`,
    // Reads `Sub Issue`, emits `Sub-Issue:` — the hyphen is on output only.
    `Sub-Issue: ${fields.sub_issue ?? ''}`,
    `Key Policy Terms: ${keyPolicyTerms}`,
    taxonomyKeywords ? `Related Terms: ${taxonomyKeywords}` : '',
    `Reasoning: ${reasoning}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
