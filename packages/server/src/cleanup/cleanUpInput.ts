import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { anthropicContent, anthropicUsage, traceBegin, traceStep } from '../trace/Trace.js';
import { CLEANUP_SYSTEM_PROMPT, CLEANUP_SYSTEM_PROMPT_VERSION } from './cleanupPrompt.js';

// ===========================================================================
// INPUT CLEAN-UP — what to do when a reader types a question.
//
// Three layers, cheapest first:
//
//   1. `needsCleanUp` — FREE, deterministic. Only text shaped like a question
//      or a bare topic goes any further. A statement never does, so for a
//      statement this module is not in the path at all: same input to the
//      classifier, the search and the scorer as before, and no added cost.
//
//   2. One small model call (the classify model) that returns REWRITE,
//      ASK_SIDE or PASS.
//
//   3. `checkDecision` — deterministic again. The model's output is refused
//      unless its words come from the reader's text. A rewrite that brings in
//      a subject the reader never typed is the tool authoring the claim it
//      then grades, so it is dropped and the text passes through unchanged.
//
// FAILS OPEN, everywhere. No credential, a failed call, unparseable output, a
// refused rewrite: the reader's text goes on exactly as typed, which is what
// happened before this module existed. It can make a question checkable; it
// cannot make anything worse than it was.
// ===========================================================================

export type CleanupDecision =
  | { action: 'PASS'; reason: string }
  | { action: 'REWRITE'; statement: string }
  | { action: 'ASK_SIDE'; proposition: string };

/** What the model returned, before anything is believed. */
export interface RawCleanupOutput {
  action?: unknown;
  statement?: unknown;
  proposition?: unknown;
}

export type CleanupFetcher = (text: string) => Promise<RawCleanupOutput | null>;

/** Seven short fields at most. See SCOPE_MAX_TOKENS for why this is not config.anthropic.maxTokens. */
const CLEANUP_MAX_TOKENS = 400;

export const CLEANUP_MODEL_TAG = `${config.models.classify} / ${CLEANUP_SYSTEM_PROMPT_VERSION}`;

// ---------------------------------------------------------------------------
// 1. The free check
// ---------------------------------------------------------------------------

/** A word that opens a question in English. */
const QUESTION_OPENERS = new Set([
  'did', 'does', 'do', 'is', 'are', 'was', 'were', 'has', 'have', 'had', 'will', 'would', 'can', 'could', 'should',
  'what', 'whats', "what's", 'where', 'wheres', "where's", 'how', 'hows', "how's", 'why', 'who', 'which', 'when',
]);

/**
 * Words that already give a short phrase a side. "ban abortion" and "secure
 * border" are statements; "abortion" and "gun control" are topics.
 */
const SIDE_WORDS = new Set([
  'support', 'supports', 'supported', 'oppose', 'opposes', 'opposed', 'against', 'for', 'pro', 'anti',
  'ban', 'bans', 'end', 'ends', 'stop', 'stops', 'protect', 'protects', 'defend', 'secure', 'cut', 'cuts',
  'raise', 'raises', 'lower', 'lowers', 'expand', 'expands', 'repeal', 'repeals', 'pass', 'passes', 'fund',
  'funds', 'defund', 'cancel', 'cancels', 'legalize', 'legalise', 'restrict', 'restricts', 'extend', 'keep',
  'promised', 'promise', 'voted', 'vote', 'more', 'less', 'no', 'not',
]);

const words = (text: string): string[] =>
  text.toLowerCase().replace(/[^a-z0-9'’\s-]/g, ' ').split(/\s+/).filter(Boolean);

/**
 * Is this text shaped like something the checker cannot test as typed?
 *
 * True for a question (a question mark anywhere, or an opening question word)
 * and for a bare topic of one or two words with no side in it. Deliberately
 * narrow: everything else is left exactly alone.
 */
export function needsCleanUp(text: string): boolean {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (t.includes('?')) return true;
  const w = words(t);
  if (!w.length) return false;
  if (QUESTION_OPENERS.has(w[0]!)) return true;
  return w.length <= 2 && !w.some((x) => SIDE_WORDS.has(x));
}

// ---------------------------------------------------------------------------
// 3. The deterministic check on what the model said
// ---------------------------------------------------------------------------

/**
 * Words that carry no subject: the verbs a rewrite adds to give the text
 * statement form, the padding a neutral proposition adds ("legal access to
 * …"), and ordinary glue. What is left after removing them is what the text
 * is ABOUT, and that is what must come from the reader.
 */
const NOT_CONTENT = new Set([
  // statement form
  'supports', 'support', 'supporting', 'supported', 'opposes', 'oppose', 'opposing', 'opposed', 'promised',
  'promises', 'promise', 'voted', 'votes', 'vote', 'against', 'said', 'says', 'pledged',
  // proposition padding
  'legal', 'access', 'laws', 'law', 'policy', 'policies', 'recognition', 'federal', 'stricter', 'imported',
  'goods', 'rules', 'measures',
  // question words and glue
  'the', 'and', 'for', 'his', 'her', 'him', 'she', 'they', 'their', 'them', 'has', 'had', 'have', 'was', 'were',
  'are', 'did', 'does', 'done', 'what', 'whats', 'where', 'how', 'why', 'who', 'which', 'when', 'stance',
  'position', 'stand', 'stands', 'view', 'views', 'about', 'into', 'from', 'with', 'that', 'this', 'not', 'any',
  'anything', 'going', 'would', 'will', 'can', 'could', 'should', 'been', 'being', 'there', 'you', 'your',
  'more', 'less', 'actually', 'really', 'ever', 'still', 'senator', 'congressman', 'congresswoman',
  'representative',
]);

const contentWords = (text: string): string[] =>
  words(text).map((w) => w.replace(/['’]s$/, '')).filter((w) => w.length >= 3 && !NOT_CONTENT.has(w));

/** Same word, allowing for an ending: repeal / repealing, secure / securing, gun / guns. */
const sameStem = (a: string, b: string): boolean => {
  const n = Math.min(5, a.length, b.length);
  return n >= 3 && a.slice(0, n) === b.slice(0, n);
};

/** The share of `candidate`'s content words that come from `original`. 0 when it has none. */
export function carriedFrom(original: string, candidate: string): number {
  const have = contentWords(original);
  const want = contentWords(candidate);
  if (!want.length) return 0;
  return want.filter((w) => have.some((h) => sameStem(h, w))).length / want.length;
}

const tidy = (v: unknown): string =>
  (typeof v === 'string' ? v : '').trim().replace(/\s+/g, ' ').replace(/^["“”']+|["“”']+$/g, '').replace(/[.;,]+$/, '');

/** A rewrite must keep at least this share of its content words from the reader's text. */
export const REWRITE_MIN_CARRIED = 0.6;

/**
 * Decide what to do with the model's output. Anything not clearly usable is a
 * PASS with the reason recorded, never a guess.
 */
export function checkDecision(original: string, raw: RawCleanupOutput | null): CleanupDecision {
  if (!raw || typeof raw !== 'object') return { action: 'PASS', reason: 'model output did not parse' };
  const action = typeof raw.action === 'string' ? raw.action.trim().toUpperCase() : '';

  if (action === 'REWRITE') {
    const statement = tidy(raw.statement);
    if (!statement) return { action: 'PASS', reason: 'REWRITE with no statement' };
    if (statement.includes('?')) return { action: 'PASS', reason: 'rewrite is still a question' };
    if (statement.length < 6 || statement.length > 240) return { action: 'PASS', reason: 'rewrite length out of range' };
    if (/^(he|she|they|it)\b/i.test(statement)) return { action: 'PASS', reason: 'rewrite names a subject, not a position' };
    if (statement.toLowerCase() === tidy(original).toLowerCase()) return { action: 'PASS', reason: 'rewrite equals the original' };
    const carried = carriedFrom(original, statement);
    if (carried < REWRITE_MIN_CARRIED) {
      return { action: 'PASS', reason: `rewrite adds content the text does not have (${Math.round(carried * 100)}% carried)` };
    }
    return { action: 'REWRITE', statement };
  }

  if (action === 'ASK_SIDE') {
    // The side is ours to add, in both directions. A proposition that arrives
    // with one already on it has picked.
    const proposition = tidy(raw.proposition).replace(/^(supports?|opposes?|supporting|opposing|for|against)\s+/i, '');
    if (!proposition) return { action: 'PASS', reason: 'ASK_SIDE with no proposition' };
    if (proposition.includes('?')) return { action: 'PASS', reason: 'proposition is a question' };
    if (proposition.length < 3 || proposition.length > 80) return { action: 'PASS', reason: 'proposition length out of range' };
    if (carriedFrom(original, proposition) === 0 && carriedFrom(proposition, original) === 0) {
      return { action: 'PASS', reason: 'proposition shares no subject with the text' };
    }
    return { action: 'ASK_SIDE', proposition };
  }

  if (action === 'PASS') return { action: 'PASS', reason: 'model: nothing to tidy' };
  return { action: 'PASS', reason: `unknown action "${action || '(none)'}"` };
}

// ---------------------------------------------------------------------------
// 2. The model call
// ---------------------------------------------------------------------------

function parseJson(text: string): RawCleanupOutput | null {
  const cleaned = String(text).replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(cleaned) as RawCleanupOutput;
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]) as RawCleanupOutput;
    } catch {
      return null;
    }
  }
}

export class CleanupUnavailableError extends Error {
  constructor() {
    super('Input clean-up requires ANTHROPIC_API_KEY, which is not set.');
    this.name = 'CleanupUnavailableError';
  }
}

export function liveCleanupFetcher(): CleanupFetcher {
  return async (text) => {
    if (!config.anthropic.apiKey) throw new CleanupUnavailableError();

    const client = new Anthropic({ apiKey: config.anthropic.apiKey });
    // Only the reader's text. The member is not sent: nothing here depends on
    // who is being checked, and leaving them out keeps it that way.
    const userMessage = `Text: ${text}`;
    const end = traceBegin();
    let message: Anthropic.Message;
    try {
      message = await client.messages.create({
        model: config.models.classify,
        max_tokens: CLEANUP_MAX_TOKENS,
        system: CLEANUP_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      });
    } catch (err) {
      end({
        stage: 'CLEANUP_MODEL', kind: 'model', status: 'error', label: 'input clean-up call failed',
        model: config.models.classify, prompt_version: CLEANUP_SYSTEM_PROMPT_VERSION,
        prompt_text: CLEANUP_SYSTEM_PROMPT,
        input: { user_message: userMessage },
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    const out = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    end({
      stage: 'CLEANUP_MODEL', kind: 'model', status: out ? 'ok' : 'error',
      label: out ? `stop_reason=${message.stop_reason ?? 'none'}` : 'no text returned',
      model: config.models.classify, prompt_version: CLEANUP_SYSTEM_PROMPT_VERSION,
      prompt_text: CLEANUP_SYSTEM_PROMPT,
      usage: anthropicUsage(message.usage),
      input: { user_message: userMessage },
      output: { stop_reason: message.stop_reason, raw_text: out, content: anthropicContent(message.content) },
    });

    if (!out) throw new Error(`Input clean-up returned no text (stop_reason=${message.stop_reason ?? 'none'}).`);
    return parseJson(out);
  };
}

/**
 * DEMO MODE stand-in: no model, three patterns. Exists so the rewrite and the
 * "which way?" screens are clickable with no keys, like every other stub — and
 * the demo banner already says the interpretation is canned.
 */
export function stubCleanupFetcher(): CleanupFetcher {
  return async (text) => {
    const t = text.trim();
    const stance = /\b(?:stance|position|view|views|stand)\s+on\s+(.+?)\??$/i.exec(t);
    if (stance) return { action: 'ASK_SIDE', proposition: stance[1]!.trim() };
    const tacked = /^(.*?[.!])\s*(?:did|does|has|is|was)\b[^.?!]*\?\s*$/i.exec(t);
    if (tacked) {
      const said = tacked[1]!.replace(/^(?:he|she|they)\s+(?:said|promised|pledged|vowed)\s+(?:that\s+)?(?:he|she|they)\s+(?:was|were|is|are)?\s*(?:going to|would|will)\s+/i, 'promised to ');
      return { action: 'REWRITE', statement: said };
    }
    const yesNo = /^(?:did|does|has|is|will|would)\s+(?:he|she|they)\s+(?:vote(?:d)?\s+(?:to|for)|support(?:ed|s)?|back(?:ed|s)?|done anything to)\s+(.+?)\??$/i.exec(t);
    if (yesNo) return { action: 'REWRITE', statement: `supports ${yesNo[1]!.trim()}` };
    if (!t.includes('?') && words(t).length <= 2) return { action: 'ASK_SIDE', proposition: t };
    return { action: 'PASS' };
  };
}

// ---------------------------------------------------------------------------
// Cache — the same text gets the same decision for the life of the process,
// so a correction re-run or a second tab cannot be handed a different rewrite
// of the same question.
// ---------------------------------------------------------------------------

export interface CleanupCache {
  get(key: string): CleanupDecision | undefined;
  set(key: string, value: CleanupDecision): void;
}

export class InMemoryCleanupCache implements CleanupCache {
  private readonly store = new Map<string, CleanupDecision>();
  constructor(private readonly max = 500) {}
  get(key: string): CleanupDecision | undefined {
    return this.store.get(key);
  }
  set(key: string, value: CleanupDecision): void {
    if (this.store.size >= this.max) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, value);
  }
}

const defaultCache = new InMemoryCleanupCache();

export const cleanupCacheKey = (text: string): string =>
  createHash('sha256').update(String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase()).digest('hex');

export interface CleanUpOptions {
  fetcher?: CleanupFetcher;
  cache?: CleanupCache;
}

/**
 * Tidy the reader's text, or leave it alone.
 *
 * Never throws: a failure is a PASS with the reason, and the caller carries on
 * with the text as typed.
 */
export async function cleanUpInput(text: string, options: CleanUpOptions = {}): Promise<CleanupDecision> {
  if (!needsCleanUp(text)) return { action: 'PASS', reason: 'not a question' };

  const cache = options.cache ?? defaultCache;
  const key = cleanupCacheKey(text);
  const hit = cache.get(key);
  if (hit) {
    traceStep({
      stage: 'CLEANUP', kind: 'deterministic', label: `cache hit — ${hit.action}`,
      input: { text, cache_key: key }, output: hit,
    });
    return hit;
  }

  let raw: RawCleanupOutput | null;
  try {
    const fetcher = options.fetcher ?? (config.demoMode ? stubCleanupFetcher() : liveCleanupFetcher());
    raw = await fetcher(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[cleanup] unavailable (non-fatal, text passes through as typed):', message);
    traceStep({
      stage: 'CLEANUP', kind: 'deterministic', status: 'error',
      label: 'input clean-up unavailable — FAILED OPEN, text passes through as typed',
      input: { text }, error: message,
    });
    // Not cached: a transient failure must not become a sticky one.
    return { action: 'PASS', reason: `unavailable: ${message}` };
  }

  const decision = checkDecision(text, raw);
  // A model answer the check refused is recorded as refused, with what it was.
  const refused = decision.action === 'PASS' && raw !== null && String(raw.action ?? '').toUpperCase() !== 'PASS';
  traceStep({
    stage: 'CLEANUP', kind: 'deterministic', status: refused || raw === null ? 'rejected' : 'ok',
    label:
      decision.action === 'REWRITE'
        ? `REWRITE → "${decision.statement}"`
        : decision.action === 'ASK_SIDE'
          ? `ASK_SIDE → "${decision.proposition}"`
          : `PASS — ${decision.reason}`,
    input: { text, model_json: raw },
    output: decision,
  });
  cache.set(key, decision);
  return decision;
}
