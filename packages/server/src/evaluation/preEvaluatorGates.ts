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

  // Congress start is a PROXY, not a date we know. It is the earliest an action
  // in that Congress could have happened, so a window test built on it
  // under-fires rather than over-fires — the safe direction. Flagged so a
  // reader can tell a real date from a stand-in.
  const actionDate =
    passageDate ??
    clotureDate ??
    (congress && CONGRESS_START[congress] ? new Date(CONGRESS_START[congress]!) : null);
  const actionDateIsProxy = !passageDate && !clotureDate;

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
        `Speech Act is ${speechAct}. Scheduling, credit-claiming and rhetorical statements ` +
        `have no deliverable a vote or sponsorship can fulfil or break.`,
    });
  }

  // ---- G1a: bounded window ------------------------------------------------
  if (!hits.length && scope === 'BOUNDED') {
    if (meta.validUntil && actionDate && actionDate > meta.validUntil) {
      hits.push({
        gate: 'G1_scope',
        verdict: 'NOT_APPLICABLE_EXPIRED',
        reason:
          `Bounded statement (${meta.anchor || 'window'}) valid until ${iso(meta.validUntil)}; ` +
          `this action is dated ${iso(actionDate)}` +
          `${actionDateIsProxy ? ' (Congress start used as proxy — no vote date on row)' : ''}. ` +
          `The statement had already closed.`,
      });
    } else if (!meta.validUntil && S(meta.validUntilRaw) === 'UNKNOWN') {
      hits.push({
        gate: 'G1_scope',
        verdict: 'NOT_DETERMINABLE',
        reason:
          `Bounded statement with no resolvable window (Valid Until = UNKNOWN, statement date ` +
          `${iso(meta.date ?? null)}). Cannot establish whether this action falls inside it.`,
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
          `Statement is about the ${named} administration; the bill is from the ${congress}th ` +
          `Congress (${PRESIDENT_BY_CONGRESS[congress]} administration). Different object.`,
      });
    }
  }

  // ---- G1c: role precondition ---------------------------------------------
  if (!hits.length && roleCondition === 'MAJORITY_LEADER' && senatorRole !== 'MAJORITY_LEADER') {
    hits.push({
      gate: 'G1_scope',
      verdict: 'NOT_APPLICABLE_EXPIRED',
      reason:
        `Statement presupposes control of the floor (Role Condition = MAJORITY_LEADER); at the ` +
        `time of this action the senator was ` +
        `${senatorRole === 'NONE' ? 'not in leadership' : senatorRole}. The precondition no ` +
        `longer held.`,
    });
  }

  // ---- G4b: relevance said the statement pointed at one closed vehicle ----
  if (!hits.length && U(row.partial_subtype) === 'DATED_VEHICLE') {
    hits.push({
      gate: 'G4_vehicle',
      verdict: 'NOT_APPLICABLE_EXPIRED',
      reason:
        `Relevance step classified the statement as pointing at a specific closed vehicle ` +
        `(${S(row.anchor_vehicle) || 'see Anchor Vehicle'}); this bill is a different one.`,
    });
  }

  // ---- G2: vote pairing sanity --------------------------------------------
  if (!hits.length && clotureDate && passageDate && clotureDate > passageDate) {
    hits.push({
      gate: 'G2_split_vote',
      verdict: 'NOT_DETERMINABLE',
      reason:
        `Cloture (${iso(clotureDate)}) is dated after passage (${iso(passageDate)}): the two ` +
        `votes are on different versions of the vehicle. Cannot pair them into one action.`,
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
        reason:
          `${senatorRole.replace('_', ' ').toLowerCase()} voted NAY on cloture (${clotureId || 'id unknown'}) ` +
          `while the party whip voted YEA` +
          (resultKnown
            ? ' and cloture was rejected'
            : refs.rollCallHasResult === false
              ? '; the roll-call source has no result column, so the outcome is unverified'
              : '; cloture result not found for this roll call') +
          `. Under Senate Rule XIII only a member on the prevailing side may move to reconsider, ` +
          `so a leader switching to NAY on a failing cloture is preserving that motion, not ` +
          `opposing the bill.`,
      });
    }
  }

  // ---- G4: broad vehicle with generic stakeholders -------------------------
  if (!hits.length && broad && allGeneric) {
    hits.push({
      gate: 'G4_vehicle',
      verdict: 'NOT_DETERMINABLE',
      reason:
        `Bill is a broad vehicle ("${title.slice(0, 80)}") and the impact analysis names only ` +
        `generic stakeholders (${groups.filter(Boolean).join('; ') || 'none'}). A vote on a ` +
        `vehicle that funds or authorizes everything is not evidence about one statement unless ` +
        `the promised item is named.`,
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
