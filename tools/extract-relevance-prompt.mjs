#!/usr/bin/env node
/**
 * Generates packages/server/src/evaluation/relevancePrompt.ts from the live
 * W7b node, rather than transcribing it.
 *
 * The prompt is 13,740 characters. Nobody is going to notice a hand-edit drift
 * in a string that long by reading it, so the length is asserted here and the
 * build fails if it moves. If it legitimately changed upstream, update
 * EXPECTED_LENGTH in the same commit as the regenerated file, so the change is
 * visible in review rather than silent.
 *
 * Usage:
 *   node tools/extract-relevance-prompt.mjs <path-to-w7b-workflow.json>
 *
 * The JSON is an n8n workflow dump (dwO2OT2iRpR7bCov). Fetch it read-only; this
 * script never writes to n8n.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const EXPECTED_LENGTH = 13740;
const NODE_NAME = 'Build Eval Request';
const OUT = resolve('packages/server/src/evaluation/relevancePrompt.ts');

const src = process.argv[2];
if (!src) {
  console.error('usage: node tools/extract-relevance-prompt.mjs <w7b-workflow.json>');
  process.exit(2);
}

const wf = JSON.parse(readFileSync(src, 'utf8'));
const nodes = wf.workflow?.nodes ?? wf.nodes ?? [];
const node = nodes.find((n) => n.name === NODE_NAME);
if (!node?.parameters?.jsCode) {
  console.error(`Could not find a "${NODE_NAME}" code node in ${src}.`);
  process.exit(1);
}

const code = node.parameters.jsCode;
const marker = 'const SYSTEM = `';
const start = code.indexOf(marker);
if (start === -1) {
  console.error('Could not find `const SYSTEM = \\`` in the node source.');
  process.exit(1);
}

// Walk to the closing backtick, respecting escapes.
let i = start + marker.length;
for (; i < code.length; i += 1) {
  if (code[i] === '\\') { i += 1; continue; }
  if (code[i] === '`') break;
}
const prompt = code.slice(start + marker.length, i);

// --- assertions ---------------------------------------------------------
if (prompt.length !== EXPECTED_LENGTH) {
  console.error(
    `SYSTEM prompt is ${prompt.length} chars, expected ${EXPECTED_LENGTH}.\n` +
      'The upstream prompt changed. Re-read the node, confirm the change was ' +
      'intended, then update EXPECTED_LENGTH in this script in the same commit.'
  );
  process.exit(1);
}
// The emitted file uses a template literal for readability. That is only safe
// while the prompt contains neither of these.
if (prompt.includes('`') || prompt.includes('${')) {
  console.error('Prompt now contains a backtick or ${ — switch the emitter to JSON.stringify.');
  process.exit(1);
}

const banner = `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Source: W7b (dwO2OT2iRpR7bCov) -> "${NODE_NAME}" -> const SYSTEM
 * Regenerate: node tools/extract-relevance-prompt.mjs <w7b-workflow.json>
 *
 * Extracted rather than transcribed, and length-asserted at ${EXPECTED_LENGTH}
 * characters, because a silent drift in a prompt this long is invisible to
 * review. The prompt is byte-static and MUST stay first in the request: prefix
 * caching only works when the leading tokens are identical across calls.
 */
`;

const body = `${banner}
export const RELEVANCE_MODEL = 'gpt-5.4-mini';
export const RELEVANCE_PROMPT_CACHE_KEY = 'match-eval-v3';
export const RELEVANCE_SYSTEM_PROMPT_LENGTH = ${EXPECTED_LENGTH};

export const RELEVANCE_SYSTEM_PROMPT = \`${prompt}\`;
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, body, 'utf8');
console.log(`wrote ${OUT} (${prompt.length} chars, length assertion passed)`);
