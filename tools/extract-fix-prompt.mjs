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
    // v8, Receipts only: the bill-effect reading without the senator's action.
    // WF10A still runs v7 (docs/fix/07_…_v7.md, kept as the record of it);
    // the departure is in docs/RECONCILIATION.md, 2026-10-10.
    source: 'docs/fix/08_evaluator_prompt_v8_bill_only.md',
    heading: '## SYSTEM',
    out: 'packages/server/src/evaluation/evaluatorPromptV8.ts',
    constant: 'EVALUATOR_SYSTEM_PROMPT',
    version: 'bill-effect-v8',
    length: 6150,
    banner: [
      'The FULFILMENT (bill_effect) prompt, v8. It decides',
      'ADVANCE / HINDER / NEUTRAL / CONTESTED and a same_object gate, and',
      'nothing else.',
      '',
      'v8 is v7 with the senator taken out. The model is never told who voted,',
      'how, or in what role: the action leaked into the bill reading (the same',
      'bill NEUTRAL for one senator and ADVANCE for the other; a leader\'s YEA',
      'read as a procedural switch). Everything about the action is decided in',
      'code: deriveAlignment, the pre-evaluator gates, the split-vote cap.',
      '',
      'This is NOT the relevance prompt (relevancePrompt.ts), which asks whether',
      'a bill is about the statement at all. Different question, different call.',
    ],
  },

  judge: {
    source: 'docs/fix/12_wf13_judge_system_prompt.md',
    extract: 'after-hr',
    heading: null,
    out: 'packages/server/src/judge/judgePrompt.ts',
    constant: 'JUDGE_SYSTEM_PROMPT',
    version: 'judge-v1',
    length: 6373,
    banner: [
      'The ADVERSARIAL JUDGE prompt. Seven tests, stop at the first FAIL.',
      '',
      'Runs on a DIFFERENT model family from the evaluator, deliberately: a',
      'second opinion from the same model is not a second opinion. Evaluator is',
      'gpt-5.4-mini, judge is claude-sonnet-5.',
      '',
      'It grades whether a verdict is DEFENSIBLE; it does not re-evaluate the',
      'statement. A PASS is invalid without a senator_counterargument, and the',
      'parser downgrades a counterargument-free PASS rather than trusting it.',
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

  let prompt;
  if (t.extract === 'after-hr') {
    // The prompt IS the document body, after the horizontal rule that closes
    // the front matter. fix/12 is written this way — its only fenced block is
    // the output schema, which belongs INSIDE the prompt rather than being it.
    const hr = md.indexOf('\n---\n');
    if (hr === -1) die(`no '---' separator in ${t.source}`);
    prompt = md.slice(hr + 5).trim();
  } else {
    const at = md.indexOf(t.heading);
    if (at === -1) die(`heading "${t.heading}" not found in ${t.source}`);

    // First fenced block after the heading. Tolerates an info string (```text).
    const after = md.slice(at + t.heading.length);
    const fence = after.match(/^```[^\n]*\n([\s\S]*?)\n```/m);
    if (!fence) die(`no fenced block after "${t.heading}" in ${t.source}`);
    prompt = fence[1];
  }

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
