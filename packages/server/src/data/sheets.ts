// ===========================================================================
// Sheet coordinates for the read layer.
//
// Confirmed against the live workflows. Kept in one module so the eventual read
// replica swaps a single import rather than hunting IDs through call sites.
//
// ⚠ Sheets is a poor query backend. WF10A does ~10 reads to assemble one row,
// and doing that per query — with concurrent users — contends with pipeline
// drains on the same ~300 requests/minute project quota. The mitigation is
// structural rather than a retry policy: enrich AFTER the evidence gate, so
// only the 2–4 admitted candidates are read instead of all 10. Target a read
// replica (Postgres or a nightly cache) before this sees real traffic.
// ===========================================================================

export interface SheetRef {
  /** Spreadsheet document id. */
  doc: string;
  /** Tab gid. */
  gid: string;
  /** Tab name as it appears in the document. */
  tab: string;
}

// ⚠ SCRUBBED. These held four real Google Sheets document IDs.
//
// A Sheets document id is an ACCESS IDENTIFIER, not a name: if a sheet is
// shared "anyone with the link", the id is the credential. Four of them sat in
// a committed file that nothing imports.
//
// They are env-driven now, with no defaults. An unset id yields an empty `doc`,
// and any caller must treat that as "not configured" rather than building a
// URL against ''. This module is currently unused — the Supabase mirror
// (docs/supabase-schema-proposal.md) supersedes it — so nothing breaks today.
const env = (name: string): string => (process.env[name] ?? '').trim();

const CORPUS = env('SHEETS_DOC_CORPUS');
const ALIGNMENT = env('SHEETS_DOC_ALIGNMENT');
const IMPACT = env('SHEETS_DOC_IMPACT');
const TAXONOMY = env('SHEETS_DOC_TAXONOMY');

/** True only when every document id is configured. */
export const SHEETS_CONFIGURED = Boolean(CORPUS && ALIGNMENT && IMPACT && TAXONOMY);

export const SHEETS = {
  billsMaster: { doc: CORPUS, gid: '1989014249', tab: 'Bills Master' },

  // ⚠ The tab name carries a LEADING SPACE. It is not a typo in this file —
  // it is the tab's actual name, and trimming it breaks the read.
  politicianBillActions: { doc: CORPUS, gid: '169026063', tab: ' Politician Bill Actions' },

  partyVotePositions: { doc: CORPUS, gid: '1690755127', tab: 'Party Vote Positions' },
  donors: { doc: CORPUS, gid: '932509385', tab: 'Donors' },

  impactStatements: { doc: IMPACT, gid: '0', tab: 'Impact Statements' },
  affectedStakeholders: { doc: IMPACT, gid: '1132856494', tab: 'Affected Stakeholders' },

  donorAlignments: { doc: ALIGNMENT, gid: '1200562556', tab: 'Donor Alignments' },

  // Read for omissions and surprise actions only. The query tool never reads
  // Promise Alignment - Matches or Decision Scores: it runs a fresh evaluation
  // and must not inherit corpus verdicts.
  promiseAlignmentNonMatches: {
    doc: ALIGNMENT,
    gid: '1285984904',
    tab: 'Promise Alignment - Non Matches',
  },

  approvedTaxonomy: { doc: TAXONOMY, gid: '1287072268', tab: 'Approved Taxonomy' },
} as const satisfies Record<string, SheetRef>;

/**
 * Tabs this tool must never write to. Enforced at the store seam rather than
 * left to reviewer discipline: a user query is a lookup, not evidence about a
 * senator, and it must not contribute to the trust index.
 */
export const WRITE_FORBIDDEN = Object.values(SHEETS).map((s) => s.tab);
