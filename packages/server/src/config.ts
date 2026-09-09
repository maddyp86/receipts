import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Load the untracked `.env` from the MONOREPO ROOT, not from the cwd.
//
// `import 'dotenv/config'` resolves `.env` against `process.cwd()`, and the dev
// script runs this workspace with `npm run dev --workspace @receipts/server` —
// so the cwd is `packages/server/` and a root `.env` is silently ignored. The
// startup banner then reads `credentials: anthropic=ABSENT` beside a file the
// operator has just filled in correctly, and DEMO mode looks like a bug in the
// key rather than a lookup path.
//
// `.env.example` and DEPLOY.md both put the file at the repo root, so the root
// is the documented location and this makes the code agree with the docs.
//
// Missing file is not an error: production (Render/Railway) injects real
// environment variables and has no `.env` at all. dotenv no-ops when the path
// does not exist, and anything already in `process.env` still wins.
// ---------------------------------------------------------------------------
const MONOREPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
loadEnv({ path: resolve(MONOREPO_ROOT, '.env') });

// ===========================================================================
// Configuration.
//
// Modes are *inferred* from which credentials are present rather than demanded
// up front, so the app is always runnable and degrades one layer at a time:
//
//   no keys at all      -> DEMO_MODE + FIXTURE_MODE, fully clickable
//   + ANTHROPIC_API_KEY -> real interpretation and explanation, fixture matches
//   + OpenAI + Pinecone -> live retrieval against the senator's real record
//
// Every threshold below defaults to the value read from the live pipeline. They
// live here rather than inline so a calibration pass touches one file.
// ===========================================================================

const str = (v: string | undefined): string => (v ?? '').trim();

/** Parse an explicit boolean override; `undefined` means "infer". */
const boolOverride = (v: string | undefined): boolean | undefined => {
  const t = str(v).toLowerCase();
  if (t === 'true' || t === '1' || t === 'yes') return true;
  if (t === 'false' || t === '0' || t === 'no') return false;
  return undefined;
};

const num = (v: string | undefined, fallback: number): number => {
  const n = Number.parseFloat(str(v));
  return Number.isFinite(n) ? n : fallback;
};

const anthropicKey = str(process.env.ANTHROPIC_API_KEY);
const openaiKey = str(process.env.OPENAI_API_KEY);
const pineconeKey = str(process.env.PINECONE_API_KEY);
const pineconeHost = str(process.env.PINECONE_HOST).replace(/\/+$/, '');
const databaseUrl = str(process.env.DATABASE_URL);

const demoOverride = boolOverride(process.env.DEMO_MODE);
const fixtureOverride = boolOverride(process.env.FIXTURE_MODE);

/** No Anthropic key -> deterministic stubs for interpret/explain. */
const demoMode = demoOverride ?? anthropicKey === '';

/** No OpenAI key, no Pinecone key, or no host -> canned matches. */
const fixtureMode =
  fixtureOverride ?? (openaiKey === '' || pineconeKey === '' || pineconeHost === '');

export const config = {
  // API_PORT first, then the conventional PORT, then a default.
  //
  // The indirection is load-bearing in dev: `npm run dev` runs the API and Vite
  // side by side under one environment, and plenty of harnesses (and hosts)
  // inject PORT for whatever they think the single service is. Without a
  // dedicated variable the API silently tries to bind Vite's port and every
  // /api call dies with ECONNREFUSED. PORT alone still works in production,
  // where there is only one service to name.
  port: num(process.env.API_PORT ?? process.env.PORT, 8787),

  demoMode,
  fixtureMode,

  // ---- MODELS — deliberately NOT single-vendor -------------------------
  //
  // Three jobs, three models, chosen for corpus parity rather than tidiness.
  // Consolidating these to one vendor is listed in the handoff as a tempting
  // mistake: fulfillment on OpenAI is deliberate agreement with the model that
  // scored the entire corpus, not an oversight.
  models: {
    /**
     * `interpret_promise` — classification.
     *
     * PROVISIONAL. Parity is owed against the **GPT-4.1** corpus labels, not
     * against Haiku: the stored issue pairs were produced by GPT-4.1, so that
     * is the only thing a divergence can be measured from. Until the 12-row
     * check runs (credential-blocked), treat this default as unverified — a
     * silent classification drift moves the query vector and therefore the
     * candidate set, which reads as "no relevant bills" rather than as an
     * error. Overridable via CLASSIFY_MODEL precisely so the parity check can
     * swap it without a code change.
     */
    classify: str(process.env.CLASSIFY_MODEL) || 'claude-haiku-4-5',

    /**
     * `bill_effect` — fulfillment. OpenAI, on purpose.
     *
     * Matches live WF10A and keeps the ~30k relevance prompt paired with the
     * model it was written and calibrated against. This is the axis where a
     * disagreement with the corpus is most damaging, because it decides
     * ADVANCE/HINDER and therefore the verdict itself. Opus 5 is a possible
     * upgrade but only as a calibration decision — run both over ~20 bills and
     * measure ADVANCE/HINDER/NEUTRAL agreement first. Never a default swap.
     */
    fulfill: str(process.env.FULFILL_MODEL) || 'gpt-5.4-mini',

    /**
     * `explain_result` — prose. No corpus parity tie, so this is a free choice.
     *
     * The explanation is written against a frozen result it cannot alter, so a
     * model change here cannot move a verdict — only how it reads.
     */
    explain: str(process.env.EXPLAIN_MODEL) || 'claude-sonnet-5',

    /**
     * The adversarial verdict judge. MUST NOT be the same family as `fulfill`.
     *
     * A second opinion from the model that produced the first one is not a
     * second opinion — it inherits the same reading of the same evidence. The
     * evaluator is GPT; the judge is Claude, deliberately (handoff v2 §5,
     * invariant 4). Overridable, but swapping it to an OpenAI model defeats the
     * layer rather than tuning it.
     *
     * NOTE: this model REJECTS `temperature`. See judge/judge.ts.
     */
    judge: str(process.env.JUDGE_MODEL) || 'claude-sonnet-5',
  },

  /**
   * Judge policy for the query path (handoff v2 §5, "Does the query tool need
   * the judge?").
   *
   * Deterministic gates run inline on every query — they are free. The LLM
   * judge runs ONLY on a derived BROKE/INCONSISTENT: the minority of queries,
   * and exactly where the risk is.
   */
  judge: {
    /**
     * One pass, no re-evaluation. A FAIL goes straight to the judge's
     * correction or to NOT_DETERMINABLE.
     *
     * The retry INVARIANT is still implemented and tested (see
     * judge/dispositions.ts) so contract 4 is live code rather than a comment
     * about a path that does not exist, and enabling retry is a flag flip.
     */
    retryEnabled: process.env.JUDGE_RETRY === 'true',
  },

  anthropic: {
    apiKey: anthropicKey,

    /**
     * Ceiling for a single streamed turn of the EXPLAIN LOOP, NOT a spend target
     * and NOT a global default — billing is on
     * tokens generated, so headroom is free and truncation is not.
     *
     * Raised from 8000. Three facts make the old value too tight:
     *   1. The loop always streams, so HTTP timeouts are not the constraint
     *      that argues for a small ceiling.
     *   2. Adaptive thinking is the only on-mode on Sonnet 5 and its tokens
     *      count against max_tokens — so the visible explanation is competing
     *      for budget with reasoning it does not control.
     *   3. A turn carries tool-call blocks as well as prose.
     * Sonnet 5's hard cap is 128K; this sits well inside it.
     *
     * Sizing alone is not the guard — see the `max_tokens` stop check in
     * orchestrator/loop.ts. A truncated turn must be surfaced, never rendered.
     *
     * ⚠ Do NOT reuse this for a non-streaming call. The SDK rejects
     * `messages.create` when max_tokens implies a >10 minute operation, so a
     * non-streamed call needs its own, much smaller ceiling — see
     * CLASSIFY_MAX_TOKENS in evaluation/classify.ts.
     */
    maxTokens: num(process.env.ANTHROPIC_MAX_TOKENS, 64000),
  },

  embeddings: {
    apiKey: openaiKey,
    // NON-NEGOTIABLE: must match the batch pipeline. Changing either value puts
    // the query vector in a different space from the stored bill vectors.
    model: str(process.env.EMBEDDING_MODEL) || 'text-embedding-3-small',
    dimensions: num(process.env.EMBEDDING_DIMENSIONS, 1024),
  },

  pinecone: {
    apiKey: pineconeKey,
    host: pineconeHost,
    namespaceTemplate:
      str(process.env.PINECONE_NAMESPACE_TEMPLATE) || '{politician_id}_bills',
    // Batch runs scope bill vectors by embedding_version == run_id. A live
    // query has no run to scope to; blank searches every version.
    embeddingVersion: str(process.env.PINECONE_EMBEDDING_VERSION),
  },

  retrieval: {
    topK: num(process.env.RETRIEVAL_TOP_K, 10),
  },

  /**
   * Congresses whose legislation has been collected and embedded.
   *
   * DISCLOSURE, not a filter. Retrieval already searches only what exists in
   * the namespace; this exists so the tool can SAY what it searched.
   *
   * Without it, "we found no bills or votes on this" reads as "the senator has
   * no record on this" — and for anything before the collected window that is
   * false. Schumer passed the Inflation Reduction Act in the 117th; the corpus
   * starts at the 118th, so the tool would report his defining drug-pricing
   * legislation as an absence of action.
   *
   * That failure is the mirror of the one the whole false-positive effort
   * guards against, and it is currently the less protected of the two: a false
   * accusation gets a confidence floor, a counterargument requirement and a
   * judge, while a false absence gets a clean sentence and no scrutiny.
   */
  coverage: {
    congresses: str(process.env.COVERAGE_CONGRESSES)
      .split(',')
      .map((c) => Number.parseInt(c.trim(), 10))
      .filter((c) => Number.isFinite(c))
      .sort((a, b) => a - b),
  },

  database: {
    /**
     * Postgres connection string for query/session persistence.
     *
     * MUST connect as the `receipts_app` role — never `postgres`, never a
     * service_role key. The corpus firewall is built out of roles:
     * `receipts_trust` being locked out of the `app` schema only means
     * something if the app connects as the role that is actually walled.
     * Connecting with blanket privileges leaves everything working and the
     * firewall decorative.
     *
     * Prefer the transaction-mode POOLER (port 6543) over a direct 5432
     * connection: a persistent server should not hold a real backend open.
     *
     * Absent -> NullQueryStore. The app boots and answers queries, but nothing
     * is persisted and share links resolve to nothing. Same degrade-honestly
     * pattern as the other credentials.
     */
    url: databaseUrl,
  },

  /**
   * Origins allowed to call this API, comma-separated.
   *
   * BLANK MEANS ALLOW ANY, which is right for local dev and wrong for a public
   * deployment: this API spends money per request on three vendors, so an open
   * CORS policy is an open invoice as much as a data question. The startup
   * banner warns when it is unset and the server is not in demo mode.
   */
  corsOrigins: str(process.env.CORS_ORIGIN)
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  features: {
    /**
     * Lets the user assert "he promised this", upgrading the verdict vocabulary
     * from CONSISTENT/INCONSISTENT to KEPT/BROKE.
     *
     * OFF by default, pending copy review. Printing "BROKE" next to a sitting
     * senator is the single output with real downside, so the path that
     * unlocks it ships dark until the wording that attributes the premise to
     * the user has been reviewed. The attribution is not decoration: without
     * it the claim silently becomes ours.
     */
    campaignPromiseOverride:
      boolOverride(process.env.ENABLE_CAMPAIGN_PROMISE_OVERRIDE) ?? false,
  },
} as const;

export function namespaceFor(politicianId: string): string {
  return config.pinecone.namespaceTemplate.replace('{politician_id}', politicianId);
}

/** One-line startup banner so the active mode is never a surprise. */
export function describeMode(): string {
  const llm = config.demoMode
    ? 'DEMO (stubbed interpret/explain)'
    : `live (${config.models.explain})`;
  const data = config.fixtureMode ? 'FIXTURE (canned matches)' : 'live (Pinecone)';
  return `llm=${llm}  data=${data}`;
}

/**
 * The configured model per job, and — separately — which of them the request
 * path actually reaches today.
 *
 * These are not the same thing yet, and saying so out loud is the point. The
 * orchestrator runs ONE conversation with ONE model across every tool call, so
 * setting `classify` does not currently route `interpret_promise` anywhere new.
 * Per-tool routing is item 3. Printing a configured-but-unwired model without
 * that caveat would let someone run the parity check against a model that never
 * saw the request.
 */
export function describeModels(): string {
  if (config.demoMode) return 'models: DEMO — no model is called.';
  return [
    `models: classify=${config.models.classify}  fulfill=${config.models.fulfill}  explain=${config.models.explain}`,
    '  all three are routed: classify and fulfill via dedicated calls, explain via the loop.',
  ].join('\n');
}

/**
 * Credential presence, NEVER credential values.
 *
 * Deploy-facing: the commonest production failure is "the service is up but a
 * secret never reached it", which otherwise shows up as fixture data being
 * served as if it were real. Printing present/absent makes that visible in the
 * first line of the logs.
 *
 * The values themselves are never rendered — not truncated, not fingerprinted,
 * not last-four. A partial key in a log aggregator is still a key in a log
 * aggregator, and prefixes are the identifying part.
 */
export function describeCredentials(): string {
  const mark = (v: string) => (v ? 'present' : 'ABSENT');
  return [
    `credentials: anthropic=${mark(anthropicKey)}  openai=${mark(openaiKey)}  ` +
      `pinecone=${mark(pineconeKey)}  pinecone_host=${mark(pineconeHost)}  ` +
      `supabase=${mark(databaseUrl)}`,
    config.pinecone.embeddingVersion
      ? `  embedding_version PINNED to "${config.pinecone.embeddingVersion}" — a stale pin ` +
        'returns zero vectors; the store asserts on this.'
      : '  embedding_version unset (searches every version)',
  ].join('\n');
}
