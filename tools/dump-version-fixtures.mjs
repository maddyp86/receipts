#!/usr/bin/env node
// ===========================================================================
// dump-version-fixtures — replace the synthetic text-version fixtures with
// live rows from the mirror.
//
//   node tools/dump-version-fixtures.mjs            # write the fixture file
//   node tools/dump-version-fixtures.mjs --check    # print what would change
//
// The Task 3 tests read packages/server/src/evaluation/fixtures/
// gutAndAmendVersions.json and assert BEHAVIOUR — which version is in effect
// on which date, that introduced and late text differ — never prose. So once
// the regenerated versions corpus is trusted, running this and then the suite
// is the whole swap. If a test fails afterwards, the live data disagrees with
// the selection rules, and that is a finding, not a fixture to edit.
//
// READS PRODUCTION. DATABASE_URL in the repo-root .env points at the live
// Supabase project; this only ever SELECTs.
// ===========================================================================

import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const FIXTURE = fileURLToPath(
  new URL('../packages/server/src/evaluation/fixtures/gutAndAmendVersions.json', import.meta.url),
);

// The six confirmed gut-and-amend bills: the introduced and enrolled texts are
// different legislation under the same number.
const BILLS = ['s1071-119', 'hr5334-119', 'hr6500-119', 'hr2872-118', 'hr815-118', 's870-118'];

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set — nothing to read.');
  process.exit(2);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const { rows } = await client.query(
  `select impact_version_uid, bill_id, text_version_code, text_version_date, row
     from mirror.mirror_impact_statement_versions
    where bill_id = any($1::text[])
    order by bill_id, coalesce(nullif(text_version_date, ''), '9999-12-31'), text_version_code`,
  [BILLS],
);
await client.end();

// A bill with no rows is reported, not silently dropped: the test for it would
// then pass vacuously.
const missing = BILLS.filter((b) => !rows.some((r) => r.bill_id === b));
const bad = rows.filter((r) => String(r.row?.['Version Title Source'] ?? '').toUpperCase() !== 'TEXT'
  && !['eas', 'eah'].includes(String(r.text_version_code)));
const counts = Object.fromEntries(BILLS.map((b) => [b, rows.filter((r) => r.bill_id === b).length]));

console.log(`${rows.length} rows: ${JSON.stringify(counts)}`);
if (missing.length) console.warn(`NO ROWS for ${missing.join(', ')} — their tests will not run against live data.`);
if (bad.length) {
  console.warn(
    `${bad.length} row(s) whose title was not read from the version text (Version Title Source != TEXT ` +
      `outside eas/eah): ${bad.map((r) => `${r.bill_id}/${r.text_version_code}`).join(', ')}. ` +
      'Has the regeneration finished?',
  );
}

const body = {
  _provenance:
    `LIVE. Dumped ${new Date().toISOString()} from mirror.mirror_impact_statement_versions by ` +
    'tools/dump-version-fixtures.mjs. Rows are verbatim.',
  rows,
};

if (process.argv.includes('--check')) {
  const before = JSON.parse(await readFile(FIXTURE, 'utf8'));
  console.log(`fixture currently: ${before.rows.length} rows (${String(before._provenance).slice(0, 40)}…)`);
  process.exit(0);
}

await writeFile(FIXTURE, JSON.stringify(body, null, 2) + '\n');
console.log(`wrote ${FIXTURE}`);
