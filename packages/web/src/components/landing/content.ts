// ===========================================================================
// Landing page copy and sample data (Magic Patterns design, 2026-11).
//
// EVERY CLAIM HERE MUST BE TRUE OF THE PRODUCT. A landing page that overstates
// coverage or shows an invented answer is the fabricated finding Receipts
// exists to avoid. Changes from the design, and why:
//
// - Sample answers: only Thune / Laken Riley Act is kept, and only with facts
//   already checked in core.member_votes (eval case 35: Yea on roll calls 1, 5
//   and 7 of 2025, passed 64-35). The design's per-vote dates and motion
//   tallies could not be verified, so they are not shown. The design's Rand
//   Paul sample (not a covered senator) and Schumer "can't tell" (contradicts
//   eval case 42, which expects a real answer) are left out. Add a sample only
//   with a verified record behind it.
// - "Every current senator is covered" → not true; a few are, more are added.
// - "Updated daily" and "in about ten seconds" → not established; removed.
// ===========================================================================

export interface SampleRow {
  bill: string;
  billUrl: string;
  rollCall: string;
  vote: 'Yea' | 'Nay';
}

export interface SampleAnswer {
  id: string;
  /** "Sen. John Thune · R-SD" */
  who: string;
  question: string;
  tone: 'yes' | 'no' | 'unclear';
  label: string;
  summary: string;
  rows: SampleRow[];
  caveat?: string;
}

const S5 = 'https://www.congress.gov/bill/119th-congress/senate-bill/5';

export const SAMPLE_ANSWERS: readonly SampleAnswer[] = [
  {
    id: 'thune-laken-riley',
    who: 'Sen. John Thune · R-SD',
    question: 'Did Thune vote for the Laken Riley Act?',
    tone: 'yes',
    label: 'Voted for this',
    summary: 'Three recorded Senate votes on S.5 in January 2025, all Yea. The bill passed the Senate 64–35.',
    rows: [
      { bill: 'S.5', billUrl: S5, rollCall: 'Roll call 1, 2025', vote: 'Yea' },
      { bill: 'S.5', billUrl: S5, rollCall: 'Roll call 5, 2025', vote: 'Yea' },
      { bill: 'S.5', billUrl: S5, rollCall: 'Roll call 7, 2025', vote: 'Yea' },
    ],
  },
];

export const TRUST_POINTS = [
  {
    icon: 'scale',
    title: 'Real votes and bills, not opinions or ratings',
    body: 'Answers come from what senators actually voted on, sponsored and cosponsored. No scores, no spin.',
  },
  {
    icon: 'file',
    title: 'Every answer links back to the bill',
    body: 'Each answer lists the votes and bills behind it, so you can check our work.',
  },
  {
    icon: 'shield',
    title: 'Says “can’t tell” when the record doesn’t settle it',
    body: 'If the votes don’t clearly answer your question, we say so instead of guessing.',
  },
] as const;

export const HOW_STEPS = [
  {
    title: 'Pick a lawmaker',
    body: 'Search by name or state. The senators we’ve checked are ready now, more are being added, and you can request anyone.',
  },
  {
    title: 'Ask about a policy',
    body: 'Name the bill, program or promise. Specific questions get specific answers, not talking points.',
  },
  {
    title: 'Read the receipts',
    body: 'Get a plain-language answer with the exact votes and bills behind it, or an honest “can’t tell.”',
  },
] as const;

export const DATA_SOURCES = ['Senate roll-call votes', 'Congress.gov bill text and cosponsors', 'Senate record since January 2023'];

/** The beta line, said on the landing page in the design's words. */
export const BETA_LINE = 'Beta · Senate record since January 2023 · Answers can miss bills or be wrong.';
