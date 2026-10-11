import { config } from '../config.js';
import { traceStep } from '../trace/Trace.js';
import type { ClarifyOption } from '@receipts/shared';
import { statedStance } from '../evaluation/statedStance.js';
import {
  cleanupCacheKey,
  keepsTopic,
  liveFetcher,
  tidy,
  type CleanupFetcher,
  type RawCleanupOutput,
} from './cleanUpInput.js';
import { ASK_WHICH_SYSTEM_PROMPT, ASK_WHICH_SYSTEM_PROMPT_VERSION } from './askWhichPrompt.js';

// ===========================================================================
// "WHICH POLICY?" — before a broad statement is checked.
//
// "He promised not to raise my taxes" (trace 7e1e8f99) names a side but not a
// policy: income taxes, payroll taxes and the 2017 cuts are different bills,
// and the classifier filed the same words under different tax categories from
// run to run. So before the search, one small model call asks whether the
// statement names one policy; if it does not, the reader is offered a few
// readings to choose from and NOTHING is checked until they pick.
//
// Adding specificity the reader did not type is only allowed because they
// choose it, seeing the exact statement each choice checks (2026-10-11: "us
// enhancing their query could misrepresent their intent"). The code check
// holds what an option may never add:
//
//   - the other side. Every option must take the reader's side, read from the
//     statement's own opening word (evaluation/statedStance.ts); a statement
//     with no readable side is not offered options at all;
//   - a different topic: each option keeps one of the reader's own words;
//   - a camp's label for a policy (a short blocklist, on top of the prompt);
//   - a question, a member's name, a subject pronoun, a bad length.
//
// Fewer than two options survive: no question is asked, and the statement is
// checked as typed. Fails OPEN like the rest of input clean-up: no credential,
// a failed call or unparseable output is SPECIFIC.
// ===========================================================================

export type WhichDecision =
  | { action: 'SPECIFIC'; reason: string }
  | { action: 'ASK_WHICH'; topic: string; question: string; options: ClarifyOption[] };

/** Words one side uses for a policy. An option carrying one is dropped. */
const LOADED = /\b(death tax|amnesty|gun grab|pro-?life|pro-?choice|job-?killing|radical|woke|socialis[mt]|open borders|baby killing|tax hike on the rich)\b/i;

const OPENS_WITH_SIDE = /^(supports|opposes|promised to|promised not to)\s+\S/i;

/** Decide what to do with the model's output. Anything doubtful is SPECIFIC. */
export function checkWhich(statement: string, raw: RawCleanupOutput | null): WhichDecision {
  if (!raw || typeof raw !== 'object') return { action: 'SPECIFIC', reason: 'model output did not parse' };
  const action = typeof raw.action === 'string' ? raw.action.trim().toUpperCase() : '';
  if (action === 'SPECIFIC') return { action: 'SPECIFIC', reason: 'model: names one policy' };
  if (action !== 'ASK_WHICH') return { action: 'SPECIFIC', reason: `unknown action "${action || '(none)'}"` };

  const side = statedStance(statement);
  if (!side) return { action: 'SPECIFIC', reason: 'the statement has no readable side to keep' };

  const topic = tidy((raw as { topic?: unknown }).topic).toLowerCase();
  if (!topic || topic.length > 40 || topic.split(/\s+/).length > 4 || topic.includes('?')) {
    return { action: 'SPECIFIC', reason: 'topic unusable' };
  }
  if (!keepsTopic(statement, topic)) return { action: 'SPECIFIC', reason: 'topic is not in the reader\'s words' };
  // The question the reader sees: the model's, when it is a plain "Which …?"
  // on their topic; otherwise a fixed one that cannot read wrongly.
  const asked = tidy((raw as { question?: unknown }).question);
  const question =
    /^which\b[^?]{3,60}\?$/i.test(asked) && keepsTopic(statement, asked) && !LOADED.test(asked)
      ? asked
      : 'Which one do you mean?';

  const rawOptions = Array.isArray((raw as { options?: unknown }).options) ? ((raw as { options: unknown[] }).options) : [];
  const seen = new Set<string>();
  const options: ClarifyOption[] = [];
  const dropped: string[] = [];
  for (const o of rawOptions.slice(0, 4)) {
    const label = tidy((o as { label?: unknown })?.label);
    const s = tidy((o as { statement?: unknown })?.statement);
    const why =
      !label || label.length > 60 ? 'label unusable'
      : !s || s.length < 6 || s.length > 160 || s.includes('?') ? 'statement unusable'
      : !OPENS_WITH_SIDE.test(s) ? 'does not open with a side'
      : /^(he|she|they)\b/i.test(s) ? 'names a subject'
      : statedStance(s) !== side ? 'takes a side the reader did not'
      : !keepsTopic(statement, s) ? 'not on the reader\'s topic'
      : LOADED.test(`${label} ${s}`) ? 'uses a camp\'s label'
      : seen.has(s.toLowerCase()) ? 'duplicate'
      : s.toLowerCase() === tidy(statement).toLowerCase() ? 'same as typed'
      : null;
    if (why) {
      dropped.push(`"${s || label}": ${why}`);
      continue;
    }
    seen.add(s.toLowerCase());
    options.push({ label, statement: s });
  }
  if (options.length < 2) {
    return { action: 'SPECIFIC', reason: `fewer than two usable readings (${dropped.join('; ') || 'none offered'})` };
  }
  return { action: 'ASK_WHICH', topic, question, options };
}

export function liveWhichFetcher(): CleanupFetcher {
  return liveFetcher(ASK_WHICH_SYSTEM_PROMPT, ASK_WHICH_SYSTEM_PROMPT_VERSION, 'WHICH_MODEL', '"Which policy?"');
}

const cacheOf = new Map<string, WhichDecision>();
const CACHE_MAX = 500;

/**
 * Should the reader be asked which policy they mean? Never throws, and never
 * asks in demo mode without a fetcher (there is no model to suggest readings).
 */
export async function askWhichPolicy(statement: string, options: { fetcher?: CleanupFetcher } = {}): Promise<WhichDecision> {
  const text = String(statement ?? '').trim();
  if (!text) return { action: 'SPECIFIC', reason: 'empty' };
  if (config.demoMode && !options.fetcher) return { action: 'SPECIFIC', reason: 'demo mode' };

  // The same statement gets the same readings for the life of the process, so
  // a second tab or a re-run is not offered a different set.
  const key = cleanupCacheKey(`which:${text}`);
  const hit = options.fetcher ? undefined : cacheOf.get(key);
  if (hit) {
    traceStep({ stage: 'WHICH', kind: 'deterministic', label: `cache hit — ${hit.action}`, input: { statement: text }, output: hit });
    return hit;
  }

  let raw: RawCleanupOutput | null;
  try {
    raw = await (options.fetcher ?? liveWhichFetcher())(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    traceStep({
      stage: 'WHICH', kind: 'deterministic', status: 'error',
      label: '"which policy?" unavailable — FAILED OPEN, checked as typed', input: { statement: text }, error: message,
    });
    return { action: 'SPECIFIC', reason: `unavailable: ${message}` };
  }

  const decision = checkWhich(text, raw);
  const refused = decision.action === 'SPECIFIC' && raw !== null && String(raw.action ?? '').toUpperCase() === 'ASK_WHICH';
  traceStep({
    stage: 'WHICH', kind: 'deterministic', status: refused ? 'rejected' : 'ok',
    label:
      decision.action === 'ASK_WHICH'
        ? `ASK_WHICH "${decision.topic}" → ${decision.options.map((o) => `"${o.statement}"`).join(' / ')}`
        : `SPECIFIC — ${decision.reason}`,
    input: { statement: text, model_json: raw },
    output: decision,
  });
  if (!options.fetcher) {
    if (cacheOf.size >= CACHE_MAX) cacheOf.delete(cacheOf.keys().next().value!);
    cacheOf.set(key, decision);
  }
  return decision;
}
