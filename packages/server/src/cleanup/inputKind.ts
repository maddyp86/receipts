import type { InputKindDecision } from '@receipts/shared';
import { liveFetcher, type CleanupFetcher } from './cleanUpInput.js';

// ===========================================================================
// Is the voter asking what the senator DID, or checking something the senator
// SAID? Decided before any rewrite, on the voter's own text.
//
// The bug this exists for (run 3bf66a32): "Did they vote to extend the
// enhanced ACA tax credits?" was rewritten to "supports extending the enhanced
// ACA tax credits" and then graded as Collins's own Policy Position. Collins
// never said it; the voter asked a question. A question is never turned into
// a statement and never attributed to the senator.
//
// Rules first, because they are free and they settle almost everything. The
// model is asked only about what the rules cannot place, and when it is not
// sure either, the voter is asked. Every decision says what made it.
// ===========================================================================

/**
 * A yes/no question about the record: "Did they…", "Has she…", "Does he
 * support…". The opener must have a subject after it, so "will fight to
 * secure the border" (a statement with its subject left off) is not one.
 */
const YES_NO_OPENER = /^(did|does|do|has|have|had|is|was|were|will|would|can|could)\s+(\S+)/i;
const SUBJECTS = /^(she|he|they|it|there|you|senator|sen\.?|the|this|that|my|our|their|her|his)$/i;
const isYesNoQuestion = (t: string): boolean => {
  const m = YES_NO_OPENER.exec(t);
  if (!m) return false;
  // A pronoun or "the senator", or a name: capitalised as typed.
  return SUBJECTS.test(m[2]!) || /^[A-Z]/.test(m[2]!);
};

/**
 * An open question asks what the position IS ("What is their stance on
 * abortion?"). It is left to the existing clean-up, which asks the voter
 * which side to check.
 */
const OPEN_QUESTION = /^(what|whats|what's|what’s|where|how|hows|how's|why|who|which|when)\b/i;

/** Words that attribute the text to the senator: a promise, a claim, a quote. */
const ATTRIBUTION = /\b(promise|promised|promises|pledge|pledged|pledges|vow|vowed|vows|said|says|claimed|claims|stated|states|told|tweeted|wrote)\b/i;

/** A statement that already takes a side, in the form the checker reads. */
const STATEMENT_OPENER = /^(supports?|opposes?|backs?|wants?|will|i will|we will|i'll|we'll|i promise|plans? to|is committed to|committed to|fights? for|stands? (for|with|against)|believes?)\b/i;

/**
 * A goal stated as a verb phrase: "Lower prescription drug prices", "protect
 * clean air standards". The voter is naming a position to check, not asking.
 */
const GOAL_OPENER = /^(lower|lowers|raise|raises|cut|cuts|protect|protects|ban|bans|expand|expands|repeal|repeals|end|ends|stop|stops|secure|secures|fund|funds|defund|cancel|cancels|legalize|legalise|classify|reclassify|restrict|restricts|extend|extends|keep|keeps|increase|increases|reduce|reduces|abolish|eliminate|strengthen|weaken|tighten|limit|codify|overturn|restore|prohibit|forgive|privatize|privatise|pass|passes|defend|defends|fight|fights|make|build|create|require|requires|allow|allows|support|oppose|no new)\b/i;

/** "Congress should…", "tariffs must be ended": what ought to happen, a position. */
const NORMATIVE = /\b(should|must|ought to|needs? to)\b/i;

/** "I support our veterans", "We will pass…": the speaker's own words. */
const FIRST_PERSON = /^(i|we|i'm|we're|i've|we've|i’m|we’re)\b/i;

/** "Permanently classify…": a goal verb after a manner word. */
const LEADING_ADVERB = /^(permanently|fully|immediately|finally|always|never)\s+/i;

const QUOTED = /^\s*["“'‘].{8,}["”'’]\s*$|^\s*["“].+["”]/;

const clean = (t: string) => String(t ?? '').trim().replace(/\s+/g, ' ');

/**
 * The free decision. Null when no rule applies and the model must be asked.
 * Exported for the tests, which pin each rule against real inputs.
 */
export function inputKindByRule(text: string): InputKindDecision | null {
  const t = clean(text);
  if (!t) return { kind: 'STATEMENT', decided_by: 'rule:empty', reason: 'nothing typed' };
  // A quotation is the senator's words, whatever its punctuation.
  if (QUOTED.test(t)) return { kind: 'STATEMENT', decided_by: 'rule:quoted', reason: 'a quotation' };
  // "Collins promised X", "He said he would…": the voter is reporting a
  // statement, so it is checked as one. "Did she promise…" is still a
  // question about a statement, and goes the same way.
  if (ATTRIBUTION.test(t) && !/^(did|has|have)\s+\S+\s+(vote|voted|sponsor|sponsored|cosponsor|co-sponsor)/i.test(t)) {
    return { kind: 'STATEMENT', decided_by: 'rule:attribution', reason: 'the text reports something the senator said or promised' };
  }
  if (OPEN_QUESTION.test(t)) {
    return { kind: 'STATEMENT', decided_by: 'rule:open_question', reason: 'an open question; the clean-up asks which side to check' };
  }
  if (isYesNoQuestion(t)) {
    return { kind: 'RECORD_QUESTION', decided_by: 'rule:question_opener', reason: 'opens with a question word' };
  }
  if (t.endsWith('?')) {
    return { kind: 'RECORD_QUESTION', decided_by: 'rule:question_mark', reason: 'ends with a question mark' };
  }
  if (NORMATIVE.test(t)) {
    return { kind: 'STATEMENT', decided_by: 'rule:normative', reason: 'says what should happen' };
  }
  if (FIRST_PERSON.test(t)) {
    return { kind: 'STATEMENT', decided_by: 'rule:first_person', reason: 'in the first person' };
  }
  if (STATEMENT_OPENER.test(t)) {
    return { kind: 'STATEMENT', decided_by: 'rule:statement_opener', reason: 'opens like a statement that takes a side' };
  }
  if (GOAL_OPENER.test(t.replace(LEADING_ADVERB, ''))) {
    return { kind: 'STATEMENT', decided_by: 'rule:goal_opener', reason: 'states a goal to check' };
  }
  return null;
}

export const INPUT_KIND_PROMPT_VERSION = 'input-kind-v1';

export const INPUT_KIND_PROMPT = `You classify one line a voter typed into a tool that checks a U.S. senator's legislative record.

Answer with JSON only: {"kind": "STATEMENT" | "RECORD_QUESTION" | "UNCLEAR", "confidence": 0.0 to 1.0}

- STATEMENT: the line states something the senator said, promised or holds as a position ("supports expanding background checks", "Collins wants lower drug prices", "lower taxes for working families").
- RECORD_QUESTION: the line asks what the senator did or supports, even without a question mark ("did she vote for the insulin cap", "her record on the debt limit", "votes on border security").
- UNCLEAR: you cannot tell which.

Classify the form of the line, not the topic. Never rewrite it.`;

/** The model's answer, parsed strictly; anything else is UNCLEAR. Exported for tests. */
export function parseInputKind(raw: unknown): { kind: InputKindDecision['kind']; confidence: number } {
  try {
    const json = (typeof raw === 'string'
      ? JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim())
      : raw ?? {}) as Record<string, unknown>;
    const kind = String(json.kind ?? '').toUpperCase();
    const confidence = Number(json.confidence);
    if ((kind === 'STATEMENT' || kind === 'RECORD_QUESTION' || kind === 'UNCLEAR') && Number.isFinite(confidence)) {
      return { kind: kind as InputKindDecision['kind'], confidence: Math.max(0, Math.min(1, confidence)) };
    }
  } catch {
    /* falls through */
  }
  return { kind: 'UNCLEAR', confidence: 0 };
}

/** Below this the model's answer is not used, and the voter is asked. */
export const INPUT_KIND_MIN_CONFIDENCE = 0.7;

let fetcher: CleanupFetcher | null = null;
const live = (): CleanupFetcher =>
  (fetcher ??= liveFetcher(INPUT_KIND_PROMPT, INPUT_KIND_PROMPT_VERSION, 'INPUT_KIND_MODEL', 'input kind'));

/**
 * The decision: rules, then the model, then UNCLEAR (ask the voter) when the
 * model is unsure. A model that cannot be reached (no key, demo mode, an
 * outage) falls back to the statement path, which is exactly how every input
 * was handled before this check existed: asking every reader to choose
 * whenever a call failed would block ordinary statements.
 */
export async function classifyInputKind(text: string, fetch: CleanupFetcher = live()): Promise<InputKindDecision> {
  const byRule = inputKindByRule(text);
  if (byRule) return byRule;
  try {
    const { kind, confidence } = parseInputKind(await fetch(clean(text)));
    if (kind !== 'UNCLEAR' && confidence >= INPUT_KIND_MIN_CONFIDENCE) {
      return { kind, decided_by: 'model', confidence, reason: `the model read it as ${kind.toLowerCase()}` };
    }
    return { kind: 'UNCLEAR', decided_by: 'model', confidence, reason: 'the model could not tell, or was not sure' };
  } catch (err) {
    return { kind: 'STATEMENT', decided_by: 'model_failed', reason: `the model was unavailable, so the statement path, as before: ${err instanceof Error ? err.message : String(err)}` };
  }
}
