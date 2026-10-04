import type { TextVersionDisclosure, TextVersionGoverningAct } from '@receipts/shared';
import { truthy, voteOf } from '../scoring/deriveAlignment.js';
import type { FulfillmentCandidate } from './fulfillment.js';

// ===========================================================================
// WHICH TEXT THE SENATOR ACTED ON.
//
// Congress rewrites bills under the same number. Two confirmed cases:
//   s1071-119   introduced as a VA bill to disinter one veteran's remains;
//               enrolled as the FY2026 NDAA.
//   hr5334-119  introduced as an educator tax deduction; enrolled as a Russia
//               sanctions act.
// The evaluator used to see one summary per bill — the latest — so a senator
// who cosponsored the introduced hr5334 was judged against sanctions text
// written eleven months later that he never signed. This module picks the text
// that existed when the action happened.
//
// ── CONSUMES THE PIPELINE'S OUTPUT, DOES NOT RE-DERIVE IT ─────────────────
// Every field here is a column WF5 wrote to `Impact Statements - Versions`.
// Nothing re-hashes text, re-reads congress.gov or re-classifies an issue. The
// one thing computed here is taxonomy divergence, by comparing the STORED issue
// pairs across a bill's rows — WF5's own flag compares rows within one run only
// and misses a bill whose versions were generated in different runs.
//
// ── THE RULES ─────────────────────────────────────────────────────────────
//   1. The act that governs the verdict dates the selection, in the same order
//      `deriveAlignment` decides it: cloture, then passage, then an untyped
//      vote, and only with no vote at all the sponsorship (`Cosponsored At`).
//      One notion of which act counted, not two.
//   2. The version IN EFFECT is the latest one dated on or before that date.
//   3. An undated version (`enr` — congress.gov does not date enrolled bills)
//      is NEVER selected. Enrollment follows the last floor vote, so it is
//      never the text a senator voted on or signed. It sorts last and is
//      carried only to disclose what the bill became.
//   4. If the version in effect is unusable — `Version Mismatch`, `Flagged For
//      Review`, or an empty summary — nothing is substituted and the disclosure
//      says so. Falling back to an EARLIER version would judge the senator
//      against text that was no longer in effect, and present it as the right
//      one. The scorer then refuses to present the verdict as confident.
//
//      A FLAGGED row is unusable, not merely dispreferred. Measured 2026-10-02:
//      16 of the 21 flagged rows are versions whose text congress.gov never
//      published as HTML, and WF5 wrote them with a NON-EMPTY summary that
//      reads "The bill summary text was unavailable, so …". Nothing but the
//      flag separates those from a real summary, so the flag has to decide —
//      at the cost of blocking 5 flagged rows whose summaries are sound.
//   5. No version rows for the bill → null, and the caller behaves exactly as
//      it did before this module existed.
// ===========================================================================

const S = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

/** One row of `mirror.mirror_impact_statement_versions`, as stored. */
export interface VersionMirrorRow {
  impact_version_uid: string;
  bill_id: string | null;
  text_version_code: string | null;
  text_version_date: string | null;
  row: Record<string, unknown>;
}

/** A version row read into the fields the query tool uses. */
export interface TextVersion {
  uid: string;
  bill_id: string;
  code: string;
  type: string | null;
  /** YYYY-MM-DD, or null for an undated (enrolled) version. */
  date: string | null;
  title: string | null;
  /** TEXT (read from the bill) · MODEL · CANONICAL (the bill's current title). */
  title_source: string | null;
  summary: string;
  intended_effects: string;
  mechanisms: string;
  primary_issue: string | null;
  sub_issue: string | null;
  stakeholders: Array<{
    stakeholder_group?: string;
    positive_impacts?: string;
    negative_impacts?: string;
  }>;
  reverses_existing_policy: string | null;
  target_type: string | null;
  target_name: string | null;
  target_source: string | null;
  target_effect: string | null;
  version_mismatch: boolean;
  flagged_for_review: boolean;
  /** WF5's per-run flag. A fallback only — see `taxonomyDivergence`. */
  stored_taxonomy_divergent: boolean;
  stored_divergence_detail: string | null;
}

/** The act that governs the verdict, and the date that places it in time. */
export interface GoverningAct {
  kind: TextVersionGoverningAct;
  /** YYYY-MM-DD, or null when the record has no date for that act. */
  date: string | null;
}

export interface TextVersionSelection {
  disclosure: TextVersionDisclosure;
  /** The version substituted into the evaluator input. Null unless SELECTED. */
  version: TextVersion | null;
  /**
   * The version in effect, usable or not. Set for SELECTED and
   * TEXT_UNAVAILABLE. The gates read its title even when its summary cannot be
   * used — whether a bill is an appropriations vehicle is a fact about the text
   * in effect, and a version without a usable summary can still have a heading
   * read from it.
   */
  inEffect: TextVersion | null;
}

/** What `governingActOf` needs: the votes, their dates, and the sponsorship. */
export interface GoverningActInput {
  vote?: string | null;
  cloture_vote?: string | null;
  passage_vote?: string | null;
  cloture_vote_date?: string | null;
  passage_vote_date?: string | null;
  is_sponsor?: boolean | string | null;
  is_cosponsor?: boolean | string | null;
  cosponsored_at?: string | null;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * Any date the mirror holds, as YYYY-MM-DD. Null when absent or unreadable.
 *
 * LOAD-BEARING. Version dates are ISO; the sheet's vote dates are mostly
 * M/D/YYYY ('1/15/2026'). Compared as strings, '1/15/2026' sorts before
 * '2025-12-10' and every vote would select the wrong version — silently,
 * because both look like dates. M/D/YYYY is parsed by hand rather than through
 * `new Date`, which reads it as LOCAL midnight and can shift it a day in UTC.
 */
export function isoDate(v: unknown): string | null {
  const t = S(v);
  if (!t || t === 'NA' || t === 'N/A' || t === 'UNKNOWN') return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (us) return `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}`;
  return null;
}

/** Undated sorts LAST — it is the final text, never the earliest. */
const sortKey = (v: TextVersion): string => `${v.date ?? '9999-12-31'}|${v.code}`;

// ---------------------------------------------------------------------------
// Reading a row
// ---------------------------------------------------------------------------

/** Case-insensitive read from the verbatim sheet row. 'NA' and blank are absence. */
function pick(row: Record<string, unknown>, name: string): string | null {
  const target = name.toLowerCase();
  for (const k of Object.keys(row)) {
    if (k.trim().toLowerCase() === target) {
      const v = S(row[k]);
      return !v || v === 'NA' || v === 'N/A' ? null : v;
    }
  }
  return null;
}

/** Only a literal TRUE counts. Blank and unknown are not TRUE. */
const isTrue = (v: string | null): boolean => S(v).toUpperCase() === 'TRUE';

/**
 * WF5 writes stakeholders as JSON on this tab:
 * `[{impact_statement_uid, stakeholder_group, positive_impact, negative_impact}]`.
 * Unparseable JSON yields no stakeholders rather than borrowing another
 * version's — mixing versions is the defect this module exists to remove.
 */
function stakeholdersOf(raw: string | null): TextVersion['stakeholders'] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === 'object')
      .map((s) => ({
        stakeholder_group: S(s.stakeholder_group ?? s.group) || undefined,
        positive_impacts: S(s.positive_impact ?? s.positive_impacts) || undefined,
        negative_impacts: S(s.negative_impact ?? s.negative_impacts) || undefined,
      }));
  } catch {
    return [];
  }
}

export function parseVersionRow(r: VersionMirrorRow): TextVersion {
  const j = r.row ?? {};
  return {
    uid: S(r.impact_version_uid),
    bill_id: S(r.bill_id) || S(pick(j, 'Bill ID')),
    // The typed columns are a convenience; the row is the source.
    code: (S(r.text_version_code) || S(pick(j, 'Text Version Code'))).toLowerCase(),
    type: pick(j, 'Text Version Type'),
    date: isoDate(r.text_version_date) ?? isoDate(pick(j, 'Text Version Date')),
    title: pick(j, 'Title'),
    title_source: pick(j, 'Version Title Source'),
    summary: S(pick(j, 'Summary')),
    intended_effects: S(pick(j, 'Intended Effects')),
    mechanisms: S(pick(j, 'Mechanisms')),
    primary_issue: pick(j, 'Primary Issue'),
    sub_issue: pick(j, 'Sub Issue'),
    stakeholders: stakeholdersOf(pick(j, 'Affected Stakeholders JSON')),
    reverses_existing_policy: pick(j, 'Reverses Existing Policy'),
    target_type: pick(j, 'Target Type'),
    target_name: pick(j, 'Target Name'),
    target_source: pick(j, 'Target Source'),
    target_effect: pick(j, 'Target Effect'),
    version_mismatch: isTrue(pick(j, 'Version Mismatch')),
    flagged_for_review: isTrue(pick(j, 'Flagged For Review')),
    stored_taxonomy_divergent: isTrue(pick(j, 'Taxonomy Divergent')),
    stored_divergence_detail: pick(j, 'Taxonomy Divergence Detail'),
  };
}

/** A version whose text can stand in for the latest summary. See rule 4. */
const usable = (v: TextVersion): boolean =>
  !v.version_mismatch && !v.flagged_for_review && v.summary.length > 0;

// ---------------------------------------------------------------------------
// The governing act
// ---------------------------------------------------------------------------

/**
 * The act that decides the verdict, in `deriveAlignment`'s order.
 *
 * A cosponsor who later voted is judged on the vote, so the vote's date picks
 * the text. Only with no directional vote at all does the sponsorship govern,
 * and then its date is `Cosponsored At` — never `Action Date`, which is the
 * bill's introduction date on every cosponsorship row.
 *
 * A governing act with no recorded date returns `date: null`. The other act's
 * date is NOT borrowed: a substitute amendment is often adopted between
 * cloture and passage, so the passage date can sit on the far side of a text
 * change from the cloture vote that decided the verdict.
 */
export function governingActOf(input: GoverningActInput): GoverningAct | null {
  if (voteOf(input.cloture_vote)) return { kind: 'CLOTURE', date: isoDate(input.cloture_vote_date) };
  if (voteOf(input.passage_vote)) return { kind: 'PASSAGE', date: isoDate(input.passage_vote_date) };
  if (voteOf(input.vote)) {
    // An untyped vote has no date of its own. When exactly one typed date
    // exists it is that vote's; with both, which one this is is unknowable.
    const c = isoDate(input.cloture_vote_date);
    const p = isoDate(input.passage_vote_date);
    return { kind: 'VOTE', date: c && p ? null : (c ?? p) };
  }
  const flag = (v: boolean | string | null | undefined) => (typeof v === 'boolean' ? v : truthy(v));
  if (flag(input.is_sponsor) || flag(input.is_cosponsor)) {
    return { kind: 'SPONSORSHIP', date: isoDate(input.cosponsored_at) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Divergence
// ---------------------------------------------------------------------------

/**
 * Did versions of this bill get classified under different issue pairs?
 *
 * Computed from the STORED (Primary Issue, Sub Issue) on every row rather than
 * read from WF5's `Taxonomy Divergent`, which compares only rows generated in
 * the same run. Sometimes correct (s1071 genuinely changed subject), sometimes
 * model drift on near-identical text — so it is DISCLOSED, never acted on.
 *
 * Rows flagged `Version Mismatch` are left out: their classification may
 * describe a different version than the one they are labelled as.
 *
 * Falls back to the stored flag only when no row carries both issue fields.
 */
export function taxonomyDivergence(versions: TextVersion[]): {
  divergent: boolean;
  detail: string | null;
} {
  const classified = versions.filter((v) => !v.version_mismatch && v.primary_issue && v.sub_issue);
  if (!classified.length) {
    const stored = versions.find((v) => v.stored_taxonomy_divergent);
    return { divergent: Boolean(stored), detail: stored?.stored_divergence_detail ?? null };
  }
  const byPair = new Map<string, string[]>();
  for (const v of [...classified].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))) {
    const pair = `${v.primary_issue} / ${v.sub_issue}`;
    if (!byPair.has(pair)) byPair.set(pair, []);
    byPair.get(pair)!.push(v.code);
  }
  if (byPair.size < 2) return { divergent: false, detail: null };
  // Same shape as WF5's detail column, so the two read alike.
  const detail = [...byPair.entries()].map(([pair, codes]) => `${codes.join(',')} -> ${pair}`).join(' | ');
  return { divergent: true, detail };
}

/** A title as compared: lowercase, punctuation and spacing collapsed. */
const titleKey = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Do the titles READ FROM THE TEXT of these versions say different things?
 *
 * Only TEXT titles count. MODEL titles are mostly document headers and
 * CANONICAL is the bill's current title on every row, so neither can show a
 * change. With fewer than two TEXT titles the answer is no — not "unknown
 * treated as yes".
 */
export function textTitlesDiffer(versions: TextVersion[]): boolean {
  const keys = new Set(
    versions.filter((v) => v.title_source === 'TEXT' && v.title).map((v) => titleKey(v.title!)),
  );
  return keys.size >= 2;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Pick the version in effect when the governing act happened.
 *
 * Returns null when the bill has NO version rows — the common case, and the
 * caller must then behave exactly as it did before versions existed. Any other
 * outcome returns a disclosure, so a bill that has versions always says which
 * text was evaluated, including when the answer is "the latest, because the
 * one in effect could not be used".
 */
export function selectTextVersion(
  rows: VersionMirrorRow[],
  act: GoverningAct | null,
): TextVersionSelection | null {
  if (!rows.length) return null;

  const versions = rows.map(parseVersionRow).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const latest = versions[versions.length - 1]!;
  // Disclosed only when the titles read from the text differ too: issue pairs
  // alone drift on identical text, and showing that would mislead.
  const pairs = taxonomyDivergence(versions);
  const divergence = pairs.divergent && textTitlesDiffer(versions) ? pairs : { divergent: false, detail: null };

  const disclose = (
    status: TextVersionDisclosure['status'],
    inEffect: TextVersion | null,
  ): TextVersionDisclosure => ({
    status,
    governed_by: act?.kind ?? null,
    action_date: act?.date ?? null,
    code: inEffect?.code ?? null,
    type: inEffect?.type ?? null,
    date: inEffect?.date ?? null,
    title: inEffect?.title ?? null,
    title_source: inEffect?.title_source ?? null,
    flagged_for_review: inEffect?.flagged_for_review ?? false,
    // "The bill later became …" — only when it is not the version evaluated.
    latest:
      inEffect && inEffect.uid === latest.uid
        ? null
        : {
            code: latest.code,
            type: latest.type,
            date: latest.date,
            title: latest.title,
            title_source: latest.title_source,
          },
    rewritten: Boolean(inEffect && inEffect.uid !== latest.uid && textTitlesDiffer([inEffect, latest])),
    taxonomy_divergent: divergence.divergent,
    taxonomy_divergence_detail: divergence.detail,
    version_count: versions.length,
  });

  // No real date for the act: placing it in the bill's history would be a
  // guess, and the Congress-start proxy would always guess "introduced".
  if (!act?.date) return { disclosure: disclose('NO_ACTION_DATE', null), version: null, inEffect: null };

  const onOrBefore = versions.filter((v) => v.date !== null && v.date <= act.date!);
  if (!onOrBefore.length) {
    // The act predates every version on file — typically because the earliest
    // version failed generation. The latest summary is used, and said so.
    return { disclosure: disclose('BEFORE_FIRST_VERSION', null), version: null, inEffect: null };
  }

  const inEffectDate = onOrBefore[onOrBefore.length - 1]!.date;
  // Two versions on the same day (rs and rh, say): a usable one beats an
  // unusable one, then code order so the choice is stable.
  const sameDay = onOrBefore
    .filter((v) => v.date === inEffectDate)
    .sort((a, b) => Number(usable(b)) - Number(usable(a)) || a.code.localeCompare(b.code));
  const inEffect = sameDay[0]!;

  if (!usable(inEffect)) {
    return { disclosure: disclose('TEXT_UNAVAILABLE', inEffect), version: null, inEffect };
  }
  return { disclosure: disclose('SELECTED', inEffect), version: inEffect, inEffect };
}

// ---------------------------------------------------------------------------
// Substitution
// ---------------------------------------------------------------------------

/**
 * The evaluator candidate with the selected version's impact statement in
 * place of the latest one.
 *
 * Returns the SAME OBJECT when nothing was selected, so a bill with no version
 * rows — or one whose version in effect was unusable — produces byte-identical
 * evaluator input to the code before this existed.
 *
 * Every field comes from the one version. None falls back to the Pinecone value
 * when the version's is blank: a candidate assembled from two versions of a
 * gut-and-amend bill is the defect, not a degradation of the fix.
 *
 * The title is replaced only when it was read from the version's own text
 * (`Version Title Source = TEXT`). MODEL titles were observed returning the
 * bill's current title for every version, and CANONICAL is the current title
 * by definition — either would print "FY2026 NDAA" over a summary of a VA
 * disinterment bill.
 */
export function applyTextVersion(
  c: FulfillmentCandidate,
  version: TextVersion | null,
): FulfillmentCandidate {
  if (!version) return c;
  return {
    ...c,
    bill_title: version.title_source === 'TEXT' && version.title ? version.title : c.bill_title,
    bill_summary: version.summary,
    bill_primary_issue: version.primary_issue ?? '',
    bill_sub_issue: version.sub_issue ?? '',
    bill_intended_effects: version.intended_effects,
    bill_mechanisms: version.mechanisms,
    affected_stakeholders: version.stakeholders.length ? version.stakeholders : undefined,
    reverses_existing_policy: version.reverses_existing_policy ?? undefined,
    target_name: version.target_name ?? undefined,
    target_source: version.target_source ?? undefined,
    target_effect: version.target_effect ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// The gates' view
// ---------------------------------------------------------------------------

/** What the pre-evaluator gates read about the bill's text. */
export interface GateText {
  bill_title: string;
  stakeholder_groups: string[];
}

/**
 * The title and stakeholders the pre-evaluator gates classify the bill by.
 *
 * G4 closes an action on a BROAD_VEHICLE — an appropriations or authorization
 * package — when the statement is specific, and the test is a pattern on the
 * title. Read off the latest title, a March 2025 cosponsorship of s1071-119 was
 * classed as a vote on the FY2026 NDAA: the headline case this whole track
 * exists to fix. So the gates read the version in effect too.
 *
 * The title is taken from the version in effect only when it was read from that
 * version's own text (TEXT) and the row is not a Version Mismatch. Engrossed
 * amendments carry amendment text and no heading, so their titles are MODEL —
 * junk like "H.R. 2872 Engrossed Amendment Senate (EAS)" — and those fall back
 * to the current title. That fallback is right in practice: an engrossed
 * amendment is where a gut-and-amend substitution lands, so the current title
 * is the one describing it.
 *
 * Stakeholders come from the version only when it was SELECTED; an unusable
 * row's impact analysis is no more trustworthy than its summary.
 */
export function gateTextOf(
  selection: TextVersionSelection | null | undefined,
  latest: GateText,
): GateText {
  // No versions, or an act that could not be placed: the gates see exactly
  // what they saw before versions existed — the same object.
  if (!selection?.inEffect) return latest;
  const v = selection.inEffect;
  const title = !v.version_mismatch && v.title_source === 'TEXT' && v.title ? v.title : latest.bill_title;
  const groups = selection.version
    ? selection.version.stakeholders.map((g) => S(g.stakeholder_group)).filter(Boolean)
    : latest.stakeholder_groups;
  return { bill_title: title, stakeholder_groups: groups };
}
