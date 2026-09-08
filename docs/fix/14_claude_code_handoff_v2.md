# Claude Code handoff v2 — Receipts query tool

**Supersedes `10_claude_code_handoff.md` (2026-09-05).** That doc is still correct for
items 1–7; this one records everything that changed between 09-05 and 09-07 and adds a
new layer (the verdict judge) that did not exist when it was written.

Read this whole file before changing code. Several changes are *behavioural contracts*,
not refactors — getting them subtly wrong reintroduces the false-positive class the whole
effort was meant to remove.

---

## 0. What the query tool is, restated

User types a statement (or picks one). The tool decides whether the senator's recorded
legislative behaviour is evidence that the statement was kept / consistent / broken /
inconsistent — or that no defensible reading is available. It shares the *same evaluation
logic* as the n8n pipeline. Port, don't re-implement.

The tool ships **evidence-first, no aggregate score.** That has not changed.

---

## 1. Scope classifier is now v1.1 — one rule changed

`prompts/scopeClassifier.v1.txt` → rename `v1_1`. Add this paragraph immediately after
"All OPERATIONAL statements are BOUNDED.":

> Naming a law, bill, or act makes a statement BOUNDED only when the speech_act is
> COMMITMENT or OPERATIONAL — a pledge to pass, vote on, fund, or block that specific
> vehicle, which resolves once that vehicle is decided. A POSITION that names a law
> ("the Inflation Reduction Act was written with families in mind", "I support H.R. 8")
> is an opinion about it, not a pledge to act on it, and stays STANDING. Opinions do not
> expire when the bill does.

**Why it matters:** without it, "I support the IRA" expired 730 days after it was said,
so a 2026 repeal vote could not be tested against it. Opinions don't expire; pledges about
a specific vehicle do.

Model tag in stored output: `claude-haiku-4-5 / scope-classifier-v1.1`.

Distribution on a 50-statement sample, for sanity-checking your port:
`POSITION 28 · OPERATIONAL 10 · COMMITMENT 9 · CREDIT_CLAIM 3`; `STANDING 34 · BOUNDED 16`;
`role_condition NONE 36 · MAJORITY_LEADER 14`; zero `UNKNOWN` valid_until; zero post-check
overrides (model and regex agreed on every row).

---

## 2. Scope data now exists for real — stop treating it as optional

The backfill has run for both senators. `evaluable_statements` (Sheets: `Evaluable
Statements - {politician_id}`) now carries, populated:

```
Speech Act · Scope · Valid Until · Anchor Entity · Role Condition
Scope Confidence · Scope Reasoning
```

Mirror these in Supabase on the statements table. The gates read them directly; where the
Sept-5 doc said "fail open when absent", that path is now the exception rather than the
norm. Keep the fail-open branch — a user-typed statement is classified live and can still
come back UNKNOWN — but the pipeline-sourced path should have real values.

---

## 3. New marker convention — `NA`, not `N/A`

Every absent value written by WF10a and WF10b is now the literal string **`NA`**.
Judgement columns that were deliberately not evaluated use **`NOT_EVALUATED`**.

That distinction is load-bearing and must survive the port:

| Marker | Meaning |
|---|---|
| `NA` | Factual column, nothing to carry (no vote cast, no bill on an omission row) |
| `NOT_EVALUATED` | We deliberately made no finding (gated row's `Bill Effect`, `Alignment Confidence`) |
| `NO_DATA` | Donor columns specifically: no donor records attached |

`NOT_EVALUATED` must never be replaced with a plausible value from the column's own
vocabulary. `NEUTRAL` in `Bill Effect` asserts "the bill does not move this promise",
which is a finding nobody made.

**Parsing note:** `Alignment Confidence` can legitimately hold the string `NOT_EVALUATED`.
Any numeric read of that column needs a guard. Older rows may still contain `N/A`;
accept both spellings on read, emit only `NA` on write.

---

## 4. New columns on the alignment row

WF10a now writes these to `Promise Alignment - Matches` on both the evaluator and gated
paths. Add them to `promise_alignments` in Supabase:

```
grade             text  -- judge queue/result; see §5
vote_governing    text  -- e.g. 'CLOTURE (60-vote threshold; split vote)'
vote_flags        text  -- ';'-joined: SPLIT_VOTE, FLOOR_LEADER
promise_date      text
gate_hits         text  -- ';'-joined 'gate:class'
senator_role      text  -- role at the action date
cloture_result    text  -- AGREED / REJECTED / ''
scope             text
valid_until       text
anchor_entity     text
role_condition    text
bill_class        text  -- BROAD_VEHICLE | REVERSAL | TARGETED
```

`vote_governing` and `vote_flags` are **disclosure fields**. When a split vote produced the
verdict, the UI must show both votes and say which governed. A row that reads "voted NAY →
BROKE" while hiding a cloture YEA is exactly the claim a senator's office knocks down.

---

## 5. NEW: the verdict judge layer (WF13)

This did not exist on 09-05. It is the largest addition.

### Concept

Every accusation gets a second opinion before it counts. WF10a marks accusations
`Grade = PENDING`; a separate pass judges them; only judged rows reach scoring.

```
WF10a writes Grade=PENDING on every BROKE/INCONSISTENT
              + a stable 10% sample of KEPT/CONSISTENT
   ↓
WF13: deterministic gates → Claude Sonnet adversarial judge
      → on FAIL: re-evaluate with the critique → judge again
   ↓
Grade becomes PASS | PASS_ON_RETRY | REVIEW_REQUIRED
              | REVIEW_REQUIRED_JUDGE_CORRECTED | GATED_* | JUDGE_ERROR
   ↓
WF11 refuses to score PENDING or REVIEW_REQUIRED
```

Source files: gates `fix/11_wf13_deterministic_gates.js`, judge system prompt
`fix/12_wf13_judge_system_prompt.md`, full workflow `fix/13_wf13_workflow_sdk.js`.

### The judge

Adversarial auditor, seven tests (T1 scope, T2 statement integrity, T3 vehicle validity,
T4 bill direction, T5 action reading, T6 confidence/disclosure, T7 reasoning fidelity).
Stops at the first FAIL. **A PASS is invalid without a `senator_counterargument`** — the
parser downgrades a counterargument-free PASS to FAIL/`UNDISCLOSED_CAVEAT`. Keep that.

### Anthropic API specifics — these cost real debugging time, don't rediscover them

- **`claude-sonnet-5` rejects `temperature`.** 400, "deprecated for this model". Send only
  `model`, `max_tokens`, `system`, `messages`.
- **`max_tokens: 1200` is not enough.** The model spent the whole budget on a thinking
  block, emitted no text, `stop_reason: max_tokens`. Use **8000**.
- **Response content can be thinking blocks.** Filter `type === 'text'`; if that yields
  nothing, it's an infrastructure failure.
- **Never let an empty response become a content verdict.** The first version wrote
  `FAIL / T7 / HALLUCINATED_LINK` for a response that said nothing — a fabricated
  accusation in the audit log. Empty/truncated → `grade: 'ERROR'`,
  `failure_class: 'JUDGE_NO_OUTPUT'`, leave the row's verdict untouched, keep
  `Grade = PENDING` so it is re-judged later.

### Retry invariant

The re-evaluation runs evaluator v7 plus a critique block. Its result is re-derived
through `deriveAlignment` and then checked:

> A retry may only move a verdict **away** from BROKE/INCONSISTENT, or lower confidence.
> Anything else is discarded and the original is retained.

An adversarial critique must never be able to *manufacture* an accusation. Port this
verbatim; it is the safety property of the whole retry design.

### Disposition semantics

| Grade | Meaning | Verdict written |
|---|---|---|
| `PASS` | Judge passed it first try | unchanged |
| `PASS_ON_RETRY` | Failed, re-evaluated, passed | retry's verdict, confidence capped 0.75 |
| `REVIEW_REQUIRED_JUDGE_CORRECTED` | Failed twice, judge supplied a correction | **judge's `corrected_verdict`**, accusations capped at 0.7, critique + counterargument appended to reasoning |
| `REVIEW_REQUIRED` | Failed twice, no correction offered | `NOT_DETERMINABLE` |
| `GATED_*` | Deterministic gate caught it pre-judge | gate's mapped verdict |
| `JUDGE_ERROR` | Judge produced no output | unchanged, stays PENDING |

The `REVIEW_REQUIRED_JUDGE_CORRECTED` case matters: the first implementation forced
`NOT_DETERMINABLE` on any double-fail, which threw away a correct judge verdict
(sjres7-119: judge said BROKE @ 0.7 with the counterargument attached, matching the hand
audit exactly, and the workflow overwrote it).

### Does the query tool need the judge?

Open design question, your call:

- **Argument for:** a user-typed statement gets no human review at all, so it arguably
  needs the second opinion *more* than a pipeline row.
- **Argument against:** it doubles latency and adds a Sonnet call per query.

Suggested middle path: run the **deterministic gates** inline always (they're free), and
invoke the LLM judge only when the derived verdict is BROKE/INCONSISTENT. That's the
minority of queries and it's exactly where the risk is.

### Audit log

`Verdict Audit Log` tab, one row per judge call, 29 columns — evaluator verdict, judge
grade, failed test, failure class, corrected verdict, senator counterargument, critique,
gold agreement, final disposition. This is the artefact you hand a journalist who asks
"how do you know". If the query tool judges, it should write the same shape.

---

## 6. Gold set join key

`wf10a_broke_gold_set.csv` has **no `Promise Alignment UID` column**. Join on
`promise_uid|bill_id` (79 unique pairs). `row_number` is invalidated by any requeue.

---

## 7. Omission logic changed (WF10b) — affects coverage reporting

Statements are excluded from the omission denominator when:

1. `Speech Act ∈ {OPERATIONAL, CREDIT_CLAIM, RHETORIC}` — scheduling remarks, credit
   claims and rhetoric cannot be broken by inaction. Counting them inflates the
   denominator with statements nobody made.
2. `Scope = BOUNDED` and `Valid Until` has passed — the window closed; absence of a match
   is a question about that window, not evidence of present inaction.

Fails open: no scope data → kept as a candidate, warning logged.

On the sample distribution that's ~26% of statements excluded as non-commitments alone.
If the query tool ever reports "N of M promises kept", it must use the same exclusions or
its denominator disagrees with the platform's.

Omission rows are `PENDING` (term active) or `UNFULFILLED` (term over, ≥ 2029-01-03), at
confidence 0.5/0.7 — never 1.0, because absence of a match is not absence of action
(measured P2B candidate coverage ≈ 57%).

---

## 8. Known-bad bill impacts

These six have inverted or wrong-text-version summaries. Until regenerated, any reading
built on them is unreliable — suppress or flag:

```
s208-118 · s997-118 · sjres71-119 · hr3746-118 · s3386-119 · hjres104-119
```

`s3386-119` is on the contested-direction list: the bill's direction *is* the partisan
dispute, so `CONTESTED → NOT_DETERMINABLE`.

---

## 9. Not built yet — do not assume these exist

- **Legislative Weight** (`BINDING` / `CONDITIONAL` / `SYMBOLIC`). Intended to catch
  shell bills — sense-of-Congress resolutions, authorizations without appropriations,
  study/report requirements. Design constraint already agreed: **weight scales magnitude,
  it never flips the verdict.** Co-sponsoring a symbolic resolution that matches a promise
  is keeping it, weakly.
- **Surprise-action evaluation.** WF10b writes `NO_PROMISE` rows for legislation matching
  no statement, but nothing evaluates them against party platform or prior positions yet.
- **`NOT_APPLICABLE_EXPIRED` / `NOT_APPLICABLE` labels in WF11** still collapse into a
  generic "Indeterminate Match" freeze. Functionally safe (score null, non-scorable) but
  the labels understate coverage.

---

## 10. Verbatim-port checklist

Copy these, don't paraphrase. Each keeps a comment pointing at its source file and date.

| Target | Source |
|---|---|
| `prompts/scopeClassifier.v1_1.txt` | `fix/01` + §1 above |
| `lib/scope/postCheck.ts` | `fix/01` |
| `lib/gates/preEvaluatorGates.ts` | `fix/03` |
| `lib/votes/partyAlignment.ts` | `fix/05` |
| `lib/verdict/deriveAlignment.ts` | `fix/06` |
| `prompts/evaluator.v7.txt` | `fix/07` |
| `lib/judge/deterministicGates.ts` | `fix/11` |
| `prompts/judge.v1.txt` | `fix/12` |

Behavioural contracts that must survive the port:

1. The model's `promise_alignment` is **never** the verdict. `deriveAlignment` decides;
   the model's answer is `modelVerdict`, kept only for agreement tracking.
2. Split vote → confidence ≤ 0.75, both votes named, `governing_vote` stated.
3. BROKE/INCONSISTENT below 0.7 → the counterargument must be present or the reading is
   withheld.
4. Retry may only move away from an accusation or lower confidence.
5. Judge infrastructure failure is never a content verdict.
6. `NOT_EVALUATED` is never replaced with a value from the column's own vocabulary.
