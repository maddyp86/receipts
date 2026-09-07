#!/usr/bin/env node
/**
 * Generates prompt modules from the fix-bundle markdown in docs/fix/.
 *
 * WHY THIS EXISTS ALONGSIDE THE OTHER TWO EXTRACTORS. `extract-relevance-prompt`
 * and `extract-fulfillment-prompt` read a live n8n workflow dump, because for
 * those two prompts the node IS the source of truth. The prompts this script
 * generates arrive as markdown in the fix bundle instead — handoff v2 §10 names
 * the `fix/` files as canonical for the query tool, with the live workflow
 * canonical for the pipeline. Same contract, different upstream.
 *
 * Same enforce-don't-remember guarantee either way: each prompt's length is
 * asserted here, so a hand-edit to the generated .ts or an unnoticed edit to the
 * source markdown fails generation rather than silently changing how statements
 * are classified or verdicts judged. If a prompt legitimately changes, update
 * its `length` in the same commit as the regenerated file, so the change is
 * visible in review.
 *
 * Extraction rule: take the first fenced code block that follows the named
 * heading. That is the shape every fix-bundle prompt doc uses.
 *
 * Usage:
 *   node tools/extract-fix-prompt.mjs          # regenerate all
 *   node tools/extract-fix-prompt.mjs scope    # regenerate one, by key
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const die = (m) => {
  console.error(`extract-fix-prompt: ${m}`);
  process.exit(1);
};

/**
 * One entry per generated prompt module.
 *
 * `length` is the assertion. `heading` selects which fenced block to take —
 * these docs contain several (user templates, post-check code, output schemas),
 * and grabbing the wrong one would produce a plausible file that is not the
 * prompt.
 */
const TARGETS = {
  scope: {
    source: 'docs/fix/01_statement_scope_classifier.v1_1.md',
    heading: '## System prompt',
    out: 'packages/server/src/scope/scopeClassifierPrompt.ts',
    constant: 'SCOPE_CLASSIFIER_SYSTEM_PROMPT',
    version: 'scope-classifier-v1.1',
    // v1 was 5080; the handoff v2 §1 paragraph adds 448.
    length: 5528,
    banner: [
      'The STATEMENT SCOPE CLASSIFIER prompt. It decides what KIND of thing was',
      'said and WHETHER a legislative action can be tested against it at all —',
      'speech_act, scope, valid_until, anchor_entity, role_condition.',
      '',
      'It is not a relevance or fulfilment prompt and answers no question about',
      'any bill. It runs BEFORE retrieval, and can stop a query outright.',
    ],
  },
  evaluator: {
    source: 'docs/fix/07_wf10a_evaluator_prompt_v7.md',
    heading: '## SYSTEM',
    out: 'packages/server/src/evaluation/evaluatorPromptV7.ts',
    constant: 'EVALUATOR_SYSTEM_PROMPT',
    version: 'promise-alignment-v7',
    length: 9343,
    banner: [
      'The FULFILMENT (bill_effect) prompt, v7. It decides',
      'ADVANCE / HINDER / NEUTRAL / CONTESTED and a same_object gate.',
      '',
      'v7 SUPERSEDES the 32,507-char v6 that was extracted from the live WF10A',
      'node. v6 is gone, not deprecated: it carried the rules the audit blamed',
      'for the false-positive class — a 0.6 confidence floor, "NEVER return',
      'NEUTRAL because the connection requires inference", and an asymmetric',
      'cloture/passage precedence. Keeping it importable would let a stray',
      'import reinstate them.',
      '',
      'This is NOT the relevance prompt (relevancePrompt.ts), which asks whether',
      'a bill is about the statement at all. Different question, different call.',
    ],
  },
};

const generate = (key) => {
  const t = TARGETS[key];
  if (!t) die(`unknown target "${key}" — known: ${Object.keys(TARGETS).join(', ')}`);

  const srcPath = resolve(t.source);
  let md;
  try {
    md = readFileSync(srcPath, 'utf8');
  } catch {
    die(`cannot read ${t.source}`);
  }

  const at = md.indexOf(t.heading);
  if (at === -1) die(`heading "${t.heading}" not found in ${t.source}`);

  // First fenced block after the heading. Tolerates an info string (```text).
  const after = md.slice(at + t.heading.length);
  const fence = after.match(/^```[^\n]*\n([\s\S]*?)\n```/m);
  if (!fence) die(`no fenced block after "${t.heading}" in ${t.source}`);

  const prompt = fence[1];

  if (prompt.length !== t.length) {
    die(
      `${key}: prompt is ${prompt.length} chars, expected ${t.length}.\n` +
        `If ${t.source} changed deliberately, update TARGETS.${key}.length in the ` +
        'same commit as the regenerated file.',
    );
  }

  const banner =
    '// ===========================================================================\n' +
    '// GENERATED — do not edit. Regenerate with:\n' +
    `//   node tools/extract-fix-prompt.mjs ${key}\n` +
    '//\n' +
    `// EXTRACTED from ${t.source}, not transcribed.\n` +
    `// Length is asserted at ${t.length} characters by the generator, so a hand-edit\n` +
    '// or an unnoticed change to the source fails generation instead of silently\n' +
    '// changing behaviour.\n' +
    '//\n' +
    t.banner.map((l) => (l ? `// ${l}` : '//')).join('\n') +
    '\n// ===========================================================================\n\n';

  const body =
    banner +
    '/** Asserted by the generator. A mismatch fails the build, never the request. */\n' +
    `export const ${t.constant}_LENGTH = ${t.length};\n\n` +
    '/** Stored on every classification for provenance. */\n' +
    `export const ${t.constant}_VERSION = ${JSON.stringify(t.version)};\n\n` +
    `export const ${t.constant} = ${JSON.stringify(prompt)};\n`;

  const outPath = resolve(t.out);
  writeFileSync(outPath, body, 'utf8');

  // Verify what landed on disk round-trips, so a serialisation fault cannot pass.
  const back = readFileSync(outPath, 'utf8');
  const m = back.match(new RegExp(`export const ${t.constant} = (".*");\\n$`, 's'));
  if (!m || JSON.parse(m[1]) !== prompt) {
    die(`${key}: post-write verification failed — the file does not round-trip.`);
  }

  console.log(`wrote ${t.out}`);
  console.log(`  ${prompt.length} chars (assertion passed), version ${t.version}`);
};

const only = process.argv[2];
if (only) generate(only);
else for (const key of Object.keys(TARGETS)) generate(key);
