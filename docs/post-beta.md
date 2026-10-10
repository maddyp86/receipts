# After the beta

Decided, not built. Each item says what to do and why it waits.

## Cache bill_effect per (statement, bill)

**What.** Store the fulfilment evaluator's reading of a bill against a
statement, keyed on the statement as the evaluator sees it and the bill (its
id and the text version read), and reuse it wherever the same pair comes up
again: for the other senator, in a later run, after a correction that does not
change the statement.

**Why.** Evaluator v8 sees only the bill and the statement, so one pair should
have one reading. It does not yet: on byte-identical input the model returned
ADVANCE (0.78) in one run and NEUTRAL (0.65, same_object false) in the other
for sjres81-119 against the tariffs statement (eval cases 4 and 5, run on
2026-10-10). A reader comparing two senators would see one bill read two ways.
A cache makes the second reading impossible rather than unlikely.

**Mind.** The key must include everything in the evaluator's message — the
statement's text, type, stance, issue pair and scope fields, and the bill's
text version — so that a correction or a new text version is a new key. A
failed or ERROR reading is never cached. Invalidate with the evaluator prompt
version, the same way answer reuse invalidates with the pipeline fingerprint.

## The Low band's wording, by reason

**What.** Say "thin evidence" for a Low band that comes from a single weak
match or soft evidence only, and a separate phrase for the three rules that
lower a band to Low: an action judged against a later text, a deciding bill
that could not be read, and a failed read of the record.

**Why.** "Thin evidence" is untrue for the lowered cases. The clean-air answer
rests on two recorded votes and is Low only because one vote was judged
against a later version of the bill. Until this is built every Low says "low
confidence", which is true of all five. `scoring/honestySweep.test.ts` pins
that today and will need updating with it.
