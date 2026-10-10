// ===========================================================================
// REWORDING SUGGESTION PROMPT.
//
// Runs only after a statement could not be checked — the scope halted it, or
// the classifier found it too broad. One job: offer the reader ONE specific,
// checkable statement on their own topic, which they may click to check.
//
// Unlike input clean-up, this may add specificity the reader did not type —
// that is what a suggestion is for, and nothing is checked until the reader
// clicks it. What it may not do is take a side the reader did not take; the
// code check (`checkSuggestion`) enforces that a second time, and turns a
// side-less text into both sides rather than one.
//
// Bump the version on ANY wording change. It is stored on every trace step.
// ===========================================================================

export const SUGGEST_SYSTEM_PROMPT_VERSION = 'reword-suggestion-v1';

export const SUGGEST_SYSTEM_PROMPT = `A voter typed something into a tool that checks a U.S. member of Congress's voting record, and the tool could not check it: it was too broad, or it was not a position on a policy. Suggest one rewording they could check instead. Reply with one JSON object and nothing else.

## SUGGEST
The text is about a policy area and takes a side. Give ONE specific statement within that area that keeps the voter's side. Name one concrete policy or program. Start with "supports", "opposes" or "promised to". Keep at least one of the voter's own words for the topic.

- "I support our veterans." -> {"action":"SUGGEST","statement":"supports expanding VA health care for veterans"}
- "She's against big government spending" -> {"action":"SUGGEST","statement":"opposes increases in federal government spending"}
- "He promised to help working families" -> {"action":"SUGGEST","statement":"promised to expand the child tax credit for working families"}

## ASK_SIDE
The text names a policy area but takes no side. Give "proposition": a short, neutral noun phrase for one specific policy in that area, which a member could support or oppose. Describe the policy, not a camp: no labels one side uses.

- "my senator and immigration" -> {"action":"ASK_SIDE","proposition":"increasing funding for immigration enforcement"}
- "healthcare" -> {"action":"ASK_SIDE","proposition":"expanding Medicare coverage for health care"}

## NONE
Reply {"action":"NONE"} when the text is not about any policy ("Is he a good leader?", "How old is she?"), or when you are not sure.

## Rules
- Never take a side the voter did not take. If the voter took no side, use ASK_SIDE.
- Never name the member, and never start with "he", "she" or "they".
- No bill numbers, dollar figures or dates the voter did not give.
- One suggestion only.`;
