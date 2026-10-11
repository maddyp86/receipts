import type { Stance } from '@receipts/shared';

// ===========================================================================
// THE STANCE A STATEMENT STATES IN ITS OWN WORDS.
//
// The bill reader (evaluator v8) is shown the statement as typed AND a stance
// label, and reads the two together: the goal is "the direction the statement
// wants". So the label has to be relative to the statement's own words.
//
// The classifier's label is not reliably that. It sometimes labels the
// underlying object instead, and the pair then reads as a double negative
// (2026-10-10, eval case 40, run fb5fcdba):
//
//   "supports ending tariffs on imported goods"  → classifier: Opposed (to tariffs)
//   bill reader: "the statement is opposed to ending tariffs" → a resolution
//   ending the tariff emergency read as HINDER
//
// The same run of traces had "supports restricting abortion" labelled Opposed
// and "supports overturning California's electric vehicle rules" labelled
// Opposed. Every one of them opens with a word that settles the direction.
//
// So when the statement opens with one, that word decides, in code. Input
// clean-up writes every question it restates in this form ("supports …",
// "opposes …", "promised to …"), so this covers nearly every query. A
// statement with no such opening keeps the classifier's label. Anything the
// opening does not settle cleanly — a negation, a hedge — returns null.
// ===========================================================================

const SUBJECT = String.raw`(?:(?:he|she|they|the senator)\s+)?`;
const FAVOR = String.raw`supports?|supported|backs?|backed|favou?rs?|favou?red|(?:promised|pledged|vowed|wants?|will work|plans?)\s+to|voted\s+for|is\s+for|are\s+for`;
const OPPOSE = String.raw`opposes?|opposed|(?:is|are)\s+against|against|voted\s+against|rejects?|rejected`;

const FAVOR_RE = new RegExp(`^${SUBJECT}(?:${FAVOR})\\s+\\S`, 'i');
const OPPOSE_RE = new RegExp(`^${SUBJECT}(?:${OPPOSE})\\s+\\S`, 'i');

/**
 * The direction a statement's opening word states, or null when it opens with
 * no such word. "Supports ending X" is In Favor — of ending X.
 */
export function statedStance(text: string): Extract<Stance, 'In Favor' | 'Opposed'> | null {
  const t = text.trim().replace(/^["“']+/, '');
  if (OPPOSE_RE.test(t)) return 'Opposed';
  if (FAVOR_RE.test(t)) return 'In Favor';
  return null;
}
