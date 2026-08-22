# Promise Query Tool — App Context

Companion to `wf10a-wf11-method-spec.md`. That document explains how a verdict
and score are produced. This one covers what the app reads, how it joins, and
what it may claim.

Read the method spec first — especially §9 (what the output can and cannot
support) and §10–14 (the effort signal).

---

## 1. What the app does

A user names a promise or an issue and a senator. The app returns:

1. **What the senator said** — the promise text, its stance, its type
2. **What they did about it** — every scored decision, grouped by effort signal
3. **What happened to those bills** — current legislative status
4. **A score, with its denominator and caveats** — never a bare number

The differentiator is (2) and (3) together. Existing fact-checking sites give a
verdict. This gives the verdict plus the roll-call evidence plus what became of
the legislation — and says plainly when it does not know.

---

## 2. Three layers of freshness

This is the single most important thing to get right, because two of these
change on different clocks and the third never changes at all.

| Layer | Mutability | How to read it |
|---|---|---|
| **Verdict & score** (`Promise Alignment - Matches`, `Decision Scores`) | **immutable** — written once, never revisited | read directly, no join |
| **Bill status** (`Bills Master`) | **refreshed weekly** by WF2b | **join live on `Bill ID`** |
| **Trust report** (`Summary Output`, `Trust Index`) | **point-in-time snapshot** | read as published, with its `Status As Of` |

⚠ **Never copy bill status onto a cached verdict row.** The alignment tabs are
append-only by design (`Filter Non Stored Items` guarantees a row is written
once), so a status snapshot stored there freezes at evaluation time and ages
silently. Join it at query time instead.

⚠ **Never present a status without its date.** `Status Checked At` on Bills
Master is the as-of stamp. "Became law" is a claim about a mutable fact; "became
law (verified 3 days ago)" is defensible.

---

## 3. Data model

### Primary read — one promise, one senator

```
Promise Alignment - Matches
  WHERE Politician ID = ? AND Promise UID = ?
```

Per row: `Bill ID`, `Promise Alignment`, `Bill Effect`,
`Bill Effect Reasoning`, `Alignment Reasoning`, `Alignment Confidence`,
`Vote`, `Cloture Vote`, `Passage Vote`, `Is Sponsor`, `Is Co-Sponsor`,
`Match Verdict`, `Partial Subtype`, `Party Alignment`, `Donor Alignment`,
`Reverses Existing Policy`, `Target Name`, `Target Source`, `Target Effect`,
`Model Verdict`, `Model Agreed`.

### Join 1 — the score

```
Decision Scores  ON  Score UID = 'SCORE-' + Promise Alignment UID
```

Gives `Decision Score`, `Scorable`, `Base Score`, `Total Modifiers`,
`Modifiers Applied`, `Action Tier`, `Vote Pattern`, `Pattern Multiplier`,
`Specificity Multiplier`, `Scoring Flags`, `Outcome Label`, `Score Explanation`.

⚠ `Decision Score` is **blank** for unscorable rows and `Scorable` is `false`.
Blank is not zero. Excluding them from the denominator is the whole point of
the null contract — see method spec §7.

### Join 2 — current bill status

```
Bills Master  ON  Bill ID
```

Gives `Status`, `Status Checked At`, `Status Changed At`.

### Join 3 — omissions and surprise actions

```
Promise Alignment - Non Matches  WHERE Politician ID = ?
```

`OMISSION` rows are promises with no matched action. `SURPRISE_ACTION` rows are
actions with no matching promise. **Neither is scored** — both carry
`decision_score: null` by design.

---

## 4. Status vocabulary

Unmodified congress.gov / unitedstates-congress scraper strings. **Prefix-match
them** — Aggregation does, and normalising the values would break its counts.

| Prefix | Meaning | Display |
|---|---|---|
| `ENACTED:*` | became law | "Became law" |
| `VETOED*` | passed Congress, vetoed | "Vetoed" |
| `PASSED:*`, `PASS_OVER:*`, `PASS_BACK:*` | cleared a chamber | "Passed the Senate" |
| `REPORTED` | out of committee, no floor vote | "Reported out of committee" |
| `FAIL:*`, `PROV_KILL*` | failed on the floor | "Failed on the floor" |
| `REFERRED` | in committee | "Referred to committee" |
| `INTRODUCED` | introduced only | "Introduced" |

⚠ `FAIL:*` is **not** terminal. A bill that failed cloture can return under a
motion to reconsider — which is exactly the Rule XIII case below.

---

## 5. Effort signal — derive in the app

Not in the pipeline. Every input is already on the row, so this is a pure
function; and a layer that cannot write back to the trust index cannot
contaminate it. (Folding an effort signal into a score is precisely how the
sponsorship double-count happened.)

```
PRESERVED_FOR_RECONSIDERATION   Promise Alignment = PROCEDURAL_SWITCH
AUTHORED                        Is Sponsor
CO_SIGNED                       Is Co-Sponsor
BLOCKED_OPPOSITION              Bill Effect = HINDER AND any NAY
VOTED_TO_ADVANCE                Bill Effect = ADVANCE AND effective vote YEA
VOTED_AGAINST                   action opposed the promise's goal
NO_ACTION                       no vote, no sponsorship
```

Signals are **additive** — a senator can be `AUTHORED` + `VOTED_TO_ADVANCE` +
`BLOCKED_OPPOSITION` across different bills on one promise. That combination is
the strongest evidence the data supports and is invisible in an averaged score.

### `BLOCKED_OPPOSITION` must not get buried

It is the strongest positive signal in the corpus and it is easy to
under-report, because to a casual reader it looks like a NAY.

- **Label by effect, never by vote direction.** "Voted to block a bill that
  would have cut SNAP benefits" — not "Voted NAY on S.1234". The raw vote goes
  in the detail.
- **Group by effort signal, not chronologically.** A date-ordered list scatters
  the strongest evidence among procedural noise.
- **Sort by `|Decision Score|` within groups.** `DECISIVE_BLOCK` carries the
  highest multiplier in the model (×1.15), so these surface naturally.

⚠ **Never invert the displayed vote to make it read positive.** "Voted YES to
protect SNAP" when the roll call says NAY is the reframing that gets a
fact-checking product torn apart. Show the NAY; explain what it did.

---

## 6. Procedural switch — where status finally matters

`PROCEDURAL_SWITCH` fires when a senator sponsored or co-sponsored a bill and
then voted NAY. Under Senate Rule XIII only a member on the prevailing side may
move to reconsider, so a sponsor whose bill is about to fail cloture switches to
NAY to preserve that right.

It is **not scored** — the record cannot separate a Rule XIII maneuver from a
sponsor who genuinely turned against an amended text.

But **bill status answers the follow-on question: did the maneuver work?**

| Current status | Narrative |
|---|---|
| `ENACTED:*` / `PASSED:*` | "…and the bill subsequently passed" |
| still `REFERRED` / `PROV_KILL` | "…and has not brought it back" |
| `FAIL:*` after a later vote | "…and it failed again" |

This is the clearest case for the live join. The verdict was frozen at
evaluation; the outcome kept moving.

**Language discipline:** say *"this pattern is typically a procedural maneuver
to preserve the bill"* — never *"he was working to advance it."* Detection is
structural. Asserting intent about a named senator is not supported by the
evidence and is the claim most likely to be challenged.

⚠ **Data-model limit.** ` Politician Bill Actions` holds one `Cloture Vote` and
one `Passage Vote` per action. A reconsidered bill has two cloture votes and
nowhere to put the second, so a successful maneuver's follow-up vote may not be
in the corpus. Do not assert that a senator did or did not vote on the
reconsidered measure.

---

## 7. Bill outcome

```
BECAME_LAW        Status starts ENACTED
VETOED            Status starts VETOED
PASSED_SENATE     Status starts PASSED / PASS_OVER / PASS_BACK
DIED_ON_FLOOR     Status starts FAIL or PROV_KILL
IN_COMMITTEE      REFERRED or REPORTED
```

The first three are also derivable from the vote fields alone (`Cloture Vote`
present with no `Passage Vote` implies it died at cloture), so the app degrades
gracefully if the Bills Master join is unavailable.

This is what separates "he tried and the chamber didn't act" from "he didn't
try" — the distinction the effort signal exists to make.

---

## 8. Response shape

```
Promise: "protect and expand student loan relief"
Senator: Chuck Schumer                    Type: Policy Position

WHAT HE DID  (n decisions found)
  Blocked opposition          2   voted to stop CRA resolutions nullifying relief rules
                                  → both bills failed on the floor
  Co-signed                   4   3 referred to committee, 1 never scheduled
  Preserved for reconsideration 1  S.4554 — procedural, not scored
  No clear signal             3   bill on-topic but a different policy object

SCORED DECISIONS   x of n        (frozen rows excluded, listed separately)
AVERAGE SCORE      0.00          (always show the denominator)

Bill status verified 2026-08-15.

COVERAGE
  Retrieval finds roughly half of relevant legislative actions. Absence of
  evidence here is not evidence the senator did nothing.
```

Lead with evidence, not the number.

---

## 9. Claims discipline

**Safe to state:**
- What the senator did — vote direction, cloture vs passage, sponsorship
- What the bill would do to the promise's goal (`Bill Effect Reasoning`)
- Why the two combine to a verdict (`Alignment Reasoning`)
- Current bill status, **with its as-of date**
- The score, **with its denominator and modifiers**

**Must be qualified:**
- `NOT_DETERMINABLE` at 12–17% — render as "no clear signal", never as neutral
  and never as a broken promise
- Sponsorship-tier scores rest on six unvalidated base numbers, and sponsorship
  is ~82% of the corpus
- Reversal bills with vacuous target descriptions are ~50% reliable — the
  `Target Effect` column shows what the reasoning was based on
- 118th-congress bills are not being re-scraped upstream; their status is
  frozen at whatever was captured while that Congress sat

**Must never be claimed:**
- That a senator intended anything. Every verdict is about recorded behaviour.
- That absence of matched evidence means inaction
- That a frozen or `PROCEDURAL_SWITCH` row is a kept or broken promise
- That a score is comparable across senators without stating both denominators

**Never surface a verdict without its reasoning string.** The traceability is
the product.
