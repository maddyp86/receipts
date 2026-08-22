import taxonomyData from './taxonomy.json' with { type: 'json' };

// ===========================================================================
// The approved issue taxonomy.
//
// Two jobs, both parity-critical:
//
//  1. It supplies the `Related Terms:` line in the embedded query text. Upstream
//     these keywords are a SHEET LOOKUP keyed on (Primary Issue, Sub Issue) —
//     not something a model generates. If Receipts let the model invent them,
//     the query vector would drift from every stored bill vector.
//
//  2. It constrains interpretation. The classifier is required to return an
//     exact Primary Issue and Sub Issue from this table, never a paraphrase.
//
// A miss returns no keywords and reports it. Never guess: an invented keyword
// silently degrades retrieval, and silent degradation is the failure mode this
// whole module exists to prevent.
// ===========================================================================

export interface TaxonomyRow {
  primary_issue: string;
  sub_issue: string;
  /**
   * The raw cell, exactly as it appears in the sheet.
   *
   * NOT an array. Upstream reads this cell as an opaque string and drops it
   * into the embedded text unchanged, so parsing and re-joining it here would
   * substitute our separator for the sheet's and shift the query vector.
   */
  taxonomy_keywords: string;
}

const rows: TaxonomyRow[] = taxonomyData.rows;

const key = (primary: string, sub: string) =>
  `${primary.trim().toLowerCase()} / ${sub.trim().toLowerCase()}`;

const byCombination = new Map<string, TaxonomyRow>(
  rows.map((r) => [key(r.primary_issue, r.sub_issue), r]),
);

/** True once the full sheet has been exported into taxonomy.json. */
export const TAXONOMY_IS_COMPLETE = taxonomyData._provenance.status.startsWith('COMPLETE');

export interface TaxonomyLookup {
  /** The verbatim cell string, or '' on a miss. Passed through, never re-joined. */
  keywords: string;
  /** False when the combination is not in the table — surfaced, never hidden. */
  found: boolean;
}

export function lookupTaxonomyKeywords(primaryIssue: string, subIssue: string): TaxonomyLookup {
  const row = byCombination.get(key(primaryIssue ?? '', subIssue ?? ''));
  return row ? { keywords: row.taxonomy_keywords, found: true } : { keywords: '', found: false };
}

export function isValidCombination(primaryIssue: string, subIssue: string): boolean {
  return byCombination.has(key(primaryIssue ?? '', subIssue ?? ''));
}

export function primaryIssues(): string[] {
  return [...new Set(rows.map((r) => r.primary_issue))];
}

export function subIssuesFor(primaryIssue: string): string[] {
  const p = primaryIssue.trim().toLowerCase();
  return rows.filter((r) => r.primary_issue.trim().toLowerCase() === p).map((r) => r.sub_issue);
}

/**
 * The taxonomy rendered for a prompt, in the same shape the live classifier
 * receives it: primary issues in bold, sub-issues as an indented list.
 */
export function formatTaxonomyForPrompt(): string {
  const grouped = new Map<string, string[]>();
  for (const r of rows) {
    const list = grouped.get(r.primary_issue) ?? [];
    if (!list.includes(r.sub_issue)) list.push(r.sub_issue);
    grouped.set(r.primary_issue, list);
  }
  return [...grouped.entries()]
    .map(([primary, subs]) => `**${primary}**\n${subs.map((s) => `  - ${s}`).join('\n')}`)
    .join('\n\n');
}
