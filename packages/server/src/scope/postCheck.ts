import type {
  RoleCondition,
  ScopeClassification,
  SpeechAct,
  StatementScope,
} from '@receipts/shared';
import { VALID_UNTIL_UNKNOWN } from '@receipts/shared';

// ===========================================================================
// SCOPE POST-CHECK — enforces the parts of the rule that don't need a model.
//
// SOURCE: docs/fix/01_statement_scope_classifier.v1_1.md, "Post-check Code
// node", 2026-09-04 (regexes) + handoff v2 §1 (2026-09-07).
// Ported verbatim 2026-09-07 — the regexes are transcribed character for
// character. They are deliberately conservative, and WHEN THEY FIRE THEY WIN:
// the model's answer is overwritten and the override is recorded as a flag.
//
// Why a deterministic layer at all, when the prompt already says this: the
// distribution the handoff quotes for a 50-statement sample reports "zero
// post-check overrides (model and regex agreed on every row)". That is the
// success condition, not evidence the layer is redundant. It is a ratchet — it
// costs nothing while the model agrees and catches the drift when it stops.
//
// The n8n original reads `$('Loop Over Statements').item.json` and returns
// sheet-cased keys ('Speech Act', 'Valid Until', …). This port takes an
// argument and returns the snake_case contract; the LOGIC is unchanged.
// ===========================================================================

const S = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const U = (v: unknown): string => S(v).toUpperCase();

// ---- Transcribed verbatim from the source. Do not "tidy" these. ----------
const BOUNDED_RE =
  /\b(this (bill|resolution|continuing resolution|CR|funding|legislation|year's)|these nominees|the (12|twelve) additional nominees|next week|this week|this work period|today|tomorrow|before (the )?(end of the (week|month)|[A-Z][a-z]+ \d{1,2})|by the end of the (week|month|year)|fiscal year 20\d\d|FY ?20\d\d|President (Biden|Trump|Obama)|(Biden|Trump|Obama)('s)? (administration|EPA|nominees|judicial nominees)|the upcoming (NDAA|omnibus|farm bill))\b/i;
const OPERATIONAL_RE =
  /\b(the Senate will (take up|vote|move|consider|pass)|I will file cloture|voting (is expected|will begin)|we are on track to vote|schedule votes|(first|next) (two )?weeks? of this work period)\b/i;
const LEADER_RE =
  /\b(I will file cloture|I intend to have the Senate|the Senate will take it up|we will confirm|I will schedule)\b/i;
const CREDIT_RE =
  /\b(I am proud to have (secured|delivered|helped)|I secured|I delivered|we delivered)\b/i;

const PRES_TERM_END: Record<string, string> = {
  BIDEN: '2025-01-20',
  TRUMP: '2029-01-20',
  OBAMA: '2017-01-20',
};

const SPEECH_ACTS = new Set<string>([
  'POSITION',
  'COMMITMENT',
  'OPERATIONAL',
  'CREDIT_CLAIM',
  'RHETORIC',
]);
const SCOPES = new Set<string>(['STANDING', 'BOUNDED']);
const ROLE_CONDITIONS = new Set<string>([
  'NONE',
  'MAJORITY_LEADER',
  'COMMITTEE_CHAIR',
  'MAJORITY_PARTY',
]);

/**
 * `addDays` from the source. Returns the UNKNOWN marker on an unparseable date
 * rather than a wrong date — the caller then asks the user for one.
 */
function addDays(iso: string, d: number): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return VALID_UNTIL_UNKNOWN;
  t.setUTCDate(t.getUTCDate() + d);
  return t.toISOString().slice(0, 10);
}

/** What the model returned, before the deterministic layer runs. */
export interface RawScopeOutput {
  speech_act?: unknown;
  scope?: unknown;
  valid_until?: unknown;
  anchor_entity?: unknown;
  role_condition?: unknown;
  confidence?: unknown;
  reasoning?: unknown;
}

export interface ScopeInput {
  /** The statement text — the user's, or a corpus row's. */
  text: string;
  /** ISO date the statement was made. Blank when the user did not supply one. */
  date?: string;
}

/**
 * Apply the deterministic overrides to a parsed classifier response.
 *
 * Pure: no clock, no I/O. The source node stamps `Scope Classified At` with
 * `new Date()`; that is the caller's job here so this stays testable.
 */
export function scopePostCheck(
  input: ScopeInput,
  raw: RawScopeOutput | null,
  model: string,
): ScopeClassification {
  const text = S(input.text);
  const date = S(input.date);
  const p = raw ?? {};
  const flags: string[] = [];

  // Defaults match the source: an unreadable field falls back to the weakest
  // claim (POSITION / STANDING / NONE) rather than to nothing.
  let speech = U(p.speech_act) || 'POSITION';
  let scope = U(p.scope) || 'STANDING';
  let until = S(p.valid_until);
  const anchor = S(p.anchor_entity);
  let role = U(p.role_condition) || 'NONE';

  // A value outside the vocabulary is not passed through — it would defeat
  // every downstream `=== 'BOUNDED'` test silently.
  if (!SPEECH_ACTS.has(speech)) {
    flags.push(`SPEECH_ACT_UNRECOGNISED:${speech}`);
    speech = 'POSITION';
  }
  if (!SCOPES.has(scope)) {
    flags.push(`SCOPE_UNRECOGNISED:${scope}`);
    scope = 'STANDING';
  }
  if (!ROLE_CONDITIONS.has(role)) {
    flags.push(`ROLE_CONDITION_UNRECOGNISED:${role}`);
    role = 'NONE';
  }

  // ---- Deterministic overrides — conservative regexes; when they fire, they win.
  if (OPERATIONAL_RE.test(text) && speech !== 'OPERATIONAL') {
    speech = 'OPERATIONAL';
    flags.push('SPEECH_ACT_OVERRIDE_OPERATIONAL');
  }
  if (CREDIT_RE.test(text) && speech === 'COMMITMENT') {
    speech = 'CREDIT_CLAIM';
    flags.push('SPEECH_ACT_OVERRIDE_CREDIT');
  }
  if ((BOUNDED_RE.test(text) || speech === 'OPERATIONAL') && scope !== 'BOUNDED') {
    scope = 'BOUNDED';
    flags.push('SCOPE_OVERRIDE_BOUNDED');
  }
  if (LEADER_RE.test(text) && role === 'NONE') {
    role = 'MAJORITY_LEADER';
    flags.push('ROLE_OVERRIDE_LEADER');
  }

  // ---- valid_until fallback when the model left it blank on a BOUNDED statement
  if (scope === 'BOUNDED' && (!until || until === VALID_UNTIL_UNKNOWN)) {
    const pres = text.match(/\b(Biden|Trump|Obama)\b/i);
    const fy = text.match(/\b(?:FY ?|fiscal year )(20\d\d)\b/i);
    if (pres) until = PRES_TERM_END[pres[1]!.toUpperCase()]!;
    else if (fy) until = `${fy[1]}-09-30`;
    else if (/\b(today|tomorrow|this week|next week|this work period)\b/i.test(text)) {
      until = date ? addDays(date, 30) : VALID_UNTIL_UNKNOWN;
    } else if (/\bupcoming NDAA|this year's/i.test(text)) {
      until = date ? `${date.slice(0, 4)}-12-31` : VALID_UNTIL_UNKNOWN;
    } else {
      until = date ? addDays(date, 730) : VALID_UNTIL_UNKNOWN;
    }
    flags.push('VALID_UNTIL_DERIVED');
  }

  // STANDING carries no last testable date. Empty, never UNKNOWN — those mean
  // different things and only one of them should stop a query.
  if (scope === 'STANDING') until = '';

  const confidence = typeof p.confidence === 'number' ? p.confidence : 0;

  return {
    speech_act: speech as SpeechAct,
    scope: scope as StatementScope,
    valid_until: until,
    anchor_entity: anchor,
    role_condition: role as RoleCondition,
    confidence,
    reasoning: S(p.reasoning) + (flags.length ? ` [${flags.join(',')}]` : ''),
    flags,
    model,
  };
}
