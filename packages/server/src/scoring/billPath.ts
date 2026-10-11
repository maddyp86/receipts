import { ordinal, type PathStep, type TextVersionDisclosure } from '@receipts/shared';
import type { BillEnrichment, SponsorshipEnrichment } from '../evaluation/enrichment.js';

// ===========================================================================
// THE BILL'S PATH — the steps a card draws left to right.
//
//   Introduced → Passed the House (Jul 23) → Sent to the Senate → Final vote
//   (Sep 24) · Thune: No → Failed in a floor vote
//
// The same record the record sentence is built from (recordSentence.ts), laid
// out as steps instead of prose. Built in code, never by a model, and every
// step comes from a named field:
//
//   introduced      the introduced version's date, or the sponsorship's
//                   `cosponsored_at` less `days_after_introduction`; undated
//                   otherwise (a bill was always introduced)
//   versions        the version in effect at the senator's act and the bill's
//                   latest version (text_version), each named by what its
//                   congress.gov code says happened
//   the senator     their cloture and passage votes with their dates, or
//                   their sponsorship with its date
//   the outcome     Progress Outcome / Stage (Bills Master)
//
// Nothing is inferred between them: a step the record does not hold is left
// out, and an undated step says so. PRESENTATION ONLY — nothing here reaches
// a verdict, a band or a weight.
// ===========================================================================

const S = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const flag = (v: unknown): boolean =>
  typeof v === 'boolean' ? v : ['TRUE', 'YES', 'Y', '1'].includes(S(v).toUpperCase());

/** YYYY-MM-DD from either spelling the record uses (ISO, or the sheet's M/D/YYYY). */
export function isoDate(value: unknown): string | null {
  const t = S(value);
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  return us ? `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}` : null;
}

const minusDays = (iso: string, days: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

/** What a text version's code says happened to the bill. Codes not here are not steps. */
const VERSION_STEP: Record<string, string> = {
  ih: 'Introduced', is: 'Introduced',
  rh: 'Reported by committee', rs: 'Reported by committee',
  pch: 'Placed on the calendar', pcs: 'Placed on the calendar',
  eh: 'Passed the House', es: 'Passed the Senate',
  rfs: 'Sent to the Senate', rfh: 'Sent to the House',
  eah: 'Amended by the House', eas: 'Amended by the Senate',
  enr: 'Passed both chambers',
};

const vote = (v: unknown): string | null => {
  const up = S(v).toUpperCase();
  return up === 'YEA' ? 'Yes' : up === 'NAY' ? 'No' : up === 'NOT_VOTING' || up === 'NOT VOTING' ? 'Did not vote' : null;
};

const STAGE_NOW: Record<string, string> = {
  INTRODUCED: 'No action since introduction',
  REFERRED: 'Still in committee',
  IN_COMMITTEE: 'Still in committee',
  ON_CALENDAR: 'On the calendar',
  FLOOR: 'On the floor',
  PASSED_CHAMBER: 'Passed one chamber',
  PASSED_BOTH: 'Passed both chambers',
  TO_PRESIDENT: 'Sent to the President',
};

const DIED_AT: Record<string, string> = {
  INTRODUCED: 'Ended in committee',
  REFERRED: 'Ended in committee',
  IN_COMMITTEE: 'Never reached the floor',
  ON_CALENDAR: 'Never got a floor vote',
  FLOOR: 'Reached the floor, did not pass',
  PASSED_CHAMBER: 'Passed one chamber only',
};

function outcomeStep(bill: BillEnrichment | null | undefined, billId: string, rewritten: boolean): PathStep | null {
  if (!bill) return null;
  const outcome = S(bill.progress_outcome).toUpperCase();
  const stage = S(bill.progress_stage).toUpperCase();
  const at = isoDate(bill.progress_stage_at);
  const congress = /-(\d+)$/.exec(billId)?.[1];
  let step: PathStep | null = null;
  if (outcome === 'ENACTED') step = { label: 'Became law', date: at };
  else if (outcome === 'VETOED') step = { label: 'Vetoed', date: at };
  else if (outcome === 'FAILED') step = { label: 'Failed in a floor vote', date: null };
  else if (outcome === 'PROV_KILL') step = { label: 'A procedural vote failed', date: null, note: 'which does not end the bill' };
  else if (outcome === 'AGREED_TO') step = { label: 'Agreed to', date: at };
  else if (outcome.startsWith('DIED_AT_')) {
    const where = outcome.slice('DIED_AT_'.length);
    step = { label: DIED_AT[where] ?? 'Did not become law', date: null, note: congress ? `when the ${ordinal(Number(congress))} Congress ended` : null };
  } else if (outcome === 'ACTIVE' && STAGE_NOW[stage]) step = { label: STAGE_NOW[stage]!, date: null };
  if (!step) return null;
  // The outcome belongs to the bill NUMBER: when the text was later replaced,
  // it is the rewritten bill's outcome (see recordSentence.ts).
  return { ...step, outcome: true, ...(rewritten ? { note: 'as rewritten under the same number' } : {}) };
}

export interface PathInput {
  bill_id: string;
  is_sponsor?: boolean | string | null;
  is_cosponsor?: boolean | string | null;
  cloture_vote?: string | null;
  cloture_vote_date?: string | null;
  passage_vote?: string | null;
  passage_vote_date?: string | null;
  sponsorship?: SponsorshipEnrichment | null;
  bill?: BillEnrichment | null;
  text_version?: TextVersionDisclosure | null;
}

/** The bill's path, or null when the record holds nothing beyond the bill itself. */
export function billPath(input: PathInput): PathStep[] | null {
  const tv = input.text_version ?? null;
  const steps: PathStep[] = [];

  // The versions: the one in effect at the senator's act (the text we read,
  // when it was read), and the latest.
  const versions: Array<{ code: string; date: string | null; read: boolean }> = [];
  if (tv?.code) versions.push({ code: tv.code.toLowerCase(), date: isoDate(tv.date), read: tv.status === 'SELECTED' });
  if (tv?.latest?.code) versions.push({ code: tv.latest.code.toLowerCase(), date: isoDate(tv.latest.date), read: false });

  // Introduced: from its own version when we have it, else from the
  // sponsorship's join date and days after introduction.
  const introducedVersion = versions.find((v) => VERSION_STEP[v.code] === 'Introduced');
  const s = input.sponsorship ?? {};
  const joined = isoDate(s.cosponsored_at);
  const days = typeof s.days_after_introduction === 'number' ? s.days_after_introduction : null;
  const introducedOn = introducedVersion?.date ?? (joined && days !== null ? minusDays(joined, days) : null);
  steps.push({ label: 'Introduced', date: introducedOn, ...(introducedVersion?.read ? { note: 'the text we read' } : {}) });

  for (const v of versions) {
    const label = VERSION_STEP[v.code];
    if (!label || label === 'Introduced') continue;
    if (steps.some((st) => st.label === label && st.date === v.date)) continue;
    steps.push({ label, date: v.date, ...(v.read ? { note: 'the text we read' } : {}) });
  }

  // The senator's own act.
  if (flag(input.is_sponsor)) steps.push({ label: 'Sponsored', date: joined, senator: { act: 'Sponsored' } });
  else if (flag(input.is_cosponsor)) steps.push({ label: 'Co-sponsored', date: joined, senator: { act: 'Co-sponsored' } });
  const cloture = vote(input.cloture_vote);
  if (cloture) steps.push({ label: 'Vote to end debate', date: isoDate(input.cloture_vote_date), senator: { act: cloture } });
  const passage = vote(input.passage_vote);
  if (passage) steps.push({ label: 'Final vote', date: isoDate(input.passage_vote_date), senator: { act: passage } });

  // Introduced first; then every dated step in order; undated steps keep their
  // place after the dated ones; the outcome last.
  const [first, ...rest] = steps;
  const dated = rest.filter((st) => st.date).sort((a, b) => a.date!.localeCompare(b.date!));
  const undated = rest.filter((st) => !st.date);
  const path = [first!, ...dated, ...undated];
  const end = outcomeStep(input.bill, input.bill_id, Boolean(tv?.rewritten));
  if (end) path.push(end);

  // "Introduced" alone, undated, says nothing the card does not already.
  return path.length > 1 ? path : null;
}
