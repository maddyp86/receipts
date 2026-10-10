// ===========================================================================
// try-cleanup — run input clean-up (cleanup/cleanUpInput.ts) against the LIVE
// model on a list of texts, without switching it on for anyone.
//
//   npx tsx tools/try-cleanup.mts                 the default set below
//   npx tsx tools/try-cleanup.mts "text" "text"   your own
//
// One small classify-model call per question-shaped text (statements never
// reach the model: the free check skips them). No query is run, nothing is
// stored. Prints what the model returned and what the code check made of it.
// ===========================================================================

import {
  checkDecision,
  liveCleanupFetcher,
  needsCleanUp,
  type RawCleanupOutput,
} from '../packages/server/src/cleanup/cleanUpInput.ts';

const DEFAULTS = [
  // Typed by real readers, 2026-10 (docs/beta-review.sql).
  'He promised to ban assault weapons.',
  'He said he was going to pass bills to ban abortion.',
  'He said he would pass a bill capping insulin at $35 a month.',
  'He supports protecting abortion rights.',
  'I will protect clean air.',
  'promised to repeal the death tax',
  'What is his stance on abortion?',
  // The "Try" examples under "How to ask".
  'Did they vote to protect abortion access?',
  'Did they vote to limit abortion after 15 weeks?',
  'Have they backed expanding VA health care?',
  "Did they vote to raise veterans' disability pay?",
  // And the "Instead of" ones, and edges.
  'Do they support our veterans?',
  'Are they a good leader?',
  'Did he vote to cancel student debt?',
  'Is she against the assault weapons ban?',
  'gun control?',
  'abortion',
  'How did he do on healthcare?',
  "What's his position on tariffs?",
];

const texts = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULTS;
const fetcher = liveCleanupFetcher();

console.log('| typed | model said | after the check |');
console.log('|---|---|---|');
for (const text of texts) {
  if (!needsCleanUp(text)) {
    console.log(`| ${text} | — (not question-shaped: no call) | passes through as typed |`);
    continue;
  }
  let raw: RawCleanupOutput | null = null;
  let err = '';
  try {
    raw = await fetcher(text);
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  const d = err ? null : checkDecision(text, raw);
  const said = err ? `error: ${err}` : JSON.stringify(raw);
  const after = !d
    ? 'passes through as typed (failed open)'
    : d.action === 'REWRITE'
      ? `**checked as** "${d.statement}"`
      : d.action === 'ASK_SIDE'
        ? `**asks which way**: Supports / Opposes ${d.proposition}${d.why ? ` (${d.why})` : ''}`
        : `passes through as typed (${d.reason})`;
  console.log(`| ${text} | ${said.replace(/\|/g, '\\|')} | ${after.replace(/\|/g, '\\|')} |`);
}
process.exit(0);
