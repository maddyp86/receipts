#!/usr/bin/env node
/**
 * The 12-row classifier check.
 *
 * BAR: every returned (Primary Issue, Sub Issue) pair is in the approved
 * taxonomy. That is all. This is a PROMPT-QUALITY check, not a parity check
 * against the GPT-4.1 corpus labels — it does not compare which pair was
 * chosen, only that the pair exists.
 *
 * Why that bar is worth having on its own: an off-taxonomy pair is not a
 * judgement call, it is a broken query. `lookupTaxonomyKeywords` misses, the
 * `Related Terms:` line drops out of the embedded text, the query vector moves,
 * and retrieval returns nothing — which the tool renders as "no relevant
 * bills". A wrong-but-valid pair at least retrieves something a human can see
 * is wrong; an invented pair fails silently.
 *
 * A failure here is a PROMPT fix, not a model swap.
 *
 *   npx tsx tools/check-classify-taxonomy.mjs
 *
 * Run under tsx, not bare node: the server is not compiled to dist (its
 * tsconfig is noEmit), so this imports TypeScript source directly.
 *
 * Requires ANTHROPIC_API_KEY. It will not run without one, and it will not
 * substitute a stub — a fabricated pass rate is worse than no pass rate.
 */
import { classifyPromise } from '../packages/server/src/evaluation/classify.ts';
import { config } from '../packages/server/src/config.ts';

/**
 * Twelve statements spread across the taxonomy, in the register real users
 * type: plain, unhedged, sometimes vague. Two are deliberately hard —
 * #11 is cross-cutting (trade vs agriculture) and #12 is close to unevaluable,
 * which is a legitimate `is_evaluable: false` rather than a forced guess.
 */
const ROWS = [
  'I will lower prescription drug prices for seniors.',
  'We need to protect Social Security from any cuts.',
  'I support expanding background checks on gun sales.',
  'Cut taxes for small businesses and get government out of the way.',
  'We should rejoin the Paris Agreement and take climate change seriously.',
  'Secure the southern border before anything else.',
  'Every American deserves affordable child care.',
  'I will vote against any bill that raises the deficit.',
  'Expand rural broadband so kids can do their homework.',
  'Protect a woman’s right to choose.',
  'Tariffs are killing our farmers and we need better trade deals.',
  'Washington is broken and I will fight for you every single day.',
];

if (!config.anthropic.apiKey) {
  console.error(
    '\ncheck-classify-taxonomy: ANTHROPIC_API_KEY is not set.\n\n' +
      'This check makes real classify calls. It will not run against a stub —\n' +
      'a fabricated pass rate would be worse than no pass rate at all.\n',
  );
  process.exit(2);
}

console.log(`classify model: ${config.models.classify}`);
console.log(`rows: ${ROWS.length}\n`);

const results = [];
for (const [i, text] of ROWS.entries()) {
  try {
    const r = await classifyPromise(text);
    const pair =
      r.input.is_evaluable === false
        ? '(is_evaluable: false — no pair required)'
        : `${r.input.primary_issue} / ${r.input.sub_issue}`;
    results.push({ i: i + 1, text, pair, ok: r.inTaxonomy });
    console.log(`${r.inTaxonomy ? 'IN ' : 'OUT'}  ${String(i + 1).padStart(2)}. ${pair}`);
    if (!r.inTaxonomy) console.log(`        statement: ${text}`);
  } catch (err) {
    results.push({ i: i + 1, text, pair: `ERROR: ${err.message}`, ok: false });
    console.log(`ERR  ${String(i + 1).padStart(2)}. ${err.message}`);
  }
}

const passed = results.filter((r) => r.ok).length;
const rate = ((passed / results.length) * 100).toFixed(1);
console.log(`\nin-taxonomy: ${passed}/${results.length}  (${rate}%)`);

if (passed !== results.length) {
  console.log(
    '\nOff-taxonomy results are a PROMPT problem, not a model problem.\n' +
      'Tighten the exact-spelling instruction in CLASSIFY_SYSTEM_PROMPT before\n' +
      'considering a different classify model.',
  );
  process.exit(1);
}
