#!/usr/bin/env node
// ===========================================================================
// EXPORT COMMITTEE NAMES  ->  packages/server/src/scoring/committees.json
//
//   node tools/export-committees.mjs                 # fetch and write
//   node tools/export-committees.mjs <file.json>     # from a saved copy
//
// ─── committees.json IS GENERATED, NEVER EDITED ────────────────────────────
// The record sentence names the committee a bill was referred to ("Referred
// to the Senate Committee on Commerce, Science, and Transportation, where the
// senator sits"). A wrong name there is a fabricated fact in a voter-facing
// sentence, so the names are exported from a source rather than typed.
//
// SOURCE: unitedstates/congress-legislators committees-current.json — the
// same dataset WF2c reads committee MEMBERSHIP from, and keyed by the same
// thomas_id codes the pipeline writes to `Referred Committees` and
// `Committee Member Of`. Every one of the 38 codes in the live Bills Master
// was present when this was first run (2026-10-03).
//
// LIMITATION, stated rather than hidden: the file is CURRENT names. A
// committee renamed between Congresses keeps its code, so a 118th-Congress
// bill is described with the committee's present name.
// ===========================================================================

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const URL_ = 'https://raw.githubusercontent.com/unitedstates/congress-legislators/gh-pages/committees-current.json';
const OUT = fileURLToPath(new URL('../packages/server/src/scoring/committees.json', import.meta.url));

const src = process.argv[2];
const raw = src ? await readFile(src, 'utf8') : await (await fetch(URL_)).text();
const list = JSON.parse(raw);
if (!Array.isArray(list) || !list.length) throw new Error('committees source is empty or not a list');

const committees = {};
for (const c of list) {
  if (!c.thomas_id || !c.name) continue;
  committees[c.thomas_id] = c.name;
}

await writeFile(
  OUT,
  JSON.stringify(
    {
      _provenance: {
        source: URL_,
        generated_by: 'tools/export-committees.mjs',
        generated_at: new Date().toISOString().slice(0, 10),
        note: 'GENERATED — re-run the exporter, never hand-edit. Current names, keyed by thomas_id.',
      },
      committees,
    },
    null,
    2,
  ) + '\n',
);
console.log(`wrote ${Object.keys(committees).length} committees to ${OUT}`);
