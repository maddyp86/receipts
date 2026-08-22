#!/usr/bin/env node
/**
 * Generates packages/server/src/evaluation/fulfillmentPrompt.ts from the live
 * WF10A `Promise Alignment Evaluator` node, rather than transcribing it.
 *
 * Same enforce-don't-remember contract as tools/extract-relevance-prompt.mjs:
 * the system prompt is 32,507 characters and nobody will catch a hand-edit
 * drift in a string that long by reading it, so the length is asserted here
 * and generation fails if it moves. If it legitimately changed upstream,
 * update EXPECTED_LENGTH in the same commit as the regenerated file so the
 * change is visible in review rather than silent.
 *
 * THIS IS THE FULFILLMENT (bill_effect) PROMPT — the ~30k one the handoff
 * pairs with gpt-5.4-mini. It is a different prompt from the 13,740-char
 * relevance prompt in W7b, serves a different question (does this bill ADVANCE
 * or HINDER the stated goal, vs is this bill even about the promise), and the
 * two must not be conflated.
 *
 * Usage:
 *   node tools/extract-fulfillment-prompt.mjs <path-to-wf10a-workflow.json>
 *
 * The JSON is an n8n workflow dump (BuA0XMoRIeA8K-IziChwR). Fetch it read-only;
 * this script never writes to n8n.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const EXPECTED_SYSTEM_LENGTH = 32507;
const EXPECTED_USER_LENGTH = 3222;
const NODE_NAME = 'Promise Alignment Evaluator';
const OUT = resolve('packages/server/src/evaluation/fulfillmentPrompt.ts');

const die = (m) => { console.error(`extract-fulfillment-prompt: ${m}`); process.exit(1); };

const src = process.argv[2];
if (!src) die('usage: node tools/extract-fulfillment-prompt.mjs <wf10a-workflow.json>');

const wf = JSON.parse(readFileSync(resolve(src), 'utf8'));
const nodes = wf.workflow?.nodes ?? wf.nodes ?? [];
const node = nodes.find((n) => n.name === NODE_NAME);
if (!node) die(`Could not find a "${NODE_NAME}" node in ${src}.`);

const values = node.parameters?.responses?.values;
if (!Array.isArray(values) || values.length < 2) {
  die(`"${NODE_NAME}" has no responses.values pair — the node shape changed.`);
}

const system = values[0]?.content ?? '';
const user = values[1]?.content ?? '';

// The system message must be STATIC. An n8n expression (leading '=') or a
// mustache interpolation would mean the real prompt depends on runtime data,
// and a verbatim copy would silently diverge from what the node actually sends.
if (system.startsWith('=')) die('System message is an n8n expression — it is not static.');
if (/\{\{/.test(system)) die('System message contains {{ }} interpolation — it is not static.');

if (system.length !== EXPECTED_SYSTEM_LENGTH) {
  die(
    `System prompt is ${system.length} chars, expected ${EXPECTED_SYSTEM_LENGTH}.\n` +
      'If upstream changed deliberately, update EXPECTED_SYSTEM_LENGTH in the same commit.',
  );
}
if (user.length !== EXPECTED_USER_LENGTH) {
  die(
    `User template is ${user.length} chars, expected ${EXPECTED_USER_LENGTH}.\n` +
      'The user template IS an n8n expression and is ported by hand in ' +
      'fulfillment.ts — this assertion exists so a change upstream forces a ' +
      're-read of that port rather than passing unnoticed.',
  );
}

const modelId = node.parameters?.modelId?.value ?? '(unknown)';

const banner = `// ===========================================================================
// GENERATED — do not edit. Regenerate with:
//   node tools/extract-fulfillment-prompt.mjs <wf10a-workflow.json>
//
// EXTRACTED from WF10A \`${NODE_NAME}\` (BuA0XMoRIeA8K-IziChwR), not
// transcribed. Length is asserted at ${EXPECTED_SYSTEM_LENGTH} characters by the
// generator, so a hand-edit or an upstream drift fails generation instead of
// silently changing how every bill is judged.
//
// This is the FULFILLMENT prompt — it decides ADVANCE / HINDER / NEUTRAL. It is
// NOT the 13,740-char relevance prompt (W7b, relevancePrompt.ts), which decides
// whether a bill is about the promise at all. Different question, different
// node, different length. Do not conflate them.
//
// Live node model: ${modelId}
// ===========================================================================

`;

const body =
  `${banner}/** Asserted by the generator. A mismatch fails the build, never the request. */\n` +
  `export const FULFILLMENT_SYSTEM_PROMPT_LENGTH = ${EXPECTED_SYSTEM_LENGTH};\n\n` +
  `/** The user-template length in the node, asserted so a change forces a re-read of the port. */\n` +
  `export const FULFILLMENT_USER_TEMPLATE_LENGTH = ${EXPECTED_USER_LENGTH};\n\n` +
  `/** The model the live node runs this prompt on. */\n` +
  `export const FULFILLMENT_NODE_MODEL = ${JSON.stringify(modelId)};\n\n` +
  `export const FULFILLMENT_SYSTEM_PROMPT = ${JSON.stringify(system)};\n`;

writeFileSync(OUT, body, 'utf8');

// Verify what landed on disk round-trips, so a serialisation fault cannot pass.
const back = readFileSync(OUT, 'utf8');
const m = back.match(/export const FULFILLMENT_SYSTEM_PROMPT = (".*");\n$/s);
if (!m || JSON.parse(m[1]) !== system) die('post-write verification failed — the file does not round-trip.');

console.log(`wrote ${OUT}`);
console.log(`  system prompt ${system.length} chars (assertion passed)`);
console.log(`  user template ${user.length} chars (assertion passed)`);
console.log(`  node model    ${modelId}`);
