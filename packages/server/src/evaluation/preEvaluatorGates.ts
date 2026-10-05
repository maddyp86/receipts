import type { AlignmentOutcome } from '@receipts/shared';

// ===========================================================================
// PRE-EVALUATOR GATES.
//
// SOURCE: docs/fix/03_wf10a_pre_evaluator_gates.js (2026-09-05), the WF10a Code
// node between `Enrich With Statement Type` and `Scorable?`.
// Ported 2026-09-07. Copy the logic, not the n8n plumbing: the original reads
// reference data through $('Get Statements') / $('Get Roll Call Votes') /
// $('Get Politician'), which become the `refs` argument here.
//
// DETERMINISTIC. Every rule is one the evaluator cannot be trusted to apply
// because it lacks the inputs, and EVERY RULE FAILS OPEN when its inputs are
// missing — a missing column costs one wasted evaluation, never a silently
// dropped statement. The reason string always says what it could and could not
// see, because "the gate did not fire" and "the gate could not run" are
// different facts and only one of them is about the senator.
//
// GATED ROWS ARE DISPLAYED, NOT DROPPED. WF10a writes a terminal record with
// the gate's reason rather than deleting the row; the query tool's equivalent
// is that the caller renders the reason. "Not evaluated: leader procedural
// vote" is useful to a reader — it is the thing that makes the tool look
// honest rather than thin.
//
// Order matters and is the source's: first hit wins, but every hit is recorded.
// ===========================================================================

const S = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const U = (v: unknown): string => S(v).toUpperCase();

/** Normalises to YEA/NAY/NOT_VOTING. Distinct from deriveAlignment's voteOf,
 *  which collapses NOT_VOTING to null — the gates need to tell an abstention
 *  apart from an absent field. */
function voteOf(v: unknown): 'YEA' | 'NAY' | 'NOT_VOTING' | null {
  const t = U(v);
  if (t === 'YEA' || t === 'AYE' || t === 'YES') return 'YEA';
  if (t === 'NAY' || t === 'NO') return 'NAY';
  if (t.includes('NOT')) return 'NOT_VOTING';
  return null;
}

function parseDate(v: unknown): Date | null {
  const t = S(v);
  if (!t || t === 'NA' || t === 'N/A' || t === 'UNKNOWN') return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

const iso = (d: Date | null): string => (d ? d.toISOString().slice(0, 10) : 'unknown');

/** '…-119' -> '119'. The Congress is encoded in the bill id and nowhere else. */
export const congressOf = (billId: unknown): string =>
  /-(\d{3})$/.exec(S(billId))?.[1] ?? '';

// ---- Reference data, transcribed verbatim from the source -----------------

/**
 * Fallback only — prefer a `Role` column on the Politicians tab, format
 * "MAJORITY_LEADER:119;MINORITY_LEADER:118".
 *
 * The mirror now carries real values (verified 2026-09-07: Thune reads
 * "MINORITY_WHIP:118;MAJORITY_LEADER:119"), so this is the belt to that
 * braces, not the primary source.
 */
export const FLOOR_LEADERS_FALLBACK: Record<string, Record<string, string>> = {
  '118': { S000148: 'MAJORITY_LEADER', M000355: 'MINORITY_LEADER' },
  '119': { T000250: 'MAJORITY_LEADER', S000148: 'MINORITY_LEADER' },
};

const PRESIDENT_BY_CONGRESS: Record<string, string> = {
  '117': 'BIDEN',
  '118': 'BIDEN',
  '119': 'TRUMP',
};

const CONGRESS_START: Record<string, string> = {
  '117': '2021-01-03',
  '118': '2023-01-03',
  '119': '2025-01-03',
  '120': '2027-01-03',
};

const BROAD_VEHICLE_RE =
  /continuing appropriations|consolidated appropriations|further appropriations|omnibus|minibus|authorize appropriations for fiscal year|making appropriations for the department|making appropriations for military construction|making emergency supplemental appropriations|en bloc consideration/i;

const GENERIC_STAKEHOLDER_RE =
  /^(federal agencies( and executive branch departments)?|department of defense|active duty military personnel|senators|u\.s\. senators|federal government|congress|federal agencies and departments)$/i;

const REVERSAL_RE = /disapproval|disapproving|terminating|to repeal/i;

const NON_SCORABLE_SPEECH = new Set(['OPERATIONAL', 'CREDIT_CLAIM', 'RHETORIC']);

// ---- Reader-facing words for the gate reasons ------------------------------
//
// Every `reason` below is rendered verbatim on a "Found, but not evaluated"
// card. It is written for a voter, not an analyst: no field names, no enum
// values, no roll-call ids. The gate id and raw inputs stay in the trace.
// Each one says what the rule did and why, as a rule — never that the bill is
// incapable of bearing on the statement, and never why the senator acted.

const SPEECH_ACT_PHRASE: Record<string, string> = {
  OPERATIONAL: 'a statement about scheduling or process',
  CREDIT_CLAIM: 'a claim of credit for something already done',
  RHETORIC: 'a rhetorical statement',
};

const ROLE_PHRASE: Record<string, string> = {
  MAJORITY_LEADER: 'majority leader',
  MINORITY_LEADER: 'minority leader',
  MAJORITY_WHIP: 'majority whip',
  MINORITY_WHIP: 'minority whip',
  NONE: 'not in party leadership',
};
const rolePhrase = (role: string): string => ROLE_PHRASE[role] ?? role.replace(/_/g, ' ').toLowerCase();

const titleCase = (s: string): string => s.charAt(0) + s.slice(1).toLowerCase();

/** "January 20, 2025", in UTC. */
const longDay = (d: Date | null | undefined): string =>
  d ? d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) : 'an unknown date';

const ordinalOf = (n: string): string => {
  const v = Number(n);
  const rem = v % 100;
  if (rem >= 11 && rem <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[v % 10] ?? 'th'}`;
};

// ---- Types ----------------------------------------------------------------

export type GateId =
  | 'G1_scope'
  | 'G2_split_vote'
  | 'G3_leader_switch'
  | 'G4_vehicle';

export interface GateHit {
  gate: GateId;
  /** The terminal verdict this gate assigns. */
  verdict: AlignmentOutcome;
  /** Plain-language, safe to show a reader verbatim. Says what it could not see. */
  reason: string;
}

/** What the gates need about one candidate action. */
export interface GateRow {
  politician_id: string;
  bill_id: string;
  promise_text: string;
  bill_title: string;
  cloture_vote?: string | null;
  passage_vote?: string | null;
  party_whip_vote?: string | null;
  cloture_vote_id?: string | null;
  cloture_vote_date?: string | null;
  passage_vote_date?: string | null;
  /**
   * The date the senator joined the bill, from WF2c's `Cosponsored At`.
   *
   * NOT the row's `Action Date`, which the ingestion workflow stamps with the
   * bill's introduction date for every cosponsorship. Supplying it here lets a
   * vote-less sponsorship be dated from the record instead of from the
   * Congress-start proxy below.
   */
  cosponsored_at?: string | null;
  /** From the relevance step; DATED_VEHICLE closes G4b. */
  partial_subtype?: string | null;
  anchor_vehicle?: string | null;
  /** First group, or every group when the impact analysis was joined. */
  stakeholder_groups?: string[];
}

/** The statement-side scope fields, from the live classifier or the corpus. */
export interface GateStatementMeta {
  date?: Date | null;
  scope?: string;
  validUntil?: Date | null;
  validUntilRaw?: string;
  anchor?: string;
  roleCondition?: string;
  speechAct?: string;
}

export interface GateRefs {
  /** Senator's role at that Congress. Return 'NONE' when not in leadership. */
  roleAt(politicianId: string, congress: string): string;
  /** Normalised cloture outcome: 'AGREED' | 'REJECTED' | '' when unknown. */
  clotureResult(voteId: string): string;
  /** False when the roll-call source has no result column at all. */
  rollCallHasResult?: boolean;
}

/** Context the evaluator v7 prompt expects, produced whether or not a gate fired. */
export interface EvaluatorContext {
  promise_date: string;
  scope: string;
  valid_until: string;
  anchor_entity: string;
  role_condition: string;
  senator_role: string;
  cloture_result: string;
  bill_congress: string;
  action_date: string;
  bill_class: 'BROAD_VEHICLE' | 'REVERSAL' | 'TARGETED';
  vote_flags: string[];
}

export interface GateResult {
  /** True when this row should proceed to the evaluator. */
  scorable: boolean;
  /** The first hit, which supplies the terminal verdict. Null when scorable. */
  hit: GateHit | null;
  /** Every hit, in order. `hits[0] === hit`. */
  hits: GateHit[];
  context: EvaluatorContext;
}

/** Normalises a roll-call result string to the two outcomes G3 cares about. */
export function normaliseClotureResult(raw: unknown): string {
  const r = U(raw);
  if (!r) return '';
  if (/REJECT|FAIL|NOT AGREED|NOT INVOKED/.test(r)) return 'REJECTED';
  if (/AGREED|INVOKED|PASS|CONFIRM|ADOPT/.test(r)) return 'AGREED';
  return r;
}

/**
 * Run the gates for one candidate action.
 *
 * Pure: no I/O, no clock. Reference lookups arrive through `refs` so the caller
 * owns where they come from (the Supabase mirror today, Sheets in the pipeline).
 */
export function preEvaluatorGates(
  row: GateRow,
  meta: GateStatementMeta,
  refs: GateRefs,
): GateResult {
  const hits: GateHit[] = [];

  const congress = congressOf(row.bill_id);
  const promise = S(row.promise_text);
  const title = S(row.bill_title);

  const cloture = voteOf(row.cloture_vote);
  const passage = voteOf(row.passage_vote);
  const whip = voteOf(row.party_whip_vote);
  const clotureId = S(row.cloture_vote_id);
  const clotureDate = parseDate(row.cloture_vote_date);
  const passageDate = parseDate(row.passage_vote_date);

  // WHEN THIS ACTION HAPPENED, best real date first.
  //
  // A recorded vote dates itself, so passage and cloture still lead. Behind
  // them sits `Cosponsored At` — the date the senator's name went on the bill,
  // which for a vote-less sponsorship is the only real date there is. It was
  // previously unavailable here, so every such row fell through to the proxy.
  //
  // Congress start is a PROXY, not a date we know. It is the earliest an action
  // in that Congress could have happened, so a window test built on it
  // under-fires rather than over-fires — the safe direction. Flagged so a
  // reader can tell a real date from a stand-in.
  //
  // NOTE the row's own `Action Date` is deliberately still not read: the
  // ingestion workflow stamps it with the bill's INTRODUCTION date for every
  // cosponsorship, so it is wrong by up to 659 days on the live corpus.
  const cosponsoredDate = parseDate(row.cosponsored_at);
  const actionDate =
    passageDate ??
    clotureDate ??
    cosponsoredDate ??
    (congress && CONGRESS_START[congress] ? new Date(CONGRESS_START[congress]!) : null);
  const actionDateIsProxy = !passageDate && !clotureDate && !cosponsoredDate;

  const senatorRole = refs.roleAt(S(row.politician_id), congress) || 'NONE';
  const clotureResult = normaliseClotureResult(refs.clotureResult(clotureId));

  const groups = row.stakeholder_groups?.length ? row.stakeholder_groups : [];
  const allGeneric =
    groups.length > 0 && groups.every((g) => !S(g) || GENERIC_STAKEHOLDER_RE.test(S(g)));
  const broad = BROAD_VEHICLE_RE.test(title);
  const billClass: EvaluatorContext['bill_class'] = broad
    ? 'BROAD_VEHICLE'
    : REVERSAL_RE.test(title)
      ? 'REVERSAL'
      : 'TARGETED';

  const speechAct = U(meta.speechAct);
  const scope = U(meta.scope);
  const roleCondition = U(meta.roleCondition);

  // ---- G1d: speech act ----------------------------------------------------
  if (speechAct && NON_SCORABLE_SPEECH.has(speechAct)) {
    hits.push({
      gate: 'G1_scope',
      verdict: 'NOT_APPLICABLE',
      reason:
        `We read this statement as ${SPEECH_ACT_PHRASE[speechAct] ?? 'something other than a policy commitment'}. ` +
        `A statement like that doesn't commit to anything a vote or a sponsorship could carry out or go against.`,
    });
  }

  // ---- G1a: bounded window ------------------------------------------------
  if (!hits.length && scope === 'BOUNDED') {
    if (meta.validUntil && actionDate && actionDate > meta.validUntil) {
      hits.push({
        gate: 'G1_scope',
        verdict: 'NOT_APPLICABLE_EXPIRED',
        reason:
          `We read this statement as applying only until ${longDay(meta.validUntil)}` +
          `${meta.anchor ? ` (tied to ${meta.anchor})` : ''}. ` +
          (actionDateIsProxy
            ? `We don't have this action's exact date, but the Congress it belongs to began after ` +
              `that, on ${longDay(actionDate)}`
            : `This action came after that, on ${longDay(actionDate)}`) +
          `, so we didn't count it toward the statement.`,
      });
    } else if (!meta.validUntil && S(meta.validUntilRaw) === 'UNKNOWN') {
      hits.push({
        gate: 'G1_scope',
        verdict: 'NOT_DETERMINABLE',
        reason:
          `We read this statement as applying to a limited period, but couldn't work out when that ` +
          `period ended, so we can't tell whether this action falls inside it.`,
      });
    }
  }

  // ---- G1b: administration anchor -----------------------------------------
  if (!hits.length) {
    const m = /President (Biden|Trump|Obama)|(Biden|Trump|Obama)('s)? (administration|EPA|nominees|judicial nominees)/i.exec(
      promise,
    );
    const named = m ? U(m[1] ?? m[2]) : '';
    if (named && congress && PRESIDENT_BY_CONGRESS[congress] && PRESIDENT_BY_CONGRESS[congress] !== named) {
      hits.push({
        gate: 'G1_scope',
        verdict: 'NOT_APPLICABLE_EXPIRED',
        reason:
          `This statement is about the ${titleCase(named)} administration, but this bill is from the ` +
          `${ordinalOf(congress)} Congress, during the ${titleCase(PRESIDENT_BY_CONGRESS[congress]!)} ` +
          `administration, so we didn't count it toward the statement.`,
      });
    }
  }

  // ---- G1c: role precondition ---------------------------------------------
  if (!hits.length && roleCondition === 'MAJORITY_LEADER' && senatorRole !== 'MAJORITY_LEADER') {
    hits.push({
      gate: 'G1_scope',
      verdict: 'NOT_APPLICABLE_EXPIRED',
      reason:
        `This statement assumes the senator controls what reaches the Senate floor, as majority ` +
        `leader. During that Congress they were ${rolePhrase(senatorRole)}, so that condition ` +
        `didn't hold and we didn't count this action toward the statement.`,
    });
  }

  // ---- G4b: relevance said the statement pointed at one closed vehicle ----
  if (!hits.length && U(row.partial_subtype) === 'DATED_VEHICLE') {
    hits.push({
      gate: 'G4_vehicle',
      verdict: 'NOT_APPLICABLE_EXPIRED',
      reason:
        `We read this statement as being about one specific bill` +
        `${S(row.anchor_vehicle) ? ` (${S(row.anchor_vehicle)})` : ''}, and this appears to be a ` +
        `different one, so we didn't count it toward the statement.`,
    });
  }

  // ---- G2: vote pairing sanity --------------------------------------------
  if (!hits.length && clotureDate && passageDate && clotureDate > passageDate) {
    hits.push({
      gate: 'G2_split_vote',
      verdict: 'NOT_DETERMINABLE',
      reason:
        `The vote to end debate (${longDay(clotureDate)}) is dated after the vote to pass the ` +
        `bill (${longDay(passageDate)}), so the two were probably on different versions of it. ` +
        `We can't read them together as one action, so we didn't weigh this one.`,
    });
  }

  // ---- G3: floor leader reconsideration switch ----------------------------
  //
  // The gate that accounted for 15 of the 79 false positives. Fires when the
  // result is REJECTED *or unknown* — unknown is the fail-open direction here,
  // because reading a leader's Rule XIII manoeuvre as opposition is the error
  // that matters, and the reason string discloses that the outcome was not
  // verified.
  if (!hits.length && senatorRole !== 'NONE' && cloture === 'NAY' && whip === 'YEA') {
    const resultKnown = Boolean(clotureResult);
    if (!resultKnown || clotureResult === 'REJECTED') {
      hits.push({
        gate: 'G3_leader_switch',
        verdict: 'PROCEDURAL_SWITCH',
        // No motive: the rule says what a no vote in this position MAY be
        // for, and the gate declines to read it — it does not say what the
        // senator intended.
        reason:
          `As ${rolePhrase(senatorRole)}, the senator voted no on ending debate while their party's ` +
          `whip voted yes` +
          (resultKnown
            ? ', and the motion failed'
            : refs.rollCallHasResult === false
              ? ' — our record doesn\'t say whether the motion failed'
              : ' — we couldn\'t find whether the motion failed') +
          `. Senate rules (Rule XIII) let only a senator who voted on the winning side move to ` +
          `reconsider a vote, so a party leader may vote no on a failing motion to keep that ` +
          `option open. A no vote in that position isn't clear evidence either way, so we didn't ` +
          `read it as support or opposition.`,
      });
    }
  }

  // ---- G4: broad vehicle with generic stakeholders -------------------------
  if (!hits.length && broad && allGeneric) {
    hits.push({
      gate: 'G4_vehicle',
      verdict: 'NOT_DETERMINABLE',
      reason:
        `This is a broad bill that funds or authorizes many things at once ` +
        `(“${title.length > 80 ? `${title.slice(0, 80).trimEnd()}…` : title}”), and our analysis of it ` +
        `doesn't name anything specific to this statement. A vote on a bill like that isn't ` +
        `evidence about one statement unless the bill names what the statement is about, so we ` +
        `didn't weigh it.`,
    });
  }

  // ---- Context, produced whether or not a gate fired ----------------------
  const voteFlags: string[] = [];
  if (cloture && passage && cloture !== passage && cloture !== 'NOT_VOTING' && passage !== 'NOT_VOTING') {
    voteFlags.push('SPLIT_VOTE');
  }
  if (actionDateIsProxy) voteFlags.push('ACTION_DATE_PROXY');
  if (senatorRole !== 'NONE') voteFlags.push('FLOOR_LEADER');

  return {
    scorable: hits.length === 0,
    hit: hits[0] ?? null,
    hits,
    context: {
      promise_date: iso(meta.date ?? null),
      scope: meta.scope || 'UNKNOWN',
      valid_until: meta.validUntil ? iso(meta.validUntil) : S(meta.validUntilRaw),
      anchor_entity: S(meta.anchor),
      role_condition: meta.roleCondition || 'UNKNOWN',
      senator_role: senatorRole,
      cloture_result: clotureResult || 'UNKNOWN',
      bill_congress: congress,
      action_date: iso(actionDate),
      bill_class: billClass,
      vote_flags: voteFlags,
    },
  };
}

/**
 * The `refs` implementation for a tool with no enrichment source.
 *
 * Every gate that depends on reference data then fails open, which is the
 * source's intent — but `roleAt` still uses the hardcoded floor-leader table,
 * because that is the source's own fallback rather than an absence.
 */
export const NULL_GATE_REFS: GateRefs = {
  roleAt: (politicianId, congress) =>
    FLOOR_LEADERS_FALLBACK[congress]?.[politicianId] ?? 'NONE',
  clotureResult: () => '',
  rollCallHasResult: false,
};
