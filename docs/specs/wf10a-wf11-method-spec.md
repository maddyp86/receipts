# Promise Alignment & Decision Scoring — Method Spec

How the pipeline turns a (promise, bill action) pairing into a verdict and a
score. Written as context for a separate web app that answers "where does this
senator stand on this issue, based on their legislative behaviour?"

Status: MVP. Every number and rule here is live in n8n as of 2026-08-15.
Aggregation has been built but has never executed, so anything about senator-
level indices is design, not observation.

---

## 0. The one-paragraph version

A promise and a bill action are paired by vector retrieval. A relevance step
decides whether the pairing is real evidence. A fulfillment step decides what
the bill does to the promise's **goal** — and that is the only judgement an LLM
makes. The verdict (kept / broke / can't tell) is then **derived in code** from
bill effect × the senator's action. A separate deterministic scorer turns that
verdict plus context into a number between −2.0 and +1.5. The LLM writes the
plain-language explanation and cannot change any number.

---

## 1. Why the LLM does so little

This is the central design decision and it was arrived at empirically.

Early versions asked the model to select a scoring row from an 18-row table and
apply modifiers. Measured failures:

- **18% error on a six-row lookup** at `temperature: 0`. Both failures were the
  same shape: the model re-applied the promise's stance at the final step, a
  shortcut that agrees with the correct answer on ADVANCE bills and diverges
  only on HINDER bills.
- An eval regression from 91% → 68.5% whose named root causes were
  "ALIGNED base score confusion" and "donor pressure modifier applied without
  meeting threshold" — both table lookups, not reasoning.

The rule that came out of it: **LLMs decide which outcome applies; arithmetic
and table lookups are code.** Applied consistently, the disagreement rate
between the model's own verdict and the derived verdict went 18% → 4% → 0%.

The model's verdict is still captured (`Model Verdict` / `Model Agreed`) purely
as a drift instrument. It never affects a score.

---

## 2. Inputs to a single evaluation

A pairing arriving at WF10A carries:

| Field | Source | Notes |
|---|---|---|
| Promise text, stance, issue/sub-issue | Evaluable Statements | stance is SUPPORT / OPPOSE / Neutral-Unclear |
| Statement Type | Evaluable Statements | `Campaign Promise` or `Policy Position` |
| Promise Type | Evaluable Statements | `policy` / `process` / `non_legislative` / `rhetorical` |
| Bill title, summary, mechanisms, intended effects | Impact Statements | |
| Stakeholder impacts | Impact Statements | supporting context only |
| Reverses Existing Policy, Target Name/Source/Effect | Impact Statements | for reversal bills |
| Vote, Cloture Vote, Passage Vote | Politician Bill Actions | any may be `NA` |
| Is Sponsor / Is Co-Sponsor | Politician Bill Actions | |
| Party Alignment, Party Whip Vote | computed | |
| Donor Alignment + pro/anti/neutral counts | Donor Alignments | |
| Platform Alignment | Platform Matches (WF9) | party platform comparison |
| Match Verdict, Partial Subtype, Similarity Score | Promise Matches | evidence tier |

---

## 3. Gates — what never reaches evaluation

Applied before any LLM call.

**Promise Type gate.** `non_legislative` and `rhetorical` promises are
`NOT_APPLICABLE` by construction — no legislative act can fulfil or break them.
(Before this gate, one `non_legislative` promise was scored BROKE and two
`rhetorical` ones INCONSISTENT in a single 11-row run.)

**Stance gate.** A promise with stance `Neutral/Unclear` carries no direction,
so nothing can honour or contradict it.

**Evidence gate.** Only `TRUE_POSITIVE` and `PARTIAL/SPECIFICITY` relevance
verdicts are admitted:

- `SPECIFICITY` — on the promise's subject but a broader/different vehicle than
  named. The vote IS informative. **Admitted, discounted ×0.85 later.**
- `DIRECTIONAL` — the relevance layer explicitly said this action tells you
  nothing about this promise. **Excluded.** Also the branch that would let one
  appropriations vote spray verdicts across dozens of promises.
- `AMBIGUOUS` (confidence < 0.70) and `UNCLASSIFIED` — routed to review.

**Deduplication.** One decision per (promise, bill, action). Evidence tier
outranks cosine similarity — a `PARTIAL` with a higher score is still weaker
evidence than a `TRUE_POSITIVE`.

---

## 4. STEP 1 — Bill Effect (the LLM's actual job)

Classify the bill's effect on the promise's **goal**:

- **ADVANCE** — moves policy toward what the promise seeks
- **HINDER** — works against it
- **NEUTRAL** — the bill's OBJECT is different

### The rule that matters most: mechanism is not the test

A bill that moves the goal through a **different mechanism than the promise
named** is ADVANCE or HINDER, never NEUTRAL. Indirectness goes into
*confidence*, not into the effect.

```
Promise: "background checks, gun show loophole, red flag laws"
Bill:    assault weapons ban
      -> ADVANCE at 0.7    (different mechanism, same goal)

Promise: "vote on the Women's Health Protection Act"
Bill:    contraception access protection
      -> NEUTRAL           (different object, adjacent policy lane)
```

The test for NEUTRAL: **is the OBJECT different, or only the MECHANISM?**

Getting this wrong was worth 24 percentage points — `NOT_DETERMINABLE` ran at
36–44% before the boundary was fixed and 12–17% after.

### Partial credit is not full credit

ADVANCE means the bill moves the goal. It does **not** mean the promise was
fulfilled. An assault weapons ban advances gun safety; it does not deliver
universal background checks. That gap is carried in confidence and in the ×0.85
specificity multiplier, not by refusing to score.

### Reversal bills (CRA, repeals, terminations, rescissions)

These act on an external target — an agency rule, a statute, a declared
emergency. The bill's effect depends entirely on what the **target** does, and
the target is usually not in the corpus.

Reasoning order:
1. What does the TARGET do? (read `Target Effect`)
2. Does the promise want that to CONTINUE or to END?
3. CONTINUE → this bill HINDERS. END → this bill ADVANCES.

```
Promise: "protect and expand student loan relief"
Bill:    CRA resolution disapproving the RISE rule
Target Effect: "Eliminated Graduate PLUS loans and imposed borrowing caps"
      -> ADVANCE   (nullifying a restriction the promise opposed)

Same promise, different CRA:
Target Effect: "Expanded waivers and modifications for federal student loans"
      -> HINDER    (nullifying an expansion the promise supported)
```

**The word "disapproval" does not decide the direction.** Before this was
handled, a promise Schumer co-sponsored a bill to *defend* was scored as broken
at 0.9 confidence.

⚠ **Known MVP limitation.** When `Target Effect` is vacuous — e.g. "Established
new regulations for the Federal Student Loan Program", true but content-free —
the correct answer is NEUTRAL. That test currently lives in the prompt and is
about 50% reliable: two rows with the identical string produced different
verdicts in one run. A code-based classifier was tested and rejected (5 of 21
misclassifications). The real fix is fetching the rule's abstract from the
Federal Register. **Reversal bills with vacuous target descriptions are the
least reliable output in the system.**

---

## 5. STEP 2 — Effective action

Precedence: recorded vote > sponsorship > nothing.

**Two vote types, different meanings.** Cloture is procedural — whether debate
ends so the bill can reach a final vote. Most contested Senate bills die there.
Passage is the vote on the bill itself.

**Any NAY governs.** A senator who votes NAY at either stage has registered
opposition:

- `cloture NAY + passage YEA` — blocked it, then joined once it was passing
  anyway. The block is the real position.
- `cloture YEA + passage NAY` — procedural courtesy, then substantive
  opposition. The NAY is the real position.

**PROCEDURAL_SWITCH.** If the senator sponsored or co-sponsored the bill **and**
voted NAY, that is a parliamentary maneuver, not opposition. Under Senate Rule
XIII only a member voting on the prevailing side may move to reconsider, so a
leader whose own bill is about to fail cloture switches to NAY to preserve the
right to bring it back. Schumer did exactly this on S.4554 while his whip voted
YEA.

Scored naively this reads ADVANCE + NAY = BROKE at the highest magnitude in the
model — a fabricated broken promise on the senator's own legislation. It is
**not scored in either direction** and is flagged for review.

---

## 6. STEP 3 — Verdict (code, not the LLM)

```
                     senator SUPPORTED      senator OPPOSED
ADVANCE bill    ->   KEPT / CONSISTENT      BROKE / INCONSISTENT
HINDER  bill    ->   BROKE / INCONSISTENT   KEPT / CONSISTENT
NEUTRAL bill    ->   NOT_DETERMINABLE       NOT_DETERMINABLE
no action       ->   NOT_DETERMINABLE       NOT_DETERMINABLE
sponsored + NAY ->   PROCEDURAL_SWITCH (checked first, overrides all)
```

`KEPT`/`BROKE` for Campaign Promises; `CONSISTENT`/`INCONSISTENT` for Policy
Positions, which carry a −0.1 confidence penalty for the weaker commitment
standard.

**Stance is never applied twice.** It is already baked into ADVANCE/HINDER at
STEP 1. Re-applying it inverts the verdict for every OPPOSE-stance promise —
this was the single largest source of wrong verdicts.

**On a disapproval resolution a NAY defeats the resolution and preserves the
underlying policy.** This is the most misread pattern in the corpus.

---

## 7. Decision score (WF11, fully deterministic)

```
score = (base + Σ additive modifiers)
        × vote_pattern_multiplier
        × specificity_multiplier
        × 0.8 if confidence < 0.7
clamped to [−2.0, +1.5]
```

### Base — action tier × party × donor

**VOTED tier** (a recorded floor vote exists)

| | donor OPPOSED | NO_DATA | ALIGNED |
|---|---|---|---|
| KEPT · crossed party | 1.3 | 1.1 | 1.0 |
| KEPT · with party | 1.0 | 0.9 | 0.8 |
| BROKE · crossed party | −1.2 | −1.1 | −1.5 |
| BROKE · with party | −1.1 | −1.0 | −1.4 |

**SPONSOR tier** (no floor vote) — KEPT 0.35–0.50, BROKE −0.90 to −1.20
**CO_SPONSOR tier** — KEPT 0.20–0.35, BROKE −0.85 to −1.10
**ABSTAIN** (recorded "Not Voting") — KEPT −0.30, BROKE −0.50

⚠ **The sponsorship numbers are proposals that have not been signed off.** They
matter enormously: ~82% of STRONG evidence in this corpus is co-sponsorship and
87% of matched bills are dead legislation. Previously a co-sponsorship on a
bill that never reached the floor scored 0.95 — identical to a recorded
party-line vote. The asymmetry is deliberate: sponsorship is **self-selected**,
so it is cheap credit but expensive blame.

### Vote pattern multiplier

| Pattern | × | Meaning |
|---|---|---|
| `DECISIVE_BLOCK` | 1.15 | cloture NAY, bill never reached passage |
| `CONSISTENT_OPPOSE` / `CONSISTENT_SUPPORT` | 1.05 | same direction at both stages |
| `PASSAGE_ONLY` / `NO_FLOOR_ACTION` | 1.00 | baseline |
| `BLOCKED_THEN_JOINED` | 0.90 | verdict rests on the any-NAY tiebreak |
| `ENABLED_THEN_OPPOSED` | 0.90 | same |
| `CLOTURE_ONLY_YEA` | 0.90 | procedural assent is not endorsement |

### Additive modifiers

```
Platform aligns / contradicts        ±0.05 / ±0.10
Alignment confidence ≥ 0.9           +0.05
Legislative effort (VOTED tier only) +0.10 sponsor / +0.05 co-sponsor  if KEPT
Self-authored contradiction          −0.10 / −0.05                     if BROKE
Donor pressure resisted (≥5 pro)     +0.05
Concentrated donor alignment (≥10)   −0.10
Symbolic opposition                  −0.15   (cloture YEA then passage NAY, KEPT)
Specificity evidence                 ×0.85   (broader vehicle than named)
```

**Effort is scoped to the VOTED tier only.** On the sponsorship tiers the base
row already *is* the sponsorship — applying it there double-counts. It is
signed both directions: sponsoring a bill you then vote through against your own
promise is deliberate, not reactive.

### Frozen outcomes

`NOT_DETERMINABLE`, `PROCEDURAL_SWITCH` and verdict-without-action write
`decision_score: null` and `scorable: false` — **not 0.0**. A zero enters the
mean and says "this decision was worth nothing"; null is excluded from the
denominator and says "we cannot tell". Roughly 16% of rows are frozen.

---

## 8. Worked example

```
Promise    "I will oppose any bill that cuts SNAP benefits"  (OPPOSE)
Bill       reduces SNAP eligibility
Action     cloture NAY, passage NA
Party      with party      Donor  no data
Evidence   TRUE_POSITIVE   Confidence 0.92

STEP 1  bill hinders the goal                    -> HINDER
STEP 2  cloture NAY, no passage vote             -> DECISIVE_BLOCK, opposed
STEP 3  HINDER + opposed                         -> KEPT
SCORE   base 0.9 (KEPT, with party, no donor data)
        + 0.05 confidence ≥ 0.9
        × 1.15 DECISIVE_BLOCK
        = 1.09
LABEL   "Upheld, With Party — Blocked at Cloture"
```

---

## 9. What the app can and cannot claim

**Reliable:**
- Verdict direction on bills with recorded votes and clear effects.
  CRA rows went from 4/5 to 19/19 correct.
- Model/table agreement is 0% disagreement on recent batches.
- Every score is fully reconstructable: base row, each modifier, each
  multiplier, and the evidence tier are all persisted per row.

**Qualified:**
- `NOT_DETERMINABLE` runs 12–17%. That is honest uncertainty, not failure. The
  app should show it as "no clear signal", never as neutral or as a broken
  promise.
- Sponsorship-tier scores rest on six unvalidated numbers, and sponsorship is
  most of the corpus.
- Reversal bills with vacuous target descriptions are ~50% reliable.
- Retrieval coverage is roughly 57% candidate / 48–52% effective, so **absence
  of evidence is not evidence of absence.** A promise with no matched action
  may simply not have been retrieved. Omissions are labelled `PENDING` until
  the term ends in 2029 and are deliberately excluded from scoring.

**Not built:**
- Surprise Alignment / Contradiction and Omission scores exist as labels only,
  not as numbers. Aggregation has never run.
- No senator-level index has been produced or validated.

**Presentation guidance.** Lead with the evidence, not the number. Every row
carries `Bill Effect Reasoning`, `Alignment Reasoning`, the vote detail
(cloture and passage separately), and the evidence tier. A user asking "where
does he stand on student loans?" is better served by three specific votes with
explanations than by a single averaged score — and the traceability is the
differentiator versus existing fact-checking sites.

⚠ **Never surface a verdict without its reasoning string**, and never surface a
`PROCEDURAL_SWITCH` or frozen row as a kept or broken promise.

---

# Addendum — The Effort Signal

## 10. Two different questions

The pipeline answers **"did the outcome happen?"** Users mostly ask **"is this
senator working on it?"** Those come apart, and the gap is largest on exactly
the cases the scorer deliberately discounts or freezes.

| Case | Outcome lens | Effort lens |
|---|---|---|
| Co-sponsored, bill died in committee | base 0.20–0.35, weak | put his name on it; the chamber never acted |
| Sponsored + NAY (Rule XIII) | frozen, `decision_score: null` | authored it, then used procedure to keep it alive |
| Cloture NAY killed a hostile bill | 0.9 × 1.15 = 1.09 | blocked the thing he promised to block |
| No action at all | `NOT_DETERMINABLE` | genuinely nothing on record |

Row 2 and row 4 both produce **no score**. They are not the same thing, and an
app that renders them identically is misinforming the user.

**Compute this in the app layer, not the pipeline.** Every input is already
persisted per row. Keeping it outside the pipeline is also a structural
guarantee: the sponsorship double-count happened because an effort signal got
folded into a score. A layer that cannot write back to the trust index cannot
repeat that.

## 11. Effort signal — derivation

Pure function of fields already on `Promise Alignment - Matches`.

```
PRESERVED_FOR_RECONSIDERATION   (Is Sponsor OR Is Co-Sponsor) AND any NAY
                                → Promise Alignment = PROCEDURAL_SWITCH
AUTHORED                        Is Sponsor = TRUE
CO_SIGNED                       Is Co-Sponsor = TRUE
BLOCKED_OPPOSITION              Bill Effect = HINDER AND effective vote = NAY
VOTED_TO_ADVANCE                Bill Effect = ADVANCE AND effective vote = YEA
VOTED_AGAINST                   action opposed the promise's goal
NO_ACTION                       no vote, no sponsorship
```

Signals are **additive** — a senator can be `AUTHORED` and
`VOTED_TO_ADVANCE` and `BLOCKED_OPPOSITION` on the same promise across
different bills. That combination is the strongest "working on it" evidence the
data supports, and it is invisible in a single averaged score.

⚠ **Effort is never averaged into the trust index and never presented as
fulfilment.** "Working toward" is not "delivered." Keep them in separate UI
regions with different language.

## 12. Bill outcome — why it didn't become law

Needed to separate "he tried and the chamber didn't act" from "he didn't try."

```
DIED_AT_CLOTURE     cloture vote recorded, no passage vote
PASSED_SENATE       passage vote YEA-majority
NEVER_SCHEDULED     no cloture and no passage vote on record
ENACTED             requires bill status
```

⚠ **Bill status is NOT currently on `Promise Alignment - Matches`** — verified
2026-08-15; the row carries only `Cloture Vote Date` and `Passage Vote Date`.
Aggregation reads status upstream, so it exists in the corpus. Surfacing
`ENACTED` needs one mapping addition to the WF10A writer, not a re-drain. The
first three states are derivable today from the vote fields alone.

## 13. Presentation language

**Procedural switch** — do NOT render as a kept or broken promise, and do NOT
render as silence:

> Schumer co-sponsored this bill. When it failed to reach the 60 votes needed
> to advance, he switched his vote to NAY — under Senate rules, only a senator
> on the prevailing side can move to reconsider, so this preserved his ability
> to bring the bill back. His whip voted YEA to keep the party position clear.
>
> *This pattern is typically a procedural maneuver rather than opposition. It
> is not scored in either direction.*

⚠ Say **"this pattern is typically a procedural maneuver"**, never *"he was
working to advance it."* The detection is structural — sponsored + NAY — and
that pattern is also consistent with a sponsor who turned against an amended
final text. The record cannot separate the two. Asserting intent about a named
senator is the claim most likely to be challenged, and it is not supported.

**Sponsorship on a bill that died:**

> Schumer co-sponsored this bill, which would have expanded student loan
> relief. It never received a floor vote.
>
> *Co-sponsorship is a real legislative act, weighted lower than a recorded
> vote because it carries no public roll-call commitment.*

**Blocked opposition** — the strongest positive signal in the data, and easy to
under-report because it is a NAY:

> Schumer voted NAY on cloture for this bill, which would have reduced SNAP
> eligibility. The bill never reached a final vote.
>
> *On a bill that works against a promise, a vote to block it is a vote to keep
> the promise.*

## 14. Suggested response shape

For "where does he stand on student loans?":

```
Promise: "protect and expand student loan relief"

EVIDENCE (n decisions)
  ├─ Blocked opposition   2   voted to stop CRA resolutions nullifying relief rules
  ├─ Co-signed            4   3 died in committee, 1 never scheduled
  ├─ Preserved for reconsideration  1   S.4554 procedural switch, not scored
  └─ No clear signal      3   bill on-topic but different object

SCORED DECISIONS  n of m        (frozen rows excluded, shown separately)
AVERAGE SCORE     x.xx          (state the denominator alongside it)

COVERAGE CAVEAT
  Retrieval finds roughly half of relevant legislative actions. Absence of
  evidence here is not evidence the senator did nothing.
```

Lead with evidence, not the number. The traceability is the differentiator; a
single averaged score is the part every competitor already has.
