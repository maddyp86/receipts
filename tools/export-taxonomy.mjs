#!/usr/bin/env node
// ===========================================================================
// EXPORT THE APPROVED TAXONOMY  ->  packages/server/src/embeddings/taxonomy.json
//
//   node tools/export-taxonomy.mjs <path-to-approved-taxonomy.csv>
//
// ─── taxonomy.json IS GENERATED, NEVER EDITED ──────────────────────────────
// Any change to the Approved Taxonomy sheet is applied by re-running this
// tool. Do not hand-edit the JSON. A hand-edit is invisible in review and
// silently moves every query vector that touches the edited row.
//
// WHY VERBATIM MATTERS. WF7a and Promise Embeddings read the `Taxonomy
// Keywords` CELL as an opaque string, keyed on (Primary Issue, Sub Issue), and
// drop it into the embedded text unchanged as the `Related Terms:` line. They
// never parse or re-join it. So this exporter must not split, trim, normalise
// whitespace, or re-join that cell: substituting our separator for the sheet's
// changes the embedded document and moves the query vector, with no error and
// no visible diff in behaviour — only worse matches.
//
// Four cells in the approved sheet legitimately contain EMBEDDED NEWLINES
// (Human Trafficking & Exploitation, Medical Liability / Tort Reform, Health
// Workforce & Provider Capacity, Tenant Rights & Evictions). They are preserved
// exactly. That is why this file carries a real RFC4180 parser instead of
// splitting on '\n' and ','.
//
// The history this guards against: taxonomy.json previously held six rows whose
// (Primary Issue, Sub Issue) keys did not exist in the approved sheet at all,
// with composed rather than exported keyword cells, while its own provenance
// block claimed the cells were stored verbatim. See docs/RECONCILIATION.md,
// 2026-08-19.
// ===========================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';

/** The only runtime tab. Policy Terms / Subject Area are build-time scaffolding. */
const GID = '1287072268';
// Human-readable provenance only. The document ID is deliberately NOT recorded:
// a Sheets doc id is an access identifier — if the sheet is ever link-shared,
// the id IS the credential — and this string is written into a committed file.
const SHEET = "Google Sheets — 'Issue Taxonomy' doc, tab 'Approved Taxonomy'";

const OUT = resolve('packages/server/src/embeddings/taxonomy.json');

const die = (msg) => {
  console.error(`\nexport-taxonomy: ${msg}\n`);
  process.exit(1);
};

// ---- RFC4180 parser ------------------------------------------------------
// Handles quoted fields, embedded newlines, doubled quotes ("" -> "), and both
// LF and CRLF line endings. Returns rows of raw string cells, untouched.
function parseCsv(text) {
  // Strip a UTF-8 BOM if the sheet export carries one; it would otherwise end
  // up glued to the first header name and break the header match.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;

  while (i < text.length) {
    const c = text[i];

    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }

    if (c === '"') { quoted = true; i += 1; continue; }
    if (c === ',') { row.push(field); field = ''; i += 1; continue; }
    if (c === '\r' && text[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 2; continue; }
    if (c === '\n' || c === '\r') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }

    field += c; i += 1;
  }

  if (quoted) die('CSV ends inside an unclosed quoted field — the export is truncated.');
  // Flush the final record unless the file ended on a clean newline.
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---- read ----------------------------------------------------------------
const csvPath = process.argv[2];
if (!csvPath) {
  die('usage: node tools/export-taxonomy.mjs <path-to-approved-taxonomy.csv>');
}

let raw;
try {
  raw = readFileSync(resolve(csvPath), 'utf8');
} catch (err) {
  die(`could not read ${csvPath}: ${err.message}`);
}

const records = parseCsv(raw).filter(
  // Drop only structurally empty records (a trailing newline, a blank line).
  // A record with a real Primary Issue and blank keywords is NOT empty.
  (r) => r.some((c) => c.trim() !== ''),
);

if (!records.length) die('CSV contained no records.');

// ---- headers: read the real ones, never assume position ------------------
const header = records[0].map((h) => h.trim());
const col = (name) => {
  const i = header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  if (i === -1) die(`missing required column "${name}". Found: ${header.join(' | ')}`);
  return i;
};
const iPrimary = col('Primary Issue');
const iSub = col('Sub Issue');
const iKeywords = col('Taxonomy Keywords');

// ---- rows ----------------------------------------------------------------
const rows = [];
const seen = new Map();

records.slice(1).forEach((rec, n) => {
  const line = n + 2; // 1-indexed, +1 for the header row
  const primary = (rec[iPrimary] ?? '').trim();
  const sub = (rec[iSub] ?? '').trim();

  // FAIL, never skip. A silently dropped row is a taxonomy miss at runtime,
  // which degrades retrieval with no signal that a row went missing.
  if (!primary) die(`blank Primary Issue at CSV line ${line}.`);
  if (!sub) die(`blank Sub Issue at CSV line ${line} (Primary Issue: "${primary}").`);

  // VERBATIM. No trim, no split, no re-join — see the header note.
  // A blank keywords cell is legitimate (e.g. "Other / Needs Context") and is
  // preserved as the empty string rather than being treated as an error.
  const keywords = rec[iKeywords] ?? '';

  const key = `${primary.toLowerCase()} / ${sub.toLowerCase()}`;
  if (seen.has(key)) {
    die(
      `duplicate (Primary Issue, Sub Issue) at CSV line ${line}: "${primary} / ${sub}" ` +
        `already seen at line ${seen.get(key)}. The lookup is keyed on this pair, ` +
        `so a duplicate silently shadows one of the two cells.`,
    );
  }
  seen.set(key, line);

  rows.push({ primary_issue: primary, sub_issue: sub, taxonomy_keywords: keywords });
});

// ---- assertions ----------------------------------------------------------
const rowCount = rows.length;
if (rows.length !== rowCount) die(`row count assertion failed: ${rows.length} !== ${rowCount}.`);
if (!rowCount) die('parsed zero data rows — refusing to write an empty taxonomy.');

const stamp = new Date().toISOString().slice(0, 10);

const payload = {
  _provenance: {
    status: `COMPLETE:${stamp}`,
    gid: GID,
    row_count: rowCount,
    source: SHEET,
    // Basename only. The full path leaked the operator's home directory layout
    // into a committed file; the filename is all the provenance that is useful.
    source_file: basename(csvPath),
    generated_by: 'tools/export-taxonomy.mjs',
    generated_never_edited:
      'Do NOT hand-edit this file. Apply any sheet change by re-running the exporter. ' +
      'Keyword cells are stored VERBATIM — splitting and re-joining would substitute ' +
      'our separator for the sheet\'s and move every query vector built from that row.',
  },
  rows,
};

writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

// Re-read and verify what actually landed on disk, so a serialisation problem
// cannot pass as success.
const back = JSON.parse(readFileSync(OUT, 'utf8'));
if (back.rows.length !== back._provenance.row_count) {
  die(`post-write assertion failed: ${back.rows.length} rows vs row_count ${back._provenance.row_count}.`);
}

const primaries = new Set(rows.map((r) => r.primary_issue)).size;
const multiline = rows.filter((r) => r.taxonomy_keywords.includes('\n')).length;
const blankCells = rows.filter((r) => r.taxonomy_keywords === '').length;

console.log(`wrote ${OUT}`);
console.log(`  status      COMPLETE:${stamp}  (gid ${GID})`);
console.log(`  rows        ${rowCount}  (row_count assertion passed)`);
console.log(`  primaries   ${primaries}`);
console.log(`  multi-line keyword cells preserved: ${multiline}`);
console.log(`  blank keyword cells (legitimate):   ${blankCells}`);
