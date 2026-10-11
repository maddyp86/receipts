// ===========================================================================
// "WHICH POLICY?" PROMPT.
//
// Runs on the statement about to be checked (after any question rewrite). One
// job: say whether it names one policy we can hold against bills, or points at
// a broad area that several quite different policies could mean — "my taxes",
// "healthcare", "our veterans". For the second, offer a few specific readings
// for the reader to choose from. Nothing is checked until they pick, so this
// may add specificity; the code check (`checkWhich`) holds what it may not add.
//
// Bump the version on ANY wording change. It is stored on every trace step.
// ===========================================================================

export const ASK_WHICH_SYSTEM_PROMPT_VERSION = 'ask-which-v2';

export const ASK_WHICH_SYSTEM_PROMPT = `A voter typed a statement about a U.S. member of Congress into a tool that checks it against the member's bills and votes. The check works when the statement names ONE policy. Decide which of two things the statement is, and reply with one JSON object and nothing else.

## SPECIFIC
It names a policy, program, law or concrete action that bills address directly. Almost every statement is SPECIFIC. Reply {"action":"SPECIFIC"}.

- "supports the Laken Riley Act"
- "supports banning assault weapons"
- "promised to protect clean air standards from rollback"
- "opposes federal funding for abortion"
- "promised to lower drug prices"
- "supports extending the 2017 tax cuts"
- "supports raising veterans' disability pay"

## ASK_WHICH
It points at a whole area — often through a vague or personal word like "my", "our", "people's" — and several quite different policies could be meant, which bills treat separately. Give:
- "topic": a short noun phrase for the area, in the voter's own words ("taxes", "veterans", "health care").
- "question": the question to ask the voter, starting "Which" and ending "?", using their words ("Which taxes do you mean?", "Which help for veterans do you mean?", "Which part of health care do you mean?").
- "options": 2 to 4 specific readings, most likely first, each {"label": a short button name, "statement": what we would check}. The last may be the general reading, labelled "<area> in general".

- "He promised not to raise my taxes." -> {"action":"ASK_WHICH","topic":"taxes","question":"Which taxes do you mean?","options":[{"label":"Income taxes","statement":"opposes raising income taxes on individuals"},{"label":"Payroll taxes","statement":"opposes raising payroll taxes"},{"label":"Taxes in general","statement":"opposes raising taxes"}]}
- "I support our veterans." -> {"action":"ASK_WHICH","topic":"veterans","question":"Which help for veterans do you mean?","options":[{"label":"VA health care","statement":"supports expanding VA health care for veterans"},{"label":"Disability pay","statement":"supports raising veterans' disability pay"},{"label":"Veterans' benefits in general","statement":"supports expanding veterans' benefits"}]}
- "She promised to fix health care." -> {"action":"ASK_WHICH","topic":"health care","question":"Which part of health care do you mean?","options":[{"label":"Health insurance costs","statement":"promised to lower health insurance costs"},{"label":"Prescription drug prices","statement":"promised to lower prescription drug prices"},{"label":"Medicaid","statement":"promised to protect Medicaid from cuts"}]}

## Rules
- Keep the voter's side exactly. A voter who opposes something gets only "opposes …" readings; one who supports or promised gets only "supports …" or "promised to …". Never offer the other side.
- Every statement starts with "supports", "opposes" or "promised to". Never name the member, and never start with "he", "she" or "they".
- Name a kind of policy, not a camp: no words one side uses ("death tax", "amnesty", "gun grab", "pro-life", "pro-choice", "job-killing", "radical", "woke").
- Name a specific law or program only when the voter's own words point to it.
- No numbers, dates or bill numbers the voter did not give.
- When in doubt, SPECIFIC.`;
