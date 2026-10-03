import { ordinal, type TextVersionDisclosure } from '@receipts/shared';
import type { BillEnrichment, SponsorshipEnrichment } from '../evaluation/enrichment.js';
import committeeData from './committees.json' with { type: 'json' };

// ===========================================================================
// THE RECORD SENTENCE — what a senator did on a bill, and what became of it.
//
//   "Co-sponsored the bill as the 34th of 41 co-sponsors, about 3 months after
//    introduction (June 12, 2025). Referred to the Senate Committee on
//    Commerce, Science, and Transportation, where the senator sits; no
//    committee action after referral is recorded. It did not advance past
//    committee before the 118th Congress ended."
//
// BUILT IN CODE, NOT BY THE MODEL. Brief 3 asks for every clause to be
// citable from the pipeline's fields; a model asked to write it would add the
// one word the record cannot support. So each clause is assembled from named
// columns and carries the list of them (`sources`), and a test holds that
// every clause has one. The explainer is handed the finished sentence and told
// to quote it or leave it out.
//
// ── THE RECORD, NOT MOTIVE ────────────────────────────────────────────────
// "Did not advance past committee", never "abandoned". The sponsorship tier
// is never named: SPONSOR_ADVANCED means the bill reached a hearing, markup,
// report or further, not that the sponsor moved it — so this describes the
// Committee Activity itself. No pronouns: a senator's are not in the data,
// and "the senator" is never wrong.
//
// ── WHAT IS LEFT OUT, DELIBERATELY ────────────────────────────────────────
// - Committee membership unless it is TRUE. FALSE invites an inference the
//   record does not make; NA_PRIOR_CONGRESS, UNAVAILABLE and NO_COMMITTEE are
//   "we do not know", and say nothing.
// - The committee clause on a bill REWRITTEN under the same number. Bills
//   Master records committee activity for the bill number across all its
//   versions, so on s1071-119 "referred to Armed Services" belongs to the NDAA,
//   not to the VA bill a March 2025 co-sponsor signed. Unattributable, so
//   omitted.
// - Committee detail on a vote. A senator voting on the floor did not join the
//   bill in committee; only the outcome is relevant.
//
// PRESENTATION ONLY. Nothing here reaches a verdict, a band or a weight.
// ===========================================================================

const COMMITTEES: Record<string, string> = committeeData.committees;

const S = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const flag = (v: unknown): boolean =>
  typeof v === 'boolean' ? v : ['TRUE', 'YES', 'Y', '1'].includes(S(v).toUpperCase());

export interface RecordInput {
  bill_id: string;
  is_sponsor?: boolean | string | null;
  is_cosponsor?: boolean | string | null;
  /** WF2c, from Politician Bill Actions. */
  sponsorship?: SponsorshipEnrichment | null;
  /** WF2c, from Bills Master. */
  bill?: BillEnrichment | null;
  /** Which version of the text the action was evaluated against. */
  text_version?: TextVersionDisclosure | null;
}

export interface RecordClause {
  text: string;
  /** The pipeline columns this clause was built from. Never empty. */
  sources: string[];
}

export interface RecordSentence {
  sentence: string;
  clauses: RecordClause[];
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** 'YYYY-MM-DD' -> 'March 14, 2025'. Null when it is not a date. */
export function longDate(iso: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(S(iso));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/** Days after introduction, as a reader would say it. Exact under 60 days. */
export function afterIntroduction(days: number): string {
  if (days <= 0) return 'on the day it was introduced';
  if (days === 1) return '1 day after introduction';
  if (days < 60) return `${days} days after introduction`;
  if (days < 730) return `about ${Math.round(days / 30.44)} months after introduction`;
  return `about ${Math.round(days / 365.25)} years after introduction`;
}

const BILL_TYPE: Record<string, string> = {
  s: 'S.', hr: 'H.R.', sjres: 'S.J.Res.', hjres: 'H.J.Res.', sres: 'S.Res.', hres: 'H.Res.',
  sconres: 'S.Con.Res.', hconres: 'H.Con.Res.',
};

/** 'hr2617-117' -> 'H.R. 2617' (+ ' of the 117th Congress' when it differs). */
export function billLabel(billId: string, relativeTo?: string): string {
  const m = /^([a-z]+)(\d+)-(\d+)$/.exec(S(billId).toLowerCase());
  if (!m) return S(billId);
  const label = `${BILL_TYPE[m[1]!] ?? m[1]!.toUpperCase()} ${m[2]}`;
  const own = /-(\d+)$/.exec(S(relativeTo))?.[1];
  return own && own !== m[3] ? `${label} of the ${ordinal(Number(m[3]))} Congress` : label;
}

/** 'bill' for S./H.R., 'resolution' for every joint, concurrent and simple resolution. */
export function measureNoun(billId: string): 'bill' | 'resolution' {
  return /^(s|h)(j|con)?res\d/i.test(S(billId)) ? 'resolution' : 'bill';
}

const joinAnd = (xs: string[]): string =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

const lowerFirst = (s: string): string => (s ? s[0]!.toLowerCase() + s.slice(1) : s);

// ---------------------------------------------------------------------------
// Clauses
// ---------------------------------------------------------------------------

function sponsorshipClauses(input: RecordInput): RecordClause[] {
  const s = input.sponsorship ?? {};
  const noun = measureNoun(input.bill_id);
  const tier = S(s.sponsor_tier).toUpperCase();
  const date = longDate(s.cosponsored_at);
  const out: RecordClause[] = [];

  if (flag(input.is_sponsor)) {
    out.push({
      text: date ? `Sponsored the ${noun}, introducing it on ${date}.` : `Sponsored the ${noun}.`,
      sources: date ? ['Is Sponsor', 'Cosponsored At'] : ['Is Sponsor'],
    });
  } else if (flag(input.is_cosponsor)) {
    // A tier that contradicts the flag is ignored, as in effortSignals.
    const original = tier === 'ORIGINAL_COSPONSOR' || (tier !== 'LATE_COSPONSOR' && s.original_cosponsor === true);
    const late = tier === 'LATE_COSPONSOR' || (tier !== 'ORIGINAL_COSPONSOR' && s.original_cosponsor === false);
    const total = s.cosponsor_total ?? null;

    if (original) {
      out.push({
        text:
          `Co-sponsored the ${noun} from its introduction${date ? ` on ${date}` : ''}` +
          `${total === 1 ? ', its only co-sponsor' : total ? `, one of ${total} co-sponsors` : ''}.`,
        sources: ['Is Co-Sponsor', 'Sponsor Tier', ...(date ? ['Cosponsored At'] : []), ...(total ? ['Cosponsor Total'] : [])],
      });
    } else if (late) {
      const ord = s.cosponsor_ordinal ?? null;
      const days = s.days_after_introduction ?? null;
      const position = ord && total ? ` as the ${ordinal(ord)} of ${total} co-sponsors` : '';
      const when = days !== null ? `, ${afterIntroduction(days)}` : '';
      out.push({
        text: `Co-sponsored the ${noun}${position}${when}${date ? ` (${date})` : ''}.`,
        sources: [
          'Is Co-Sponsor', 'Sponsor Tier',
          ...(position ? ['Cosponsor Ordinal', 'Cosponsor Total'] : []),
          ...(when ? ['Days After Introduction'] : []),
          ...(date ? ['Cosponsored At'] : []),
        ],
      });
    } else {
      out.push({
        text: date ? `Co-sponsored the ${noun} on ${date}.` : `Co-sponsored the ${noun}.`,
        sources: date ? ['Is Co-Sponsor', 'Cosponsored At'] : ['Is Co-Sponsor'],
      });
    }
  }

  // Disclosed, never scored — the brief's rule for a withdrawn name.
  const withdrawn = longDate(s.withdrawn_at);
  if (withdrawn) out.push({ text: `Withdrew as a co-sponsor on ${withdrawn}.`, sources: ['Withdrawn At'] });

  return out;
}

type CommitteeAct = 'hearing' | 'markup' | 'report' | 'discharged';

/** The bill's stage says it never got past referral. */
const stalledAtReferral = (bill: BillEnrichment): boolean =>
  ['INTRODUCED', 'REFERRED'].includes(S(bill.progress_stage).toUpperCase());

/**
 * Committee Activity arrives in two vocabularies — congress.gov's ("Reported
 * By", "Hearings By (subcommittee)") and the scraper's ("reporting", "markup")
 * — as "SSCM: Referred To, Reported By | HSAS: Unknown". Referral itself,
 * "Unknown" and "Bills of Interest - Exchange of Letters" are not actions on
 * the bill and are not reported.
 */
export function committeeActs(activity: string | null | undefined): Set<CommitteeAct> {
  const acts = new Set<CommitteeAct>();
  for (const set of actsByCommittee(activity).values()) for (const a of set) acts.add(a);
  return acts;
}

/** The same, kept per committee code — Committee Activity records which committee did what. */
export function actsByCommittee(activity: string | null | undefined): Map<string, Set<CommitteeAct>> {
  const out = new Map<string, Set<CommitteeAct>>();
  for (const part of S(activity).split('|')) {
    if (!part.includes(':')) continue;
    const code = part.slice(0, part.indexOf(':')).trim().toUpperCase();
    const acts = out.get(code) ?? new Set<CommitteeAct>();
    for (const raw of part.slice(part.indexOf(':') + 1).split(',')) {
      const a = raw.trim().toLowerCase();
      if (/^hearings? by|^hearing/.test(a)) acts.add('hearing');
      else if (/markup/.test(a)) acts.add('markup');
      else if (/^reported|^reporting/.test(a)) acts.add('report');
      else if (/discharged/.test(a)) acts.add('discharged');
    }
    if (acts.size) out.set(code, acts);
  }
  return out;
}

function committeeClause(input: RecordInput): RecordClause | null {
  const bill = input.bill;
  const referred = [...new Set((bill?.referred_committees ?? []).map((c) => S(c).toUpperCase()).filter(Boolean))];
  if (!bill || !referred.length) return null;

  const named = referred.map((c) => COMMITTEES[c]).filter((n): n is string => Boolean(n));
  const sources = ['Referred Committees'];
  let text = named.length ? `Referred to ${joinAnd(named.map((n) => `the ${n}`))}` : 'Referred to committee';

  const s = input.sponsorship ?? {};
  const sits = S(s.committee_member).toUpperCase() === 'TRUE';
  const memberOf = (s.committee_member_of ?? []).map((c) => S(c).toUpperCase()).filter((c) => referred.includes(c));
  if (sits && memberOf.length) {
    const memberNames = memberOf.map((c) => COMMITTEES[c]).filter((n): n is string => Boolean(n));
    if (referred.length === 1) text += ', where the senator sits';
    else if (memberNames.length) text += `; the senator sits on the ${joinAnd(memberNames)}`;
    sources.push('Committee Member', 'Committee Member Of');
  }

  const byCommittee = actsByCommittee(bill.committee_activity);
  const acts = committeeActs(bill.committee_activity);
  const verbsOf = (a: Set<CommitteeAct>) =>
    [
      a.has('hearing') ? 'held a hearing' : null,
      a.has('markup') ? 'marked it up' : null,
      a.has('report') ? 'reported it' : null,
    ].filter((v): v is string => Boolean(v));
  if (bill.committee_activity) sources.push('Committee Activity');

  // Name the committee that acted. With one referral it is "the committee";
  // with several, the one Committee Activity attributes the action to — on
  // s993-118 a hearing by Banking, not "committees".
  const acting = [...byCommittee.entries()].filter(([, a]) => verbsOf(a).length);
  if (acting.length) {
    const phrases = acting.map(([code, a]) => {
      const subject =
        referred.length === 1 && referred[0] === code
          ? 'the committee'
          : COMMITTEES[code]
            ? `the ${COMMITTEES[code]}`
            : 'a committee';
      return `${subject} ${joinAnd(verbsOf(a))}`;
    });
    text += `; ${phrases.join('; ')}`;
  } else if (!acts.has('discharged') && bill.committee_activity && stalledAtReferral(bill)) {
    // A NEGATIVE is said only when two fields agree. Progress Stage is built
    // from the bill's action log and Committee Activity from its committee
    // list, and they can disagree: s3651-118 reached IN_COMMITTEE while its
    // committee list shows only the referral. Saying "no committee action"
    // there could be false, so it is said only when the stage confirms it.
    text += '; no committee action after referral is recorded';
    sources.push('Progress Stage');
  }
  if (acts.has('discharged')) text += acting.length ? ', and it was discharged from committee' : '; it was discharged from committee';
  return { text: `${text}.`, sources };
}

const STAGE_NOW: Record<string, string> = {
  INTRODUCED: 'No action after introduction is recorded.',
  REFERRED: 'It has not advanced past committee.',
  IN_COMMITTEE: 'It has not reached the floor.',
  ON_CALENDAR: 'It was placed on the calendar and has not had a floor vote.',
  FLOOR: 'It reached the floor and has not passed.',
  PASSED_CHAMBER: 'It has passed one chamber.',
  PASSED_BOTH: 'It has passed both chambers.',
  TO_PRESIDENT: 'It has been sent to the President.',
};

function diedAt(stage: string, congress: string): string {
  const ended = `before the ${congress} Congress ended`;
  switch (stage) {
    case 'INTRODUCED':
    case 'REFERRED':
      return `It did not advance past committee ${ended}.`;
    case 'IN_COMMITTEE':
      return `It did not reach the floor ${ended}.`;
    case 'ON_CALENDAR':
      return `It was on the calendar without a floor vote when the ${congress} Congress ended.`;
    case 'FLOOR':
      return `It reached the floor but did not pass ${ended}.`;
    case 'PASSED_CHAMBER':
      return `It passed one chamber but not the other ${ended}.`;
    default:
      return `It passed both chambers but did not become law ${ended}.`;
  }
}

function outcomeClauses(input: RecordInput): RecordClause[] {
  const bill = input.bill;
  if (!bill) return [];
  const outcome = S(bill.progress_outcome).toUpperCase();
  const stage = S(bill.progress_stage).toUpperCase();
  const at = longDate(bill.progress_stage_at);
  const congressNo = /-(\d+)$/.exec(S(input.bill_id))?.[1];
  const congress = congressNo ? ordinal(Number(congressNo)) : 'that';

  let text: string | null = null;
  if (outcome === 'ENACTED') text = at ? `It became law on ${at}.` : 'It became law.';
  else if (outcome === 'VETOED') text = at ? `It was vetoed on ${at}.` : 'It was vetoed.';
  else if (outcome === 'FAILED') text = 'It failed in a floor vote.';
  // Provisional: a failed cloture or suspension vote does not end a bill.
  else if (outcome === 'PROV_KILL') text = 'A procedural vote to advance it failed, which does not end the bill.';
  else if (outcome === 'AGREED_TO') text = 'It was agreed to.';
  else if (outcome.startsWith('DIED_AT_')) text = diedAt(outcome.slice('DIED_AT_'.length), congress);
  else if (outcome === 'ACTIVE' && STAGE_NOW[stage]) text = STAGE_NOW[stage]!;

  const out: RecordClause[] = [];
  if (text) {
    const sources = ['Progress Outcome', ...(stage ? ['Progress Stage'] : []), ...(at && /became law|vetoed/.test(text) ? ['Progress Stage At'] : [])];
    // The outcome belongs to the bill NUMBER. When the text the senator acted
    // on was later replaced, it is the rewritten bill's outcome, and saying
    // plainly "it became law" of a VA disinterment bill that became the NDAA
    // would be false.
    if (input.text_version?.rewritten) {
      out.push({
        text: `The bill was later rewritten under the same number. As rewritten, ${lowerFirst(text)}`,
        sources: [...sources, 'Title', 'Version Title Source'],
      });
    } else {
      out.push({ text, sources });
    }
  }

  // The legitimate form of the shell-bill pattern: this bill did not pass on
  // its own, but another bill enacted its text. A kept promise the record
  // would otherwise hide.
  const via = S(bill.enacted_via)
    .split(';')
    .map((x) => x.trim())
    .filter((x) => x && x.toUpperCase() !== 'SELF' && x.toUpperCase() !== 'NA');
  if (via.length) {
    out.push({
      text: `Its text became law as part of ${joinAnd(via.map((b) => billLabel(b, input.bill_id)))}.`,
      sources: ['Enacted Via'],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------

/**
 * The record of one action, or null when the pipeline holds nothing about it.
 *
 * A vote gets only the outcome; a sponsorship gets how and when the name went
 * on, the committee path, and the outcome. With no WF2c data at all the
 * sentence is null and the card shows what it showed before.
 */
export function recordSentence(input: RecordInput): RecordSentence | null {
  const sponsored = flag(input.is_sponsor) || flag(input.is_cosponsor);
  const hasSponsorship = Boolean(input.sponsorship && (input.sponsorship.sponsor_tier || input.sponsorship.cosponsored_at));
  const clauses: RecordClause[] = [];

  if (sponsored && hasSponsorship) clauses.push(...sponsorshipClauses(input));
  if (sponsored && !input.text_version?.rewritten) {
    const c = committeeClause(input);
    if (c) clauses.push(c);
  }
  clauses.push(...outcomeClauses(input));

  if (!clauses.length) return null;
  return { sentence: clauses.map((c) => c.text).join(' '), clauses };
}
