# Pipeline reconciliation log

The modules under `packages/server/src/scoring/` and `embeddings/` are
**transcriptions of live n8n nodes**, not independent implementations (ADR-010,
reconstructed in `docs/adr/README.md` — the original ADR files were never in this repo).
They therefore need re-reading whenever the pipeline moves. This file records
what was checked, when, and what turned up — so the next person can tell a
deliberate difference from a drift.

Specs live in `docs/specs/`. Where a spec and a live node disagree, **the node
wins** and the disagreement is recorded here.

---

## 2026-08-17

**WF11 changed on 2026-08-14, a day after the first port.** Two real changes,
both now in `scoring/decisionScore.ts`:

- The **null contract** is implemented. Frozen rows write `decision_score: null`
  + `scorable: false`; scored rows carry `scorable: true`. The 2026-08-13 node
  wrote `0.0` and had no `scorable` field. This matters more than it looks:
  "frozen rows scored 0.0 → enter the mean as real zeros" is on the status
  legend's own list of silent-success shapes.
- A **`PROCEDURAL` party-alignment branch**, falling back to `WITH_PARTY` with a
  `PARTY_PROCEDURAL_SWITCH` flag when the two procedural-switch detections
  disagree.

**The relevance system prompt is extracted, not transcribed.**
`tools/extract-relevance-prompt.mjs` pulls it from W7b's `Build Eval Request`
and asserts its length at **13,740 characters**, failing the build if it moves.
Verified static: zero `${}` interpolations, zero escaped backticks. Request
params confirmed against the node — `gpt-5.4-mini` on `/v1/responses`,
`reasoning.effort: low`, `top_p: 0.98`, `store: true`,
`prompt_cache_key: match-eval-v3`.

**The two promise-embedding templates are both correct — template follows
namespace.** This looked like a contradiction and is not:

| | `Build Promise Embedding Text` (v6) | W7a `Promise Embedding Text` |
|---|---|---|
| Serves | `{pid}_statements` | `{pid}_bills` |
| Line 1 | `Statement:` | `Promise:` |
| Line 2 | `Statement Type:` | *(absent)* |
| Taxonomy line | `Taxonomy Keywords:` | `Related Terms:` |
| Unconditional lines | 6 | 5 |

`embeddings/promiseEmbeddingText.ts` ports **W7a's**, because the query searches
bills and because the 0.575 threshold was calibrated in W7a's
`Parse and Store Matches` against queries built with that builder. A provenance
lookup against `_statements` would need the v6 builder — a second function, not
an edit to this one.

**Field provenance, previously conflated here:**

- `Key Policy Terms` is **per-statement classifier output**. WF3 writes
  `keyTerms.join(', ')`, or the literal `'NA'` when empty. The `', '` separator
  is confirmed, not assumed.
- `Taxonomy Keywords` / `Related Terms` is the **only** field from the Approved
  Taxonomy sheet (gid `1287072268`), keyed on (Primary Issue, Sub Issue). It is
  read as an **opaque cell string** and dropped into the embedded text
  unchanged. `taxonomy.json` therefore stores cells verbatim; splitting and
  re-joining would substitute our separator for the sheet's and move the vector.
- `Reasoning` also falls back to `'NA'`. Both lines are always present in corpus
  vectors, so omitting them on a sparse query would make the query document two
  lines shorter than everything it is compared against.

**`billOutcome` corrected against the 08-16 status legend:**

- `REPORTED` and `REFERRED` are **different states** — the first cleared
  committee, the second never left. They were previously collapsed into one
  bucket, which lost exactly the "he tried and the chamber didn't act"
  distinction the module exists to make.
- Terminality is narrower than "not FAIL": only `ENACTED*` and `VETOED*` are
  terminal. `FAIL:*` can return under a motion to reconsider.
- `Status Changed At` sentinels are `No Change` (checked, unmoved) and
  `Unverified` (fetch failed) — plus `Unknown` where the payload had no
  `status_at`. None is a date. Rendering one as a date produced
  "verified Unknown", which asserts a verification that never happened.

**`deriveAlignment` now requires `statementType`.** WF10A defaults it to
`'Campaign Promise'`, which is safe there because the sheet column is always
populated. Here the input is arbitrary user text with no provenance, so a
default would silently give every free-typed query the promise vocabulary and
print "BROKE" against a commitment we have no evidence was ever made.

---

## 2026-08-13

The verdict table is **two-factor** (`bill effect × support`) with **no stance
term**, and there is **no CRA detection code** anywhere in the pipeline. Both
were asserted by the written spec and are wrong; both are now guarded by tests
in `scoring/score.test.ts`. Re-applying stance measured 0% error on ADVANCE and
25% on HINDER — the asymmetry is why it survived review, since an "In Favor"
stance multiplies by +1 and the wrong formula agrees with the right one on every
example anyone happened to check.

---

## Still unverified

- **`embedding_version`** — currently `run-2026-08-08-10650`. It is also the
  `run_id` join key, so a stale constant returns zero vectors *and* makes every
  promise look unevaluated. Config value with an assertion on result count,
  never a hard-code.
- **Typed vote fields in bill vectors** — `cloture_vote` / `passage_vote` may
  read `'NA'` throughout. If so the eight-pattern narrative collapses to
  `PASSAGE_ONLY`.
- **`HIGH_AVG_STRENGTH` (0.65)** — a Receipts-only presentation constant with no
  pipeline equivalent. Not calibrated.
- **Provenance-lookup threshold** — must NOT reuse 0.575. That was calibrated on
  promise→bill (cross-template) similarity; provenance is promise→promise
  (same-template), where unrelated statements already share the scaffolding and
  score systematically higher.

---

## 2026-08-19 — full-repo audit against live nodes

Audit of the modules never independently checked in this planning line
(`score.ts`, `votePattern.ts`, `orchestrator/loop.ts`, `orchestrator/dispatch.ts`,
`data/PineconeActionStore.ts`, `llm/stub.ts`), plus a re-read of every port whose
source node has moved since it was last reconciled.

### Ports re-verified against the live node — all still faithful

| Module | Live node | Result |
|---|---|---|
| `scoring/decisionScore.ts` | WF11 `Compute Decision Score` | weights, thresholds, modifier logic, arithmetic order and clamps **identical** |
| `scoring/votePattern.ts` | WF11 (same node) | multiplier table, pattern classification, tier precedence, abstention detector **identical** |
| `evaluation/gates.ts` | WF10A `Enrich With Statement Type` | two gates, same sets, fail-open on blank — **confirmed** |
| `embeddings/promiseEmbeddingText.ts` | W7A `Promise Embedding Text` | line order, `Sub-Issue:` hyphen, `\n\n` join, conditional `Related Terms` — **match** |
| `scoring/config.ts` SIMILARITY | W7A `Parse and Store Matches` | `STRONG 0.575` / `WEAK 0.50` — **match** |
| `evaluation/relevancePrompt.ts` | W7B `Build Eval Request` | **byte-identical**, 13,740 chars; params (`gpt-5.4-mini`, `/v1/responses`, `reasoning.effort low`, `top_p 0.98`, `store true`, `prompt_cache_key match-eval-v3`) all match |

**Three source workflows moved after their last reconciliation date; none
changed scoring semantics.**

- **WF11 (`toxQrXxgx8QNvXoc`)** — updatedAt `2026-08-18T05:38`, after the
  08-16 reconciliation. Diffed version `0ef3c9cc` (08-14) against current
  `1e42a597`: the only change is node `Limit1`, `maxItems` **50 → 25**. A batch
  throttle. `Compute Decision Score` is byte-identical across the two versions.
  The port header's "node last updated 2026-08-14" is now stale as a *date* but
  correct as a *claim about the logic*.
- **W7A (`UOpu690tosAwbvMB`)** — updatedAt `2026-08-18T01:14`. Embedding
  template and both thresholds unchanged.
- **WF10A (`BuA0XMoRIeA8K-IziChwR`)** — updatedAt `2026-08-17T22:44`. Gate sets
  unchanged.

### Modules with no live-node counterpart (audit request was mis-scoped)

The handoff asks for each flagged module to be "reconciled against its live n8n
node." Four have no such node, by design, and reconciling them is not a
meaningful operation:

- `orchestrator/loop.ts`, `orchestrator/dispatch.ts` — app-native agentic loop.
  n8n is explicitly not in the request path. Verified: no n8n/webhook call
  anywhere in `packages/server/src` outside one comment in `QueueStore.ts`.
- `llm/stub.ts` — DEMO-mode stubs. Honest: labelled, and the UI states that
  interpretation/explanation are canned when they run.
- `scoring/score.ts` — Receipts-native gate/band presentation layer. Its one
  pipeline-derived input is `SIMILARITY` (verified above); `HIGH_AVG_STRENGTH`
  remains a Receipts-only uncalibrated constant, as already recorded.

`data/PineconeActionStore.ts` reviewed on its own terms: failures surface as
`UPSTREAM_UNAVAILABLE`, never as an empty result set — no silent-success path.
The `embedding_version` result-count assertion is still **absent** (it is item 3
work); today `embeddingVersion` is opt-in and unset, so a stale value set later
would read as "no relevant bills".

### NEW — SIXTH CORRECTION: `taxonomy.json` is fabricated, not partial

The handoff and the file's own `_provenance` describe `taxonomy.json` as a
**partial snapshot** whose cells are stored **verbatim**. Both are wrong.

Checked all 6 rows against Matt's Approved Taxonomy CSV export (121 data rows,
23 primary issues, no blank Primary/Sub Issue):

**0 of 6 (primary_issue, sub_issue) keys exist in the approved taxonomy.**

| `taxonomy.json` row | Status in Approved Taxonomy |
|---|---|
| Healthcare / Prescription Drugs | primary is **`Health Care`**, not `Healthcare`; keywords also differ |
| Healthcare / Medicare and Medicaid | approved sub-issue is **`Medicare / Medicaid`** |
| Gun Policy / Background Checks | no `Gun Policy` primary; approved is **Crime & Public Safety / Guns / Gun Control** |
| Environment / Air Quality | approved is **Environment / Pollution & Clean Air/Water** |
| Education / Student Loans | approved is **Education / Student Loans / College Affordability** |
| Infrastructure / Broadband | no `Infrastructure` primary; approved is **Technology / Broadband & Infrastructure** |

The keyword cells diverge too — e.g. the Prescription Drugs row stores
`"prescription drug prices, drug pricing, insulin, copay cap, Medicare
negotiation, ..."` where the sheet has `"prescription drugs, drug prices,
pharmaceutical, medication, drug costs, pharmacy, ..."`. So the "stored
VERBATIM" claim is false: these cells were composed, not exported.

**Blast radius — this is wider than item 1's framing.** The table is not inert
demo data; it feeds the model-callable surface:

- `orchestrator/toolDefs.ts` → `primaryIssues()` renders the
  `interpret_promise.primary_issue` description. The model is currently offered
  a menu containing `Healthcare`, `Gun Policy` and `Infrastructure` — none of
  which exist in the corpus, so any classification onto them can never match a
  stored vector.
- `orchestrator/prompts.ts` → `formatTaxonomyForPrompt()` — same invented menu.
- `orchestrator/dispatch.ts` → `isValidCombination()` validates against the
  fabricated table.
- `llm/stub.ts` reads the rows directly for demo interpretation.

**Sequencing consequence for item 1.** Regenerating is not a drop-in:

- `embeddings/promiseEmbeddingText.test.ts` asserts
  `lookupTaxonomyKeywords('Healthcare', 'Prescription Drugs')` returns
  `found: true`, and uses `primary_issue: 'Healthcare'` in built-text
  assertions. `scoring/score.test.ts` likewise.
- `data/fixtures/actions.ts` is keyed on `Healthcare`, `Gun Policy`,
  `Air Quality`. Item 3 is specified to build and test **on fixtures**; those
  fixtures currently describe issue pairs that do not exist.

So regenerating `taxonomy.json` must land together with a fixture + test
migration onto real (Primary Issue, Sub Issue) pairs.

**Correction (same day):** the first draft of this entry said the export alone
"turns 71 green tests red". That was an overstatement. Exactly **three**
assertions break, all in `promiseEmbeddingText.test.ts` — the two that call
`lookupTaxonomyKeywords('Healthcare', 'Prescription Drugs')` and the
case-insensitivity test on `'  healthcare '`. The template tests pass
`taxonomy_keywords` inline as a literal and never consult the table, so they
survive regeneration untouched; they merely *display* an invented pair. The
fixture corpus is the real exposure: it is keyed on pairs that do not exist.

### Repo-vs-handoff contradictions (not code drift)

- **Git was already initialised.** The handoff's setup action A ("the repo is
  6,740 lines of verified work with no version control") is false: commit
  `1d19841 baseline before query-tool planning` already exists, the tree is
  clean, and `.gitignore` already excludes `.env`, `node_modules/`, `dist/`
  (plus `.env.local`, `.data/`, `*.tsbuildinfo`, `.DS_Store`). Only
  `.env.example` is tracked; no secrets in history. A second baseline commit was
  not possible and was not created. Line count is also off: 7,578 tracked
  TS/TSX/MJS lines, 10,291 excluding `package-lock.json`.
- **`docs/THREAD_HANDOFF.md` does not exist in the repo.** The handoff was
  supplied out-of-band from `~/Downloads`. Worth committing if it is meant to be
  the durable entry point.
- **Dangling references — RESOLVED 2026-08-19, see below.** Code and this log cite `SCORING_REFERENCE.md`,
  `ADR-010` and `ADR-011`, none of which exist in the repo
  (`deriveAlignment.ts:12`, `scoring/config.ts:12`, `votePattern.ts:107`,
  and this file's header). The "method spec" citations do resolve, to
  `docs/specs/wf10a-wf11-method-spec.md`.

### Minor port drift — receipt fields on frozen rows (`decisionScore.ts`)

Not a scoring difference; the null contract holds identically
(`decision_score: null`, `scorable: false`). But the receipt shape differs:

| Field on a frozen row | Live WF11 | Port |
|---|---|---|
| `base_score` | `0.0` | `null` |
| `action_tier` | overwritten to `PROCEDURAL` / `NONE` | passes the caller's tier through |
| `vote_pattern` | recomputed from cloture/passage | passes the caller's value through |
| `effective_vote`, `computed_by` | present | absent |

Left as-is pending a decision: the port's `null` base_score is arguably the
better contract (it matches `decision_score`), but it is a deliberate difference
from the node and should be recorded as one rather than discovered later.

Also noted: WF11 forces `pattern = 'NO_FLOOR_ACTION'` on the ABSTAIN / SPONSOR /
CO_SPONSOR tiers, which the port does not. Verified equivalent — a non-VOTED
tier implies no directional cloture/passage vote, so `votePattern()` already
returns `NO_FLOOR_ACTION` on exactly those rows.


---

## 2026-08-19 — dangling citations resolved

The dangling-reference finding above understated the problem. A full sweep found
**six** cited ADRs, not two — `ADR-004`, `ADR-005`, `ADR-008`, `ADR-009`,
`ADR-010`, `ADR-011` — plus two sections of `SCORING_REFERENCE.md`. No `adr/`
directory and no ADR file of any name exists anywhere in the tree.

`docs/adr/README.md` now reconstructs all six **from their citation sites** —
i.e. from what the code asserts each decision was — and is explicitly labelled
as reconstruction, not recovery. The alternatives weighed and the evidence
behind each choice are lost and are marked as such rather than guessed at.

`SCORING_REFERENCE.md` splits:

- **§3 (alignment table) — superseded.** The same table, including the
  no-double-stance rule, is in `docs/specs/wf10a-wf11-method-spec.md` §6.
  `deriveAlignment.ts` now cites that.
- **§5 (confidence bands) — LOST.** The method spec does not mention bands
  anywhere; they are a Receipts presentation-layer invention. The substance
  survives only inline in `scoring/config.ts` and `score.ts`'s `bandFor()`.

Every citation in code, `README.md` and this log now resolves to a file that
exists, or says in place that the target does not exist. 71 tests still pass.

### Unrelated finding while tracing citations: an unimplemented penalty

`packages/shared/src/index.ts:17` documents that `StatementType` "carries a
−0.1 confidence penalty for the weaker commitment standard", and the method
spec §6 asserts the same for Policy Positions.

**No such penalty is implemented** — not in `deriveAlignment.ts` (which only
swaps the verdict vocabulary), not in `score.ts`, not in `decisionScore.ts`. Nor
does live WF10A apply one: it reads `alignment_confidence` straight from the
evaluator with no statement-type adjustment.

Not fixed. Following the rule that the node wins over the spec, the likely
reading is that the spec is wrong for a sixth time and the doc comment
inherited it — but "the penalty was dropped deliberately" and "the penalty was
never built" are indistinguishable from here, and the difference decides whether
the fix is to the code or to the comment. Flagged for Matt.


---

## 2026-08-19 — item 1 complete: taxonomy regenerated from the approved sheet

`tools/export-taxonomy.mjs` is committed as a **standing tool**, and
`packages/server/src/embeddings/taxonomy.json` is **generated, never edited**
from here on. Any change to the Approved Taxonomy sheet is applied by re-running
the exporter against a fresh CSV export — never by editing the JSON. A hand-edit
is invisible in review and silently moves every query vector touching that row.

    node tools/export-taxonomy.mjs <path-to-approved-taxonomy.csv>

**What it enforces.** Real headers read by name, never by position. Blank
Primary or Sub Issue is a hard failure with the CSV line number, never a skipped
row — a silently dropped row becomes a runtime taxonomy miss with no signal.
Duplicate (Primary Issue, Sub Issue) is a hard failure, because the lookup is
keyed on that pair and a duplicate would silently shadow one cell. `row_count`
is asserted before write and re-asserted after reading the file back, so a
serialisation fault cannot pass as success.

**Verbatim, and why it needed a real parser.** Keyword cells are written with no
split, trim, normalise or re-join. Four approved cells legitimately contain
**embedded newlines** (Human Trafficking & Exploitation; Medical Liability /
Tort Reform; Health Workforce & Provider Capacity; Tenant Rights & Evictions),
so the tool carries an RFC4180 parser rather than splitting on `,` and `\n`.
Verified after generation: **121/121 cells round-trip byte-for-byte** against
the CSV, all four multi-line cells intact. One legitimately blank cell
(`Other / Needs Context`) is preserved as `""` rather than treated as an error.

**Result.** 121 rows, 23 primary issues, `status: "COMPLETE:2026-08-19"`,
gid `1287072268`. `TAXONOMY_IS_COMPLETE` now evaluates **true**, which retires
the partial-snapshot warning in `index.ts` automatically.

### The fabricated pairs, and where they went

All six prior rows were invented; none existed in the approved sheet. Migrated
onto pairs sourced by exact lookup from Matt's CSV export and confirmed by him
before rewriting:

| Fabricated | Approved |
|---|---|
| Healthcare / Prescription Drugs | **Health Care / Prescription Drugs** |
| Healthcare / Medicare and Medicaid | **Health Care / Medicare / Medicaid** |
| Gun Policy / Background Checks | **Crime & Public Safety / Guns / Gun Control** |
| Environment / Air Quality | **Environment / Pollution & Clean Air/Water** |
| Education / Student Loans | **Education / Student Loans / College Affordability** |
| Infrastructure / Broadband | **Technology / Broadband & Infrastructure** |

The last was the only genuine judgement call: the fixture is the IIJA, which
would also fit `Budget & Economy / Transportation & Infrastructure`, but that
fixture's summary and mechanisms are specifically broadband (BEAD formula
grants, rural unserved areas), matching the Technology cell. Confirmed with Matt
rather than decided here.

**Migrated:** 8 fixture entries in `data/fixtures/actions.ts`; 3 real assertions
plus 4 cosmetic sites in `promiseEmbeddingText.test.ts`; 1 cosmetic site in
`score.test.ts`. The deliberately-absent synthetic pairs (`'A'/'B'`,
`'Astrophysics'/'Dark Matter'`, `''`) were left alone — they exist to prove a
taxonomy miss surfaces rather than fabricates, and belong outside the table.

71 tests pass; `npm run typecheck` clean.

### Still outstanding

`interpret_promise` now offers the model all 23 real primary issues instead of
five invented ones, so the tool surface is no longer advertising issues absent
from the corpus. Not yet verified: that classifications onto these pairs
actually retrieve — that needs Pinecone creds and is part of item 3's
`embedding_version` result-count assertion.

**Recommended, not built:** the handoff proposes a CI check running the exporter's
row-count assertion plus the full suite on every push, to turn
"don't hand-edit taxonomy.json" from a note into something enforced — the same
enforce-don't-remember principle as the 13,740-char prompt assertion. There is
no remote configured, so this is a note for whenever the repo goes to GitHub.

---

## 2026-08-19 (later) — WF11 policy-position split, port re-reconciled

WF11 changed again: version `8ce52983`, updatedAt `2026-08-19T23:39`. Verified
against the live node rather than against the change description.

### The change, confirmed

**Policy positions now score.** Previously the node recognised only
`KEPT`/`BROKE`, so every `CONSISTENT`/`INCONSISTENT` row fell through the
directional guard and froze to `decision_score: null`. The node now normalises
`CONSISTENT→KEPT` and `INCONSISTENT→BROKE` **for control flow only**, then
re-splits on `Statement Type` to four new base tables — `BASE_VOTED_POSITION`,
`BASE_SPONSOR_POSITION`, `BASE_COSPONSOR_POSITION`, `BASE_ABSTAIN_POSITION` —
so positions score on their own scale. Positive side ≈0.85× the promise band;
negative side compressed further toward zero, because a broken promise is a
betrayal and a contradicted position is an inconsistency. That asymmetry is why
they are separate tables and not a scaled copy. **Seeded v1, explicitly
unsigned in the node — not final.**

Two new fields per row, `statement_type` and `index_bucket` (`TRUST` for
promises, `CONSISTENCY` for positions), keep the two indices separable.
**Campaign-promise verdicts and scoring math are unchanged** — verified, and now
guarded by a test asserting the method spec worked example still returns
`base 0.9 → 1.0925`.

`Log Complete (Score)` and `Log Skipped (Score)` have `retryOnFail` enabled
(also `Add Scores`, which the change note did not mention).

### Port updated — `scoring/decisionScore.ts`

All four position tables transcribed and verified numerically identical to the
node. Normalisation, tier routing and both new output fields ported. 80 tests
pass (was 71), typecheck clean.

**Why this drift mattered more here than upstream.** `computeDecisionScore` is
currently called only by its own test — nothing in the request path. But
`dispatch.ts` defaults free-typed queries to `'Policy Position'`, and
`deriveAlignment` therefore returns `CONSISTENT`/`INCONSISTENT` for essentially
every query the tool answers. Under the pre-change semantics, wiring the scorer
in would have frozen **every** query to `decision_score: null` — not the 15-of-25
seen upstream, but effectively all of them. The dormant port was carrying a
latent total failure for its own primary use case.

**One deliberate divergence, same class as `deriveAlignment`'s.**
`DecisionScoreInput.statement_type` is **required**, where the node defaults an
unlabelled row to `Campaign Promise`. That default is safe upstream, where the
sheet column is reliably populated. Here a silent `Campaign Promise` default
would both score on the promise scale and file the row under `TRUST` — the exact
blending of the two indices the split exists to prevent. Given the same
statement type the port returns identical numbers; requiring the caller to
supply it changes no value, it only refuses to guess.

### Findings to apply upstream — n8n is read-only here, reporting only

1. **`Compute Decision Score`: the `VERDICT_WITHOUT_ACTION` branch omits both
   new fields.** Of the three `out.push` sites, the freeze branch and the scored
   branch carry `statement_type` and `index_bucket`; the middle branch
   (`outcome_label: 'Indeterminate Match'`, flag `VERDICT_WITHOUT_ACTION`) does
   not. `Parse LLM response` then applies `|| 'Campaign Promise'` and
   `|| 'TRUST'`, so a **policy-position row hitting that branch is written to the
   sheet as a Campaign Promise in the TRUST bucket**. The row is frozen, so no
   mean moves — but it is misfiled in the audit trail, which is precisely what
   the bucket field exists to prevent. Inconsistent with the other two branches
   in the same edit, so an oversight rather than a decision. The port carries the
   fields on all frozen rows and has a regression test pinning that.

2. **The `|| 'Campaign Promise'` / `|| 'TRUST'` defaults in `Parse LLM response`
   fail toward the stronger claim.** A row that arrives unlabelled is filed as a
   promise in the trust index. Failing toward `Policy Position`/`CONSISTENCY`
   would be the conservative direction, matching this repo's rule that promise
   vocabulary is earned rather than assumed. Flagged as a design question, not
   applied.

### Change-note corrections (bookkeeping, not behaviour)

- **Item 4 is already live.** The note says `Parse LLM response` is "paste-ready,
  not yet applied" and awaiting a manual paste. The live node carries
  `statement_type`, `index_bucket` and `scorable` in all three `results.push`
  branches. Applied at `2026-08-19T23:39`, presumably after the note was written.
- **`Add Scores` went 64 → 66 mapped columns, not 65 → 67, and two columns were
  added rather than three.** `Statement Type` and `Index Bucket` are new;
  `Scorable` already existed and had its expression changed from
  `{{ $json.scorable }}` to `{{ String($json.scorable) }}`. The substance of the
  change — three columns now correct, `false` rendering instead of blank — holds.
- The note's claim that `.item` pairs rows correctly was not re-verified here;
  it concerns pipeline row pairing with no port counterpart.

---

## 2026-08-19 (later still) — WF11 re-pull, fallback direction, item 2

### Re-pull: the two WF11 fixes are NOT published

Asked to reconcile against a newly published WF11 carrying both fixes. Re-pulled
and found **no new version**. The workflow is still at `8ce52983`
(`2026-08-19T23:39:44`), and `versionId === activeVersionId`, so the published
version is the one already diffed. Version history shows nothing after it.

Neither fix is present in the live node:

- `Compute Decision Score` — the `VERDICT_WITHOUT_ACTION` push still omits both
  `statement_type` and `index_bucket`.
- `Parse LLM response` — all three branches still read
  `|| 'Campaign Promise'` and `|| 'TRUST'`.

The diagnosis was right: the reported line numbers **295 / 371 / 494** match this
version's three `out.push(` sites exactly, so the correct branch was found. Only
the write did not land — an unsaved editor buffer, or a publish that did not
commit. Re-apply and re-publish, then this section gets a follow-up.

No app change is pending either way — the port already emits both fields on all
frozen rows and already requires `statement_type`.

### Decision recorded: why the port and the node point opposite ways

The port requires `statement_type`; the node defaults an unlabelled row to
`Campaign Promise`; the sheet-write fallback (once published) will default to
`Policy Position` / `CONSISTENCY`. These are not in conflict — they sit at three
different points and protect three different things:

| Layer | Behaviour | What it protects |
|---|---|---|
| Node — `isPosition` default | unlabelled → `Campaign Promise` | A blank must not silently **down-weight a real promise's score**. Upstream the column is reliably populated, so a blank means "lookup glitch", not "this is a position". |
| Sheet write — `Parse LLM response` fallback | unlabelled → `Policy Position` / `CONSISTENCY` | Last line before a **misfile**. Past the scorer, a blank means a field was lost in transit; filing it as a promise in TRUST overstates a commitment, and that is the more damaging error. |
| Port — required argument | refuses to guess | The caller is arbitrary user text with no provenance. Either default would be an invention, and a wrong guess here prints promise vocabulary against an unmade commitment. |

Read as one rule: **guess toward the stronger claim only where a blank is
evidence of a glitch, guess toward the weaker claim where a blank is evidence of
loss, and refuse to guess where a blank is evidence of nothing.** The port sits
in the third case, which is why it is the only layer with no default at all.

### Change-note corrections — both confirmed, both stand

Item 4 was already live at `23:39` rather than pending, and `Add Scores` went
64 → 66 with two columns added (`Scorable` pre-existed; only its expression
changed to `String($json.scorable)`). Confirmed against the node.

---

## 2026-08-19 — item 2: model config split three ways

`config.anthropic.model` is replaced by `config.models`, deliberately not
single-vendor:

| Job | Config | Default | Env override | Basis |
|---|---|---|---|---|
| `interpret_promise` | `models.classify` | `claude-haiku-4-5` | `CLASSIFY_MODEL` | **PROVISIONAL** — parity owed vs GPT-4.1 corpus labels |
| `bill_effect` | `models.fulfill` | `gpt-5.4-mini` | `FULFILL_MODEL` | matches live WF10A; keeps the ~30k prompt with its model |
| `explain_result` | `models.explain` | `claude-sonnet-5` | `EXPLAIN_MODEL` | no corpus parity tie — free choice |

`classify` is env-overridable specifically so the 12-row parity check can swap
it without a code change. That check remains credential-blocked, and the default
is marked provisional in the code rather than presented as settled: parity is
owed against **GPT-4.1**, which produced the stored labels, not against Haiku.

**Honest limit, stated in code and in the startup banner.** The orchestrator runs
**one** conversation with **one** model across every tool call, so setting
`classify` does not currently route `interpret_promise` anywhere new. Only
`explain` is on the request path today; `classify` and `fulfill` are configured
but unrouted until item 3 splits the calls. `describeModels()` prints both the
configured set and what is actually wired, because a configured-but-unrouted
model would let someone run the parity check against a model that never saw the
request and read the resulting agreement as confirmation.

### `maxTokens` headroom — the condition on closing item 2

Verified against the current Claude API reference rather than from memory:
`claude-sonnet-5` is 1M context with a **128K** output cap, and adaptive thinking
is the only on-mode — **its tokens count against `max_tokens`**.

The handoff's framing ("Sonnet 5 uses a newer tokenizer, ~30% more tokens —
confirm maxTokens leaves headroom") pointed at the right risk but the wrong
mechanism, and sizing alone was never the real guard:

- **Sizing.** `maxTokens` was `8000` on a loop that always streams. Streaming
  removes the HTTP-timeout argument for a small ceiling, and the turn budget is
  shared between adaptive thinking, tool-call blocks, and the visible prose.
  Raised to **64000** — the documented streaming default, and well inside
  Sonnet 5's 128K cap. `max_tokens` is a ceiling, not a spend: billing is on
  tokens generated, so headroom costs nothing and truncation costs the answer.
- **The actual truncation path, now closed.** `orchestrator/loop.ts` checked
  `stop_reason` for `'refusal'` and `'tool_use'` only. A `'max_tokens'` stop fell
  through the `!== 'tool_use'` break and the **truncated turn was rendered as a
  finished answer**. That is the mechanism by which `explain_result` silently
  truncates — and no amount of headroom removes it, it only makes it rarer. The
  loop now surfaces a recoverable error carrying the ceiling and model, and shows
  nothing partial.

**Still credential-blocked, not estimated here:** the exact token multiplier for
this prompt under Sonnet 5's tokenizer. That wants a real
`messages.count_tokens` call against the actual system prompt and tool
definitions — the documented method, and the reason no ~30% figure is asserted
in the code. It is a sizing refinement, not a correctness gate: the truncation
guard is what makes a bad estimate visible instead of silent.

### Correction applied: the −0.1 Policy Position penalty never existed

`packages/shared/src/index.ts` claimed `StatementType` "carries a −0.1
confidence penalty for the weaker commitment standard", echoing method spec §6.
Verified against live WF10A: `statementType` only picks the label pair, and
`alignment_confidence` passes through untouched. Nothing in the pipeline or this
repo ever implemented it.

**Removed rather than built** — the sixth case of the spec asserting behaviour
the live node does not have. The comment now records what the field actually
does, including its new role selecting the base table and index bucket.

---

## 2026-08-19 — item 3: evaluation wired into the loop

### SEVENTH CORRECTION — the −0.1 penalty is real, and I removed it wrongly

Earlier today this log recorded the −0.1 Policy Position confidence penalty as
"asserted by the spec, never implemented", and the claim was deleted from
`shared/index.ts`. **That was wrong, and the claim is restored.**

The penalty is real. It lives in WF10A's `Promise Alignment Evaluator` **system
prompt**, which instructs it three separate times —

> "Apply a -0.1 confidence penalty relative to what you would assign for an
> equivalent Campaign Promise, reflecting the weaker commitment standard"

— and states as a hard rule: **"NEVER: … Use confidence 0.9 or above for Policy
Positions."** The node's user template repeats it.

Both verifications that concluded otherwise were correct about what they
checked: `statementType` really does only pick the label pair, and
`alignment_confidence` really does pass through the parse untouched. The
mechanism is simply **upstream of the code** — it is applied by the model, per
the prompt. Checking `.jsCode` on every node finds nothing, because this node is
an `openAi` node whose logic is prose in `parameters.responses.values[0]`.

**The generalisable lesson: "verified against the live node" must include the
node's prompts.** For LLM nodes the prompt *is* the implementation. Six of the
seven corrections in this log were found by reading node code; this one was
invisible to that method and only surfaced when the prompt was extracted.

**Do not now implement it in code** — that would double-apply it, the same class
of bug as re-applying stance in `deriveAlignment`. Downstream consequence,
apparently deliberate: `computeDecisionScore` awards `CONFIDENCE_HIGH` (+0.05) at
`>= 0.9`, and the prompt forbids `>= 0.9` for positions, so a Policy Position can
never earn that modifier.

### Fulfillment prompt extracted — a second standing tool

`tools/extract-fulfillment-prompt.mjs` generates
`evaluation/fulfillmentPrompt.ts` from WF10A `Promise Alignment Evaluator`,
asserting the system prompt at **32,507 characters** and the user template at
**3,222**. Same enforce-don't-remember contract as the relevance extractor.

The generator also refuses to run if the system message is an n8n expression or
contains `{{ }}` — a prompt that depends on runtime data cannot be copied
verbatim without silently diverging from what the node sends. Verified static.
The user template *is* an expression, so it is hand-ported in `fulfillment.ts`;
its length assertion exists to force a re-read of that port when it changes.
Live node model confirmed `gpt-5.4-mini`, matching `config.models.fulfill`.

### Wiring

**Relevance, inside `search_actions`** — runs before the model sees anything, so
the model never judges effect on a bill the evidence gate would have excluded.
The response now reports `retrieved`, `excluded` (by reason) and `count`
separately: "10 retrieved, 0 admitted" is a different claim from "0 retrieved",
and an empty admitted set must never be narrated as "no legislative activity".

**Fulfillment, behind `score_matches`** — `bill_effect` is now decided by
`gpt-5.4-mini` on the 32,507-char prompt, not by the orchestrating model.

> ⚠ **This is an architectural change worth review.** `toolDefs.ts` documents
> that "the model supplies … per-bill effects", and it still does — but those
> effects are now a **cross-check**, not the source of truth. Where the
> orchestrator and the evaluator disagree, the evaluator governs and the
> disagreement is returned in `effect_disagreements` rather than silently
> resolved. The rationale is the handoff's own: the corpus was scored by that
> model on that prompt, and this is the axis where disagreement is most damaging
> because it picks ADVANCE/HINDER and the verdict follows directly. Two models
> judging effect is how the query tool and the trust report end up printing
> different answers for the same senator on the same bill. Flagged rather than
> assumed settled.

An evaluator ERROR stays ERROR and does **not** collapse to NEUTRAL. NEUTRAL is
a finding ("this bill does not bear on the goal"); ERROR is the absence of one.

### The four assertions, carried forward and now tested

| Assertion | Where | Test |
|---|---|---|
| `/v1/responses` reasoning-item trap | `normalizeRelevanceResponse` — finds the message by `type`, never index 0 | fixtures deliberately put the reasoning item at index 0, so an index-0 regression fails |
| unknown verdict → ERROR | relevance and fulfillment parsers | unknown `bill_effect` must not coerce to NEUTRAL |
| admitted ≤ candidates | `searchActions`, hard-fails the tool call | gate returns ≤ input; all-excluded stays distinguishable from empty |
| `embedding_version` result count | `PineconeActionStore` | zero vectors **under an explicit version pin** now fails as a probable stale pin rather than answering "no relevant bills" |

97 tests pass (was 80), typecheck clean.

### Credentials, and what is still NOT routed

Both legs are dependency-injected on a fetcher, so the whole path is testable on
fixtures with no key. `liveResponsesFetcher` throws `MissingCredentialError`
rather than returning an empty envelope, and the fixture fetcher throws on an
unknown candidate rather than answering for it — a fixture gap must not look
like an evaluation.

**`models.classify` is still not routed, so the 12-row parity check is still
gated — and not only on credentials.** `interpret_promise` remains a tool the
orchestrating model calls with its own judgement, so classification runs on
`models.explain`, not on `models.classify`. Routing it means the server making a
separate Anthropic call and overriding the model's classification — the same
architectural move just made for fulfillment, and it should be an explicit
decision rather than a side effect. Until then `describeModels()` keeps saying
so at startup, and a parity run would measure the wrong model.

---

## 2026-08-19 — item 3 close-out: classify routed, tool renamed, prompt pinned

### 1. `classify` is routed

`evaluation/classify.ts` issues a dedicated `claude-haiku-4-5` call with
`interpret_promise` forced via `tool_choice`, mirroring the fulfillment leg. The
orchestrating model's classification is now a **cross-check**; disagreements are
returned in `classification_disagreements` and the dedicated classifier governs.

Two deliberate choices:

- **An off-taxonomy pair FAILS the tool call — it is never snapped to the
  nearest valid pair.** Auto-repair would hide exactly the drift the check
  below exists to measure, and would do it silently.
- **A classifier failure does not fall back to the orchestrator's guess.** That
  fallback would quietly run the query on an unrouted model and make any parity
  measurement meaningless. It returns `UPSTREAM_UNAVAILABLE` instead.

Unlike the relevance and fulfillment prompts, `CLASSIFY_SYSTEM_PROMPT` is
**written, not extracted, and carries no length assertion** — there is nothing
upstream to assert against. `IVUmoD8pG4E5M8D0` is inactive, its Claude
classifier node is disabled, its user-message template has a known typo, and the
corpus was classified with GPT-4.1 outside it. Marked as authored in the file so
nobody later mistakes it for a transcription.

### 2. The 12-row in-taxonomy check — harness built, live run BLOCKED

`tools/check-classify-taxonomy.mjs` runs 12 statements through the routed
classify path and reports the in-taxonomy rate. The bar is only "the returned
pair exists in the approved taxonomy" — a prompt-quality check, not GPT-4.1
parity.

Why that bar earns its place on its own: an off-taxonomy pair is not a debatable
judgement, it is a broken query. `lookupTaxonomyKeywords` misses, the
`Related Terms:` line drops out of the embedded text, the vector moves, and
retrieval returns nothing — which the tool renders as **"no relevant bills"**. A
wrong-but-valid pair at least retrieves something a human can see is wrong; an
invented pair fails silently.

**No pass rate is reported, because there is no `ANTHROPIC_API_KEY` in this
environment and the script refuses to run against a stub.** A fabricated pass
rate is worse than no pass rate: it would read as evidence the prompt works.

What *was* verified without a key, and is now covered by tests:

- The check **detects the exact historical drift** — `"Healthcare"` instead of
  `"Health Care"`, the precise fabrication that sat in `taxonomy.json` for
  weeks — plus invented sub-issues. A harness that passes everything would be
  worse than none.
- Drift is **reported verbatim**, not auto-corrected.
- `is_evaluable: false` counts as in-taxonomy with no pair: refusing to classify
  a vague statement is the correct answer, not a failure.
- **All 121 pairs offered in the prompt menu are themselves valid** — asserted
  by walking the rendered menu. If the menu contained an invalid pair, the
  prompt would be inviting the drift the check then flags.

Run it when a key exists: `npx tsx tools/check-classify-taxonomy.mjs`.

### 3. `score_matches` → `evaluate_effects`

The old name implied WF11 decision scoring; the semantics are WF10A fulfillment.
`toolDefs.ts` now states plainly that the model's `bill_effect` is **advisory** —
a cross-check — and that the dedicated evaluator governs, with disagreements
returned in `effect_disagreements`.

The header comment records the wider change: two of the three model-supplied
inputs are no longer authoritative. They are still **collected** on purpose — a
disagreement is a signal worth seeing, and having the model reason about effect
keeps its narration grounded in the same question the evaluator answered. But
the number that scores is never the orchestrator's.

### 4. The fulfillment prompt is byte-complete — asserted, not eyeballed

Pinned by **sha256** (`96757c84…`), so any edit anywhere in the 32,507
characters fails the suite. Named clauses assert what the hash is protecting:

| Clause | Where | Count |
|---|---|---|
| `-0.1 confidence penalty` | system prompt | **2** |
| `apply the -0.1 confidence penalty … maximum confidence is 0.9` | user template (hand-ported) | 1 |
| `NEVER … Use confidence 0.9 or above for Policy Positions` | system prompt | 1 |
| `**0.95 to 1.0** … (Campaign Promise only)` | system prompt | 1 |

**Correction to my own earlier count:** I wrote that the prompt "instructs it
three times". The system prompt carries **two** statements; the third is in the
node's user template. Three across the node, not three in the system prompt.
`shared/index.ts` is updated to say so precisely.

The fourth row matters and was nearly missed: the band table caps the
`0.95–1.0` band to Campaign Promise only. That is the *other* half of the 0.9
ceiling, in a different section, and it would be easy to trim without noticing
the penalty had lost its teeth. It is asserted too.

107 tests pass, typecheck clean.

---

## 2026-08-19 — item 4: correctable classification

### The constraint the whole feature is shaped around

Every correctable field lives **inside the embedded query text**, so changing
one moves the query vector and therefore the candidate set. A correction is a
**full re-run from embedding** — not a re-evaluation of the matches on screen,
and not a filter over them.

That is why the surface is staged edits behind an explicit "Re-run with these
corrections" button rather than live controls. Live controls imply the result
reshapes in place, which is the one thing it cannot do.

**Verified in the browser, not just asserted:** correcting
`Social Security & Entitlements / Senior Citizens` →
`Health Care / Prescription Drugs` moved retrieval from **2 related actions to
3**. The candidate set genuinely changed, which is the observable proof the
re-run starts at embedding.

Pinned by tests: each of the five vector-bearing fields is shown to change the
embedded text, plus a guard that every field declared in `Corrections` is
covered — a new correctable field added without a case would silently break the
"correction = full re-run" premise.

### Never an old verdict beside corrected values

`stream.run` fully resets state before opening the new stream, so the previous
verdict is gone *before* the new query starts. Measured in the browser: 120 ms
after clicking re-run, the old verdict copy is already absent. There is no
window in which a verdict computed from the rejected classification sits beside
the corrected values.

The delta is shown twice, deliberately, and they are different things:
**before** ("What will change", staged, with the warning that the current result
will be cleared) and **after** ("Re-run with your corrections", what was
actually applied to the result now on screen).

### Campaign Promise override — flagged dark, premise attributed

`config.features.campaignPromiseOverride` defaults **false**; a test pins that
default. Printing "BROKE" against a commitment we have no evidence was made is
the one output with real downside, so the path ships dark pending copy review.

- With the flag off the checkbox is not rendered, and an `assert_campaign_promise`
  arriving anyway is **rejected**, not partially honoured — a half-applied
  override would render promise vocabulary with no attribution, the exact
  failure the flag exists to prevent.
- With it on, `statement_type` becomes `Campaign Promise` and `provenance`
  becomes **`asserted`** — the premise is the user's, not evidence we hold.
- `user_asserted_premise` travels on the `Interpretation`, and the badge is
  marked `data-share-include="true"` so the attribution survives into share and
  export. Promise vocabulary without the attribution silently converts the
  user's claim into ours.

### Regression caught before shipping: degraded legs must not read as findings

Wiring items 3's evaluators exposed a bad interaction in demo/fixture mode,
where there is no OpenAI credential: every relevance candidate would come back
ERROR, the evidence gate would admit **zero**, and the tool would report
"nothing in his record bears on this" — a finding, manufactured by a missing key.

Both legs now **skip and label** rather than failing into a verdict:

| Condition | Before (as wired) | Now |
|---|---|---|
| no OpenAI key, relevance | every candidate ERROR → 0 admitted → reads as "no relevant bills" | leg skipped; `relevance_applied: false` and a note that these are raw retrieval matches, not relevance-checked evidence |
| no OpenAI key, fulfillment | every effect ERROR → every row frozen | falls back to the orchestrator's advisory effects; `effect_source` says so explicitly |

The rule this follows is the project's own: an empty or missing result must read
as empty, never as a finding — and a degradation must be labelled, never silent.

115 tests pass, typecheck clean, verified in the browser in demo mode.

---

## 2026-09-07 — v7 reconciliation: pipeline drift and the schema catch-up

Four workflows moved between 2026-08-19 (the last reconciliation) and today.
All of them. The earlier ports were built against a pipeline that no longer
exists in that form.

| Workflow | Then | Now | Change |
|---|---|---|---|
| W7A | 2026-08-18 | 2026-09-04 | — |
| W7B `Promise Matches` | 54 cols | **57** | +`Anchor Vehicle`, `Promise Date`, `Temporal Reference` |
| WF8 | never examined | 2026-09-06 | writes the **identical 57-col** schema + `Unmatched Bills` (41) |
| WF10A `Promise Alignment - Matches` | 62 cols | **74** | +12 (§4 below) |
| WF10A evaluator prompt | 32,507 chars | **9,343** | v7 supersedes v6 outright |

### The reason all of this happened

An audit found **78 of 79 BROKE verdicts were false positives**. v7 is the
remediation. The v6 prompt was not deprecated but deleted, because it carried
the rules the audit blamed: a 0.6 confidence floor, "NEVER return NEUTRAL
because the connection requires inference", and an asymmetric cloture/passage
precedence. Keeping it importable would let a stray import reinstate them.

That reframes every verdict this tool has produced. The single `KEPT` it
returned on 2026-09-07 predates the v7 rules and is unverified against them.

### WF8 — the missing direction, confirmed

The app only ever ran promise→bill (W7A/W7B). **WF8 is the bill→promise
direction**, active, and writes to the *same* `Promise Matches` table with the
*same* 57 columns — the two directions are distinguished by `Match Direction`,
not by schema. Its non-matches go to `Unmatched Bills` (41 cols), the mirror of
W7B's `Unmatched Promises`.

So `app_query_matches` models one of two directions, and `match_direction` is
hardcoded `'promise_to_bill'` at the call site. Not wrong, but partial, and the
partiality is invisible in the data.

### Schema catch-up — migration 003

PR #2 ported the v7 logic into the app. `SupabaseQueryStore` was not part of
that PR: its `insert` names an explicit column list that predates scope, gates
and the disclosure fields, so **the application computes all of it and the
database silently drops it**. An unlisted field is not an error.

`docs/migrations/supabase-migration-003-v7-fields.sql` closes the database half:

- **8 scope columns on `app_queries`.** The pipeline stores these per statement
  on `Evaluable Statements`; the query tool has no statements table because the
  user's typed text *is* the statement, classified live per request. `scope_model`
  is stored per row rather than assumed — a reclassification under a later prompt
  must be distinguishable from an original.
- **15 columns on `app_query_alignments`** — the 12 from handoff §4, plus
  `model_verdict` (behavioural contract 1: the model's `promise_alignment` is
  *never* the verdict), plus the two markers below.

### The marker problem — a live breaking bug, not a gap

Migration 002 declared `alignment_confidence numeric`. Handoff v2 §3 establishes
that this column can legitimately hold the string `NOT_EVALUATED` on a gated
row, and `gates.ts:99` emits exactly that.

Inserting it into a numeric column does not degrade — it **raises**, and because
the write is transactional, the rollback takes the parent `app_queries` row with
it. Every gated query would have stored nothing at all.

Resolved the way the app resolved it (`shared/DirectedAction`): the number stays
numeric and the marker gets its own column, so the two can never overwrite each
other and "not evaluated" stays distinguishable from "evaluated at zero
confidence". A CHECK constraint enforces that only one is ever present, because
the rule is the point and a convention would erode.

`effect_marker` follows the same shape: `bill_effect` stays null on a gated row
rather than taking `NEUTRAL`, which would assert "the bill does not move this
promise" — a finding nobody made.

### Grade — not a constraint, deliberately

WF11 refuses to score `PENDING` or `REVIEW_REQUIRED`. The same refusal must hold
here or the tool prints an accusation no judge has cleared. It is *not* a CHECK
constraint: grade is written before judging completes, so a constraint would
reject the initial insert. Instead the contract is documented on the column and
`app.v_alignments_awaiting_judgement` makes the uncleared set visible rather
than implicit. `JUDGE_ERROR` is included in that view on purpose — an
infrastructure failure is not a pass.

### Known-bad impacts

The six bills from handoff §8 are a table, not a constant: updatable without a
deploy, and a suppression stays auditable. `resolved_at` is set on regeneration
rather than deleting the row — that a reading was once unreliable is part of the
audit trail.

---

## 2026-09-07 (later) — contract 3 and the verdict audit log

### Contract 3 — accusations must clear a floor

`scoring/withholding.ts`. A `BROKE`/`INCONSISTENT` whose best supporting action
is below **0.7 confidence**, with no counterargument on the record, is
downgraded to `NOT_DETERMINABLE` with reason `WITHHELD_LOW_CONFIDENCE`.

This is the cheap, deterministic half of the false-positive defence: no model
call, no added latency, and it runs on every query. The audit that found 78 of
79 BROKE verdicts false is the reason it exists.

Four decisions worth recording:

- **Asymmetric on purpose.** It only ever touches accusations. A `KEPT` at 0.2
  passes untouched. A weak favourable reading is not the output with real
  downside, and nothing here can create or strengthen an accusation.
- **Best breaking action, not the average.** One sound action at 0.85 supports
  the reading even beside weak corroboration. Averaging would withhold
  defensible accusations — the wrong failure direction.
- **Null confidence fails closed.** No recorded confidence is *less* evidence
  than 0.65, not more. The bar is "demonstrably at or above 0.7", not "not
  demonstrably below it".
- **`counterargumentPresent` defaults to false.** v7 asks the evaluator to put
  the counterargument in `alignment_reasoning` as prose, and prose cannot be
  verified by inspection. Guessing "there's probably one in there" is the
  unverified inference this contract exists to stop. When the evaluator emits a
  discrete `senator_counterargument`, pass it and sub-0.7 accusations become
  renderable again — with the reply shown beside them, which was always the point.

**The evidence stays on screen.** Withholding the verdict is not hiding the
record: the bills and votes still render, and the trace says why no conclusion
was drawn. The copy is deliberately non-exculpatory — "the record here points
against this promise, but not clearly enough for us to say so publicly" — because
withholding an accusation is not a finding that he kept it.

⚠️ **Consequence for DEMO mode.** Stub effects carry no `alignment_confidence`,
so every stubbed `BROKE` now withholds. That is correct behaviour by the rule,
but it changes what the demo shows. One line in the stub (emit a confidence)
restores it honestly — flagged for the v7 port thread rather than worked around
here.

### Verdict audit log — migration 004

`app.app_verdict_audit_log`, one row per **decision event**, not per query: a
single query can gate, then withhold, then judge, and collapsing those loses the
order the reasoning actually happened in. `seq` makes the order explicit rather
than inferred from `created_at`, which ties on sub-millisecond steps.

**Append-only by privilege, not convention.** `receipts_app` is granted `INSERT`
and `SELECT`; `UPDATE` and `DELETE` are revoked. A trace that can be edited is
not a trace, and a correction is a new row.

`senator_counterargument` is a stored column rather than a flag, so the claim
that a counterargument existed is checkable rather than asserted — which is the
same reason contract 3 refuses to infer one from prose.

`app.v_verdict_trace` renders the chronological reasoning per query. A verdict
with no rows there was never audited, which is itself a finding.

### Judge — decided

The query tool keeps the audit log regardless of the judge, because the trace is
wanted for the deterministic steps too. Whether the LLM judge runs on the query
path is still worth measuring against the 79-row gold set before committing to
the Sonnet call: if v7 plus contract 3 already clears it, the judge is redundant
here. The log schema accommodates the judge without requiring it — `stage`
carries `JUDGE` and `RETRY` values that simply go unused until it is wired.

---

## 2026-09-07 — WF6 verified, firewall restored structurally

### The bill side of the embedding — checked, and it clears the vector space

The retrieval investigation had verified the QUERY side against W7A
(`text-embedding-3-small` @ `1024`) but never the BILL side. That was a real gap:
a mismatch there would make every similarity meaningless.

WF6 `Bill Embeddings` (`2tfR7BINlNlE0KhF`, updated 2026-09-04) posts:

```json
{ "model": "text-embedding-3-small", "input": …, "dimensions": 1024 }
```

**Identical on both sides.** It upserts to `{politician_id}_bills`, the namespace
we query, keyed on `Action UID` — so vectors are per-ACTION, not per-bill, and a
bill with several recorded actions carries several vectors.

That rules out the whole "vector space" class of hypothesis: no dimension
reduction without renormalisation, no second embedding model, no mismatched run.
The 0.494 ceiling is not the space; it is the text.

**What the comparison does show is a structural asymmetry in document shape:**

| | Bill vector (WF6) | Query vector (W7a port) |
|---|---|---|
| Sections | Title, Summary, Intended Effects, Mechanisms, Policy Area, Primary Issue, Sub-Issue, **Taxonomy Keywords**, Bill Keywords, Legislative Subjects, Affected Stakeholders | Promise, Stance, Promise Type, Primary Issue, Sub-Issue, Key Policy Terms, **Related Terms**, Reasoning |
| Length | long, multi-topic | short, focused |

Two things stand out. The same approved-taxonomy cell is labelled
`Taxonomy Keywords:` on the bill side and `Related Terms:` on the promise side —
already documented as deliberate, but it means the one field both documents share
verbatim is introduced by different text. And WF6's own comment records that vote
fields were deliberately kept OUT of `pageContent` because "putting vote text in
the embedded string would shift bill vectors away from promise vectors and
degrade retrieval" — the same sensitivity, acknowledged upstream.

Still unexplained: the pipeline clears 0.575 against these same vectors. The
remaining difference is the *provenance of the promise text* — corpus rows carry
GPT-4.1's `Key Policy Terms` and `Reasoning`, ours carry Haiku's, regenerated per
request. That is also the reproducibility bug already logged (four runs, four
reasonings, four vectors). The discriminating experiment stands: re-embed a known
`Promise Matches` pair with the tool's embedder and compare the score for the
same pair — same bills ranked but uniformly low means text shape, different bills
ranked means content.

### Firewall — the other direction was only ever code

Migration 002 enforced "the trust index cannot read user queries" by revoking
`receipts_trust` on `app`. That half holds.

The reverse guarantee — **the query tool must never read a pre-computed verdict
and present it as its own reasoning** — was only ever a convention. `receipts_app`
holds `SELECT` on all of `mirror`, and the sync now populates
`mirror_promise_alignment_matches` and `mirror_decision_scores`. Corpus verdicts
became one JOIN from the request path, with nothing but nobody-having-written-it
in the way.

Migration 005 revokes `receipts_app` on exactly those two tables. It keeps the
mirror it legitimately needs — donor alignment, party positions, impact
statements, roll call results — and a query reaching for a stored verdict now
fails on privilege rather than succeeding quietly. Same standard both directions.

### Audit provenance

`app_verdict_audit_log.source` (`QUERY_TOOL` | `PIPELINE_WF13`), `NOT NULL`
defaulted so an untagged row cannot be written. Requested in cross-thread review:
query-tool rows have no gold row to join, so `gold_agreement` is always
`NO_GOLD` for them — reading one as a pipeline row would misreport
*inapplicable* as *absent*.

---

## 2026-09-07 — v7 port coverage: what is reconciled and what is not

The column-set diffs earlier established *that* W7A/W7B/WF8/WF10A moved. This
records what has actually been **ported**, checked against the live nodes rather
than against the `docs/fix/` specs — those specs are a 09-05 snapshot and the
standing rule is that the node wins.

### Verified against the live node

**Evaluator prompt v7 — byte-identical.** `evaluatorPromptV7.ts` was generated
from `docs/fix/07_wf10a_evaluator_prompt_v7.md`, not from n8n, so it was worth
checking whether the spec had drifted from what is deployed. It has not: 9,343
characters, byte-for-byte equal to WF10A's `Promise Alignment Evaluator` system
message as of 2026-09-07T23:11. The spec was faithful.

### Ported

| Handoff v2 §10 target | Status |
|---|---|
| `prompts/scopeClassifier.v1_1` | ✅ `scope/scopeClassifierPrompt.ts` |
| `lib/scope/postCheck.ts` | ✅ `scope/postCheck.ts` |
| `lib/verdict/deriveAlignment.ts` | ✅ `scoring/deriveAlignment.ts` (split-vote + `governing`) |
| `prompts/evaluator.v7.txt` | ✅ `evaluation/evaluatorPromptV7.ts` — byte-verified |

### NOT ported — four gaps, all live in n8n

**1. `Pre-Evaluator Gates` — a 14,054-char node live in WF10A, absent here.**
Our `evaluation/gates.ts` is the OLD pre-*retrieval* gate pair (promise_type,
stance), and the other thread has confirmed it has zero call sites — dead code.
The v7 gates (G1 scope/admin/role, G2 vote pairing, G3 leader switch, G4 broad
vehicle) do not exist in the app. This is the gate set that closes 35 + 15 + ~10
of the false-positive rows upstream, so its absence is not cosmetic.

**2. `Compute Party Vote Alignment` / `LEADER_SWITCH` — live, not ported.**
WF10A emits `LEADER_SWITCH` instead of `CROSS_PARTY` for the Rule XIII leader
case. In our tree `LEADER_SWITCH` appears **only inside the evaluator prompt
text** — there is no `partyAlignment.ts` and nothing computes the vocabulary. So
the prompt can be told a row is a leader switch, but nothing ever tells it.

**3. `DATED_VEHICLE` — zero references in the app.** W7B `Derive Partial
Subtype` (2,614 chars) and WF8 `Derive Partial Subtype` (2,758) both emit it,
and W7B's `Build Eval Request` carries the STANDING / RECURRING / DATED temporal
call. None of that is in the app, so `partial_subtype` here can never take the
value the pipeline now uses for an expired-vehicle match.

**4. WF8 (bill→promise) — not ported, by agreement.** Confirmed out of scope for
the query tool: it answers "does this senator's record bear on this statement",
which is inherently promise→bill; bill→promise searches `_statements` and is a
different product question. The residue is that `match_direction` is hardcoded
`'promise_to_bill'` at the call site, so the stored trace asserts a direction
that was never a variable. It should be written from a named constant with the
one-directional design stated, so the data is honest about its own partiality.

Also unported: `lib/judge/deterministicGates.ts` and `prompts/judge.v1.txt` —
expected, since the judge is agreed but not yet built.

### Why this matters for the schema already shipped

Migration 003 added `gate_hits`, `senator_role`, `role_condition`,
`cloture_result`, `bill_class` and `vote_flags` to `app_query_alignments`. Those
columns are correct against WF10A's 74-column output — but **nothing in the app
can populate them yet**, because the gates and party-alignment logic that produce
them are the two unported pieces above. The columns are not wrong; they are ahead
of the code, deliberately, and will stay null until items 1–2 land.

---

## 2026-09-07 — coverage disclosure, and a correction to my own diagnosis

### The retrieval "blocker" was not a bug

Five turns were spent on a defect that did not exist. `hr5376` (Inflation
Reduction Act) is **117th Congress**; collection starts at the **118th**. The
tool returned `NOT_DETERMINABLE / NO_MATCHES` because Schumer has no
drug-pricing action inside the analyzed window. It was correct.

**The disconfirming evidence was already in hand and I read it as a success.**
"I will protect Medicare beneficiaries from out-of-pocket costs" returned
**KEPT with 1 admitted match** — same senator, same namespace, same embedder,
same template, same run. A systematic offset cannot depress one query and not
the other. That result arrived two turns before I described the 0.494 ceiling
as "a systematic offset, not a semantic miss" and sent the other thread looking
at the vector space. Both were wrong, and the earlier RECONCILIATION entry
should be read with that correction attached.

What the investigation did establish, and which stands: WF6's bill-side
embedding is `text-embedding-3-small` @ `1024`, identical to the query side —
that gap in the verification was real and is now closed.

### The real finding: an undisclosed coverage boundary

> "We didn't find any bills or votes in this senator's analyzed record that
> relate to this promise."

Every word true. A reader hears *"he has no record on drug pricing."* Schumer
**passed** the IRA — Medicare negotiation, the insulin cap — as Majority Leader.

This is the mirror of the false-positive class, and **the less protected of the
two**. An accusation must clear a 0.7 floor, carry a counterargument, and
survive a judge. An absence gets a clean sentence, no confidence, no scrutiny.
Handoff v2 §7 already states the principle for the pipeline — "absence of a
match is not absence of action (measured P2B candidate coverage ≈ 57%)" — and
the query tool did not honour it.

Nothing in the app knew the window. `congress` existed in Pinecone metadata and
was used only to build congress.gov links.

### What shipped

- `config.coverage.congresses` from `COVERAGE_CONGRESSES` — **disclosure, not a
  filter**. Retrieval already searches only what exists; this exists so the tool
  can say what it searched.
- `congress` threaded from Pinecone metadata onto `MatchedAction`, read
  defensively: a vector embedded before the field existed has *no* congress,
  which is unknown, not zero — a zero would drag the observed minimum to a
  congress that never existed.
- `CoverageWindow` on `QueryResult`, carrying the declared list, the **observed**
  span, and an `unknown` flag.
- `scoring/coverage.ts` — `describeCoverage()` and `coverageSentence()`.

Two decisions worth recording:

**Derived, not asserted.** `observed` comes from the retrieved candidates' own
metadata, and the sentence prefers the declared window but falls back to the
observed one. A hardcoded "we cover the 118th and 119th" would keep saying that
after collection was extended — lying in the opposite direction, and silently,
because nothing would fail. A test caught exactly this: with
`COVERAGE_CONGRESSES` unset and real candidates in hand, the first version fell
back to vague copy instead of using the window it had just derived.

**The sentence describes the SEARCH, never the senator.** The tool can speak
with authority about its own corpus and has no standing to speak about anything
outside it. It also has to *actively deny* the inference rather than merely
avoid making it — "not a finding that the senator has no record on the subject".
A test pins that the only permitted mention of the senator is a negated one.

### Still owed by the other thread

`ND_REASON_COPY.NO_MATCHES` and the result rendering are their files. The
`coverage` field is populated-ready; the copy change is one line. Until it
renders, the boundary exists in the payload and not on screen.

### Coverage decision (agreed with Matt)

Collection started at the 118th because that was what the trust index needed;
the data is accessible, it was simply not gathered. Agreed direction: trust
index stays 118–119 (a current-term score is a coherent question with a natural
boundary); the query tool wants wider. Next increment is the **117th** — it
contains the IRA and covers the 2022 campaign cycle whose promises the current
term is judged against. WF6 already takes `target_congress`, so embeddings are
congress-agnostic; the cost is bill collection and impact statements, not a
rebuild. Going further back should wait on `min(Promise Date)` from Evaluable
Statements — a number, not a judgement call.

---

## 2026-09-07 — WF11 judge gate, and a correction to migration 004

WF11 moved again (2026-09-07T17:43) and gained a node that did not exist when
migration 004 was written: **`Drop Unjudged Rows`**. Reading it showed 004's
`v_alignments_awaiting_judgement` diverged from the pipeline in two ways.

WF11's rule:

```js
const BLOCKED = new Set(['PENDING', 'REVIEW_REQUIRED']);
// Blank Grade passes. Rows written before WF13 existed, and WF10a rows that
// were never accusations, legitimately carry no grade.
```

**1. A null grade passes — 004 had it backwards.** The judge only ever runs on
BROKE/INCONSISTENT, so every KEPT, every NOT_DETERMINABLE and every gated row is
legitimately ungraded. Treating null as "awaiting judgement" put essentially the
whole table in the review queue. A check that fires on everything is as useless
as one that never fires, and this one would have been dismissed on first read.

**2. `JUDGE_ERROR` stays blocked here — deliberate divergence, now documented.**
WF11 does not list it because §5 has an errored judge leave the row at PENDING,
which WF11 blocks anyway. The query tool has no WF11 and no requeue: it renders
once. So an infrastructure failure must withhold rather than fall through. Same
reasoning the other thread applied on the code side.

Not adopted: WF11 **drops** blocked rows so a later run picks them up through
the `Filter Processed Scores` anti-join, and notes that freezing would write a
null-score row that blocks the real score forever. The query tool has no later
run to requeue into, so it withholds in place.

Migration 006 also adds `app.v_accusations_rendered` — BROKE/INCONSISTENT rows
stored without a passing grade. It should be empty once the judge is wired;
non-empty means the tool published an accusation no second opinion cleared,
which is the precise failure the judge layer exists to prevent and therefore the
thing worth alerting on. The pipeline has no equivalent because it has WF11
standing between a verdict and the index; the query tool has nothing between a
verdict and the reader.

### Still-stale port, logged not fixed

`Compute Decision Score` is now **25,077 chars**; the port was reconciled against
20,803, then 24,146 at the policy-position split. It has moved again.
`decisionScore.ts` is therefore stale — but it remains **dormant**, called only
by its own test and not on the request path, so this is recorded rather than
chased. It must be re-reconciled before anything wires it in.

---

## 2026-09-07 — audit writer

`QueryStore.appendAuditEvents()` plus `StoredQuery.audit_events`, both
implemented in `SupabaseQueryStore`. The other thread emits gate and judge
events by calling into this and never touches SQL.

Three decisions:

**Written inside the same transaction as the row they describe.** A verdict that
committed without its trace is exactly the unexplained assertion the log exists
to prevent, and a half-written trace is worse than none because it reads as the
complete reasoning.

**Append-only, enforced by privilege not by care.** The seam exposes no update
and no delete, mirroring the grant in migration 004 where `receipts_app` holds
`INSERT` and `SELECT` only. A correction is a new event with a later `seq`.

**Contract 3 is derived, not waited on.** Nothing calls the audit writer yet, so
the withholding rule that is live today would have had no trace until a call
site got around to it. `saveQuery` now synthesises the event when the frozen
result carries `nd_reason = 'WITHHELD_LOW_CONFIDENCE'` and the caller supplied
no `WITHHOLDING` event — so wiring it explicitly later does not double-write. A
test pins the constant the derivation keys on: rename it and the rule silently
loses its trace.

`seq` is caller-supplied rather than generated. Wall-clock ties on
sub-millisecond steps and the order is the whole point of an event log.

203 tests pass, typecheck clean.

---

## 2026-09-07 — two decisions closed

### A. Corpus verdict mirrors dropped (migration 007)

Decision (Matt): not relevant to the query tool, which **emits its own verdicts
in real time from the user's query** and never reads a stored one.

005 revoked `receipts_app` on both tables. 007 drops them, because a revoke is
one `GRANT` away from being undone by someone tidying permissions and the tables
have no consumer to justify the risk. The enrichment mirror stays — donor,
party, impact, roll call — which the query tool genuinely reads.

⚠️ **The n8n sync must also stop writing them.** Dropping the tables does not
change the sync set; if the sync still lists them it recreates them on its next
run and quietly reopens what this closes.

### B. DEMO stub now emits a confidence

Decision (Matt): emit one, rather than exempt demo mode.

Contract 3 fails closed on a missing confidence — correct — but the stub emitted
none, so every stubbed BROKE silently became NOT_DETERMINABLE and the demo could
no longer show the verdict it exists to demonstrate. A stub asserting its own
confidence is honest; carving demo mode out of the rule would not be.

Directional effects get **0.82** (above the 0.7 floor), NEUTRAL gets 0.55 —
contract 3 never looks at a non-directional row.

**The stub change alone was inert.** `dispatch` set `alignment_confidence` only
from the fulfillment evaluator, which does not run in demo, so the stub's value
was dropped before it reached scoring. Verified by running a demo query and
seeing `conf=None`; after plumbing the caller-supplied value as a fallback,
`conf=0.55`. Worth recording because the change *looked* complete and typechecked
clean while doing nothing.

`alignment_confidence` is deliberately **not** in the `evaluate_effects` tool
schema, so a real model cannot supply it — the fallback exists for the stub, and
the evaluator remains authoritative whenever it runs.

Two tests pin this: the stub emits ≥ the floor for a directional effect, and the
withheld-without-confidence case is retained so nobody "simplifies" the field
away again.

---

## 2026-09-08 — the evaluation layer becomes visible

Five commits (`f8bda91`, `39a23e6`, `0b59f1d`, `3e97d6b`, `772067c`) rendering
what the evaluation layer already computed. Scoped as items 1 and 2 of
`START_HERE_next_thread.md`, both filed `[web]`.

**They were not web tasks.** Every one turned out to be the same shape: a field
computed correctly, persisted correctly, handed to the model correctly, and then
dropped between the server and the browser — with a fallback in the UI that said
something *false* in its place. The rendering was the small half.

### The pattern, and why nothing caught it

An optional field that is never assigned is indistinguishable from one that is.
`QueryResult.coverage` had a type, a derivation (`scoring/coverage.ts`), and
passing tests for that derivation — and was `undefined` on every response ever
served, because nothing in `finish()` assigned it. No test failed, because the
tests covered what the sentence *says*, never whether a user sees it.

The new `orchestrator/result.test.ts` exists for that gap specifically: it
asserts ATTACHMENT, not derivation.

### Four false statements the UI was making

Each is the same class as the coverage boundary — the tool asserting a finding
nobody made — arriving through a different door.

| Where | It said | Truth |
|---|---|---|
| `nd_reason` null | "We didn't find any bills or votes in this senator's analyzed record" | We have no recorded reason. The UI defaulted to `NO_MATCHES`, the strongest absence claim in the vocabulary |
| Every candidate gated | same `NO_MATCHES` sentence | We found related bills and deliberately declined to read them |
| Accusation withheld, no judge credential | "A second review didn't back this reading" | No review ran at all |
| Per-action confidence null, had it been rendered naively | `0` | No evaluator scored the row |

**`ND_REASON_COPY.GATED` already existed**, written in the previous phase for
exactly the second row of that table, and nothing ever set `nd_reason` to it.
`scoreMatches` receives `matches` already filtered to the scorable rows, so a
fully-gated query and a genuinely empty one are identical from inside the
scorer. `gated_count` now reaches it and G1 distinguishes three findings where
it distinguished two. It changes only the REASON — tests pin that verdict, band
and mode are byte-identical either way, and that a gate count cannot detour a
real scorable match into `GATED`.

`WITHHELD_PENDING_REVIEW`'s copy collapses a distinction its own type comment
insists on: *"one is a confidence bar, this is a review that failed or never
happened, and a reader deserves to know which."* `JUDGE_DISPOSITION_COPY` gives
each disposition its own sentence, and `JudgeDisclosure.unavailable` is a stored
field rather than a UI inference so the distinction survives into anything that
reads a persisted result.

### Port gap — `vote_flags` was half-implemented

Handoff v2 §4 lists `vote_flags` as `';'-joined: SPLIT_VOTE, FLOOR_LEADER`. The
scorer could only ever produce the first: it derives `SPLIT_VOTE` from the votes
in front of it and holds no reference data for anything else. `FLOOR_LEADER` and
`ACTION_DATE_PROXY` are computed by `preEvaluatorGates` — which knows the
senator's role at that Congress and whether the action date is a stand-in — and
were dropped on the way to the row.

`ScorableMatch.vote_flags` carries them through; the scorer unions them with its
own, deduped, because the gates compute `SPLIT_VOTE` too on a stricter rule that
excludes `NOT_VOTING`. Disclosure only — a test pins that a flag cannot move a
verdict, a band or a weight. Restores §4 rather than departing from it.

### Contract 2 was half-rendered

*"Split vote → confidence ≤ 0.75, both votes named, `governing_vote` stated."*
The card named both votes and never said which governed — the half the verdict
turns on, and precisely the shape §4 calls "exactly the claim a senator's office
knocks down".

**The plain-language layer is not decoration.** The raw split-vote value is
literally `CLOTURE (60-vote threshold; split vote)`, and `threshold` is in
`BANNED_LEVEL1_TERMS`. Printing `vote_governing` verbatim to a voter breaks the
Level-1 no-statistics rule that the whole receipt is built on. So:
`GOVERNING_VOTE_COPY` translates for Level 1, the raw string stays in the trace,
and a test pins that every governing value a real vote combination can reach has
copy — a wording change in `deriveAlignment` now fails loudly instead of
silently rendering nothing on the rows that most need disclosure.

`FLOOR_LEADER`'s copy states what the ROLE involves, never what the senator was
trying to achieve. The non-goals rule out intent attribution and a leader's
procedural vote is where that temptation bites hardest.

### Logged, not fixed

**Nested judge reasoning in the Level-2 trace.** `applyDispositionToResult`
builds its reason by slicing `disposition.reasoning`, which for `JUDGE_ERROR`
already contains that same prefix — so the trace reads
`"could not run (| WITHHELD: … could not run ("`. Cosmetic, analyst-facing only,
and inside ported judge code: `dispositions.ts:264`.

**`gatedDisposition` is unreachable on the query path.** `dispatch` passes
`judgeGates(...).fired` to the judge as INPUT rather than short-circuiting on a
deterministic hit, so `GATED_*` dispositions never occur here. That appears to
be deliberate — "the model confirms or disputes those hits rather than
re-deriving them" — but it means the `GATED_*` branch of `applyJudgeVerdict` and
its copy are live code with no live caller. Not touched; noted so nobody
"discovers" it as dead and removes it.

### Fixture correction

`FIXTURE_ACTIONS` carried no `congress`, though live Pinecone rows do
(`PineconeActionStore` reads it from vector metadata) and the file's own header
promises rows "shaped like real rows … so code paths exercised here are the ones
that run live". Demo mode was therefore reporting an UNKNOWN coverage window — a
weaker sentence than the live path produces. Derived from `bill_id` rather than
typed per row, so it cannot drift from the identifier it describes.

### What is verified, and what is not

Verified in a browser: the coverage sentence on both a `NOT_DETERMINABLE` and a
`KEPT`; the governing-vote sentence; `FLOOR_LEADER` and `ACTION_DATE_PROXY`
disclosures; the withheld-accusation sentence on the `JUDGE_ERROR` path; and the
Level-2 trace including the per-action confidence.

**Not verified in a browser, and not fake-able from here:**

| | Why |
|---|---|
| Gated rows rendering | No fixture triggers a gate. Probed all 8: every gate fails open because demo skips scope classification and fixture enrichment is null |
| Halt UI | Demo skips scope classification entirely (`loop.ts:806`) |
| Judge `PASS` + counterargument, `REVIEW_REQUIRED_JUDGE_CORRECTED` | Need a real judge call |
| A `SPLIT_VOTE` row | No fixture has cloture and passage disagreeing |

The first three need `ANTHROPIC_API_KEY`. The fourth does not — it needs a real
split-vote pair from the corpus.

**Deliberately not fabricated.** Adding a gated fixture or a split vote would
mean inventing a vote record for a real senator. That is a different act from
deriving `congress` from a bill id, which was already true of the row. The demo
banner mitigates but does not erase it, and a tool whose product is its audit
trail should not seed its own demo with invented votes. All four paths are
covered by tests instead.

357 tests pass, typecheck clean, web bundle builds.

---

## 2026-09-08 (later) — run with a live key: three paths closed, one new finding

An `ANTHROPIC_API_KEY` was supplied locally. `llm=live (claude-sonnet-5)` with
`data=FIXTURE`, so scope classification, the pre-evaluator gates and the judge
all ran for real against the canned match set. Three of the four paths the
earlier entry listed as unverified are now verified in a browser.

### Verified

**Both halts.** Never exercised before today.

- `NON_TESTABLE_SPEECH_ACT` — "The Senate will vote on the appropriations bill
  Thursday afternoon" classified OPERATIONAL and stopped before retrieval:
  *"This isn't something a vote can settle."* No retry affordance, only "Ask
  something else", with the classifier's own reasoning shown as the
  justification. The classifier also read "I will bring the voting rights bill
  to the floor … before the end of this month" as OPERATIONAL — floor
  scheduling, which is correct and not the case I was aiming for.
- `STATEMENT_DATE_REQUIRED` — "I will co-sponsor a bill to lower prescription
  drug prices within the next 60 days" classified COMMITMENT / BOUNDED with
  `valid_until = UNKNOWN`, and offered the date field.
- **Date recovery works.** Supplying 2020-09-01 re-ran the whole query from
  embedding and produced a verdict.

**Gated rows, and the false absence they used to produce.** The same query with
that date has `valid_until = 2020-10-31`, and every retrieved bill's action date
(a Congress-start proxy: 2021-01-03 and 2023-01-03) falls outside it. All three
candidates were closed by `G1_scope`, and the result renders:

> The legislation we found can't settle this statement — the window it applied
> to had closed … Each item below says which.

followed by "Found, but not evaluated" and all three bills with the gate's
verbatim reason, including the proxy-date disclosure. **Before this phase that
page would have read "We didn't find any bills or votes in this senator's
analyzed record"** — about three bills it had just retrieved. This is the
clearest confirmation of the `GATED` reason fix.

`confidence not recorded` also renders in the trace, which is exactly the case
the `confidenceTraceLabel` guard exists for.

### NEW FINDING — the judge cannot run without an OpenAI key

Still unverified: judge `PASS` with a counterargument. Not for the reason
recorded earlier ("needs a real judge call") — the key was live and the judge
still never ran. The cause is an ORDERING fact nobody had written down:

```
scoreMatches()  ->  applyWithholding()  (contract 3, INSIDE the scorer)
                ->  verdict becomes NOT_DETERMINABLE
dispatch: isAccusation = scored.verdict === 'BROKE'   // now false
                ->  the judge block is skipped entirely
```

`alignment_confidence` comes from the fulfillment evaluator, which requires
`OPENAI_API_KEY`. Without it every row's confidence is `null`, contract 3 fails
closed as designed, and the verdict is already NOT_DETERMINABLE by the time
`isAccusation` is tested. Observed directly: the ATF-rule query derived
INCONSISTENT on `sjres28-118`, and the trace reads

> Contract 3: … no confidence was recorded for the actions behind it … Below
> 0.7, an accusation is withheld rather than shown.

with no adversarial-review block at all.

**The general consequence, which is a design fact worth stating.** Contract 3
runs inside the scorer and the judge runs after it, so **the judge only ever
sees accusations that already cleared 0.7.** Handoff v2 §5 describes the judge
as the second opinion on "every accusation"; in this implementation it is the
second opinion on every accusation that survived the confidence floor. The two
layers are not parallel — they are in series, cheapest first.

That ordering is defensible and arguably right: contract 3 is free and
deterministic, the judge costs a Sonnet call, and both can only ever withhold.
Nothing here should change without a decision. Recorded because "the judge
reviews every accusation" is what the spec says and is not what the code does,
and because it is the reason an Anthropic-only configuration cannot exercise
the judge at all.

### Two copy bugs, found only by running it

Both are the same class this phase has been about — text asserting something
untrue — and neither was reachable in demo mode.

- `Read as a operational statement`. The article was hardcoded before a value
  that is sometimes vowel-initial. Now derived.
- `Demo mode. No API keys are configured` was shown whenever EITHER mode was
  on. With Anthropic present and Pinecone absent both halves were false: not
  demo mode, and a key was configured. The banner now names the actual
  degradation — "Sample data. The retrieval keys are not configured". A
  degradation notice that misdescribes the degradation is the same defect as a
  verdict that misdescribes the evidence.

### Two infrastructure fixes this shook out

- **`.env` was never read.** `config.ts` used `import 'dotenv/config'`, which
  resolves against `process.cwd()` — and the dev script runs the server as a
  workspace, so the cwd is `packages/server/`. A root `.env`, which is where
  `.env.example` and DEPLOY.md both put it, was silently ignored: the banner
  printed `credentials: anthropic=ABSENT` next to a correctly filled file. Now
  resolved from `import.meta.url`.
- **The suite was reaching the network.** Once the root `.env` loaded, the tests
  inherited the real key, and "refuses to classify without a key rather than
  guessing" stopped testing the refusal and made a live Anthropic call — 2.3s
  and real money inside `npm test`, surfacing as a failure only because the call
  succeeded. `vitest.config.ts` now pins the credential variables empty.

### Still unverified

| | Needs |
|---|---|
| Judge `PASS` + counterargument, `REVIEW_REQUIRED_JUDGE_CORRECTED` | `OPENAI_API_KEY` as well — see the ordering finding above |
| A `SPLIT_VOTE` row | A real split-vote pair in the corpus; no fixture has cloture and passage disagreeing |

357 tests pass, typecheck clean.

---

## 2026-09-08 (later still) — `PINECONE_INDEX` removed

A declared config value with no consumer. `config.ts` read it into
`config.pinecone.index`; nothing anywhere referenced that field. The Pinecone
query is addressed by `host` plus `namespace`, and a Pinecone REST host is
already index-specific, so the index name is redundant once the host is set.

**This reverses a deliberate decision, not a bug.** The comment on the field
said so outright — "it is also never read … Kept as a declared config value for
operator clarity, blank until someone sets it." The reversal is Matt's call, and
the reason is the one `.env.example`'s own header gives: *"A documented knob
that does nothing is worse than an undocumented one — someone sets it and
believes it took effect."* Operator clarity was the argument for keeping it, and
it turned out to produce the opposite — the variable read as required when
configuring a live deployment, and prompted the question that found it.

Removed from `config.ts`, `.env.example` and DEPLOY.md's backend env table.

### Why the sync test did not catch it

`config.env.test.ts` exists for exactly this class and its header names the
precedent (`SIMILARITY_STRONG` / `SIMILARITY_WEAK` "sat there for weeks doing
nothing"). It could not catch this one, because it compares `.env.example`
against `process.env.X` reads in `config.ts` — and `PINECONE_INDEX` *was* read
there. What it cannot see is whether the resulting config FIELD has any
consumer.

The gap: the test proves a documented var reaches config, never that config
reaches code. Closing it properly means asserting each `config.*` field is
referenced somewhere, which is brittle enough that it is recorded here rather
than attempted. Worth remembering that a green sync test is not evidence a knob
does anything.

### Not touched

`PINECONE_EMBEDDING_VERSION` stays. It is genuinely load-bearing when set — an
opt-in filter scoping retrieval to one run — and it carries the loud-fail
assertion in `PineconeActionStore` that refuses to render a stale pin's zero
results as "no relevant bills". Blank remains the correct default.

---

## 2026-09-08 (live run) — full credentials, and why the judge stayed unreached

`DATABASE_URL` blanked deliberately so nothing wrote to production; everything
else live. Banner: `llm=live (claude-sonnet-5)  data=live (Pinecone)`,
`credentials: anthropic=present openai=present pinecone=present`,
`supabase=ABSENT`.

### Verified against the real corpus

- **Both coverage branches, live.** With `COVERAGE_CONGRESSES` unset the tool
  said *"We could not establish which legislative record was searched, so treat
  an empty result as inconclusive rather than as an absence of action"* — the
  weaker `unknown` claim, correct for the config. With it set to `118,119` the
  same surface read *"We searched the 118th and 119th Congress."*
- **`ALL_BELOW_FLOOR` and `ALL_NEUTRAL`** both rendered on real data.
- **The documented coverage boundary, reproduced in production data.** "Repeal
  the Medicare drug price negotiation program" retrieved NOTHING for Schumer:
  the IRA is 117th and the corpus starts at the 118th. The exact case the
  coverage sentence was written for, seen live rather than argued from.

### Config gap found

`COVERAGE_CONGRESSES` was absent locally, so the tool made the weaker claim
about its own scope. **Worth checking it is set on Render** — if it is not, the
deployed tool has been telling users it cannot establish what it searched, when
it can.

### The judge PASS branch is still unverified — third distinct reason

Not credentials this time. Anthropic, OpenAI and Pinecone were all live, so the
ordering problem recorded earlier was resolved. The judge still never ran,
because **four real queries produced zero accusations.**

| Query | Outcome |
|---|---|
| Repeal Medicare drug price negotiation | `NO_MATCHES` — corpus starts at the 118th |
| Opposes further Ukraine military aid | `ALL_BELOW_FLOOR` |
| Supports rolling back EPA power-plant standards | `ALL_NEUTRAL` |
| Supports overturning the EPA major-sources rule | stream aborted, not retried |

The third is the instructive one. A CRA disapproval resolution Schumer voted
against was retrieved, matched closely, and the evaluator still declined to
read it as directional: *"related to EPA air rules, but reviewers judged it not
specific enough to power-plant clean-air standards to count as a clear move for
or against this promise."*

**That is the false-positive work behaving exactly as designed.** The audit that
started this effort found 78 of 79 BROKE verdicts were false positives; v7, the
gates and the evidence gate exist to make an accusation hard to reach. They
succeed. The cost is that the one branch which requires an accusation is
correspondingly hard to exercise by hand.

Reaching it deliberately needs a statement chosen against a KNOWN directional
vote in the corpus rather than guessed at — a query over the alignment data,
not trial and error through the UI. Recorded as the method for whoever picks
this up, rather than burning further live calls hunting for one.

### Still unverified

| | Why |
|---|---|
| Judge `PASS` + counterargument, `REVIEW_REQUIRED_JUDGE_CORRECTED` | Needs a derived accusation; the pipeline is designed to make those rare |
| A `SPLIT_VOTE` row | Needs a corpus bill where cloture and passage diverge; none surfaced in these queries |

### Unrelated observation

An SSE stream died mid-query with `net::ERR_ABORTED` when the dev server
restarted underneath it. The UI left every step ticked and rendered no verdict —
no error state, no message. Dev-only in origin, but the client has no timeout or
stream-closed handling, so a dropped connection in production would present as
a silent hang. Not fixed here; logged.

---

## 2026-09-09 — stance-inversion fixtures, and two divergences recorded as correct

From the external review brief (`receipts-query-tool-brief.md`, written against `dca65c8`). Its six
findings were checked against the tree before acting; all six verify.

### The v7 stance inversion — held as data, prompt fix DEFERRED

WF13 execution 13776 (2026-09-08, Thune, 52 rows, dry run) measured evaluator v7 inverting
oppose-framed statements. Statement `7Z0J7FUX` — goal is the ABSENCE of federal abortion funding —
evaluated against three bills that RESTRICT that funding:

| Bill | v7 said | Correct | v7 confidence |
|---|---|---|---|
| `s13-118` | HINDER → INCONSISTENT | ADVANCE → CONSISTENT | 0.88 |
| `s186-118` | HINDER → INCONSISTENT | ADVANCE → CONSISTENT | 0.90 |
| `s186-119` | HINDER → INCONSISTENT | ADVANCE → CONSISTENT | 0.90 |

The retry pass corrected all three.

**Why this is worse than an ordinary wrong answer:** every case sat above 0.7, so contract 3 — the
guard that exists to stop false accusations — would have passed all three straight through to a
reader. A confidently wrong direction defeats the confidence floor by construction.

`evaluation/stanceInversion.test.ts` holds the cases as an exported fixture and pins the blast
radius deterministically: `deriveAlignment` propagates whichever effect it is handed, symmetrically,
in both vocabularies. Its only statement-side input is `statementType`, which selects the label pair
and nothing else. **There is no stance term for the table to re-apply, so no downstream guard can
ever catch this class** — it has to be right when it leaves STEP 1.

**The prompt change is deliberately NOT made.** Two reasons, both structural:

1. `evaluatorPromptV7.ts` is GENERATED from `docs/fix/07` by `tools/extract-fix-prompt.mjs`, with
   the length asserted so a hand-edit fails generation. The brief's Task 1 says to edit the `.ts`
   directly, which would violate its own "do not hand-edit generated files" constraint. The fix
   edits the fix/07 source and regenerates.
2. `bill_effect` is the axis where divergence between this tool and the corpus scorer does the most
   damage — two prompts judging direction is exactly how the query tool and the trust report end up
   printing different answers for the same senator on the same bill. The change lands when the
   matching n8n edit can land beside it, not before.

An `it.todo` carries the deferral in the suite, and a test pins that the prompt today has only
SUPPORT-framed worked examples — the gap, stated as an assertion rather than a story.

### Two divergences from the pipeline, recorded as CORRECT

Added to README under "Where this repo is AHEAD of the pipeline". The n8n side should adopt these;
this side should not revert.

1. **`JUDGE_ERROR` withholds rather than publishes.** WF13's `Set Disposition` leaves the verdict
   standing on a judge infrastructure failure. On 2026-09-08 that would have published
   `CONSISTENT @ 0.7` on `ALIGN-P2BM-T000250-7Z0J7FUX-S186-118` — a row the judge explicitly failed
   as out-of-scope. Handoff v2 §5 says an infrastructure failure is never a content verdict; it does
   not say the unreviewed content ships in the meantime.
2. **The orchestrator-vs-evaluator `bill_effect` cross-check** surfaces a disagreement instead of
   resolving it silently. The pipeline has no equivalent, so drift on the direction axis is
   invisible there.

### README corrections

"Known gaps" 3 (relevance gate not wired) and 6 (partial taxonomy) are both closed and were removed
— the gates are called from `dispatch.ts`, and `taxonomy.json` is the full 121-row export at
`_provenance.status: "COMPLETE:2026-08-21"`. Both are listed as closed rather than deleted silently,
so they are not re-reported. Remaining gaps renumbered, and the stance inversion added as gap 5.

## 2026-09-11 — the query trace: every gate now leaves a record

**Problem.** The UI shows the end of the pipeline. `app_queries` holds the
frozen result, `app_query_matches` / `app_query_alignments` hold the PARSED
outcome of the relevance and fulfillment legs, and `app_verdict_audit_log`
holds every decision that changed a verdict. None of them holds what went into
a model call and what came out, in sequence — so a wrong-looking verdict could
not be walked back to the gate that bent it. Three things were invisible
outright: the orchestrator's own turns (narration + tool calls), explanation
drafts the wording checks bounced, and any run that halted, stopped on an
uncached senator or errored before interpretation (those never write an
`app_queries` row at all — `persist` skips them by design).

**What shipped.** `packages/server/src/trace/` — a per-run recorder exposed
through `AsyncLocalStorage`, two best-effort sinks (JSONL files under
`TRACE_DIR`, and `app.app_query_trace_runs` + `app.app_query_trace_steps` via
migration 009), `GET /api/trace/:run_id`, a `trace` stream event carrying the
run id (first on every stream; shown under the reasoning panel), and
`npm run trace -- <run_id>` to render a markdown log sheet. Gate map and
reading guide: `docs/trace-log.md`.

**Decisions worth recording.**

- **Keyed by run id, not query id.** The runs that never produce an
  `app_queries` row are the ones most worth tracing. `query_id` is a nullable
  pointer filled in after persistence; the `PERSIST` step says why when it is
  null. No existing table was altered — a column on `app_queries` would have
  broken persistence for every deploy until the migration ran.
- **The file sink is the primary local sink.** A local `DATABASE_URL` writes
  to production (2026-09-08 rule), so verification runs have it blank — and
  those runs needed a trace most. `.data/traces` is already gitignored.
- **System prompts are hashed, not stored.** Version tag + sha256 per model
  step; the text is in the repo at that version. 32 KB × N per run bought
  nothing.
- **The two OpenAI ports got an explicit `observe` option** rather than an
  ambient call inside them: they run candidates in parallel and correlate
  positionally, so the hook is the only place one candidate's request, raw
  response and parse coexist. The ports' behaviour is unchanged with no
  observer; an observer that throws is contained.
- **A replay is its own run.** The browser receives the ORIGINAL run's id (that
  run produced the answer); a separate one-step `CACHE_REPLAY` run records
  that the request happened and called no model.
- **Skipped legs are steps, not gaps.** No OpenAI key → `EVIDENCE_GATE`
  `skipped` with "passed through UNCHECKED" in the label; no judge credential →
  `JUDGE` `error` with "withheld unreviewed"; not an accusation → `JUDGE`
  `skipped` with "this is NOT a pass". Same rule as the UI copy: a leg that did
  not run must never read as a leg that passed.

**Verified.** `orchestrator/traceRun.test.ts` runs the real loop in DEMO +
FIXTURE mode and asserts the gate sequence REQUEST → CLASSIFY → INTERPRET →
RESOLVE_SENATOR → EMBED → RETRIEVE → EVIDENCE_GATE → SEARCH → ENRICHMENT →
SCORE → JUDGE → EVALUATE_EFFECTS → EXPLAIN_CHECK → EXPLAIN → RESULT → PERSIST →
DONE, plus the uncached and replay paths.

Then two runs in a browser against the real keys, `DATABASE_URL` blanked:

- Run `154ddde8-6e32-48f6-82ea-526cbb3f8476`, live mode, "promised to
  protect clean air standards from rollback" / S000148: 51 steps. `SCOPE_MODEL`
  (haiku, raw JSON + post-check), `CLASSIFY_MODEL` (haiku, forced tool),
  `ORCHESTRATOR_TURN` × 6 (sonnet — thinking + tool_use blocks per turn, stop
  reasons, usage), `RELEVANCE` × 9 and `FULFILLMENT` × 8 (gpt-5.4-mini — full
  user message, raw text, parse, tokens, ms), `EVIDENCE_GATE` 8 of 9,
  `PRE_EVALUATOR_GATE` × 8, `SCORE` KEPT · Low, `EXPLAIN_CHECK` accepted,
  `RESULT`, `PERSIST` skipped with reason, `DONE`. Read back through
  `/api/trace/:id`, the JSONL file, and `npm run trace`. Largest single step
  24 KB (SEARCH, which echoes the admitted matches); file 180 KB.
- `JUDGE_MODEL` remains **unverified**: the verdict was not an accusation, so
  the judge was not consulted — the same reason it has stayed unreached since
  2026-09-08. The `JUDGE` step records that as `skipped` with "this is NOT a
  pass".
- The Supabase sink is unverified until migration 009 is run; the server
  reports the missing tables once and keeps writing files.

**Logged, not fixed — found by the trace on its first run.** Run
`2ac5a69e-54ce-4847-8678-237812098ebc` was started with `DEMO_MODE=true
FIXTURE_MODE=true` forced and the real keys still in the environment. The
banner read "No API keys are configured … nothing here is a real
accountability finding", and the trace showed **six live model calls**:
`CLASSIFY_MODEL` on haiku (which overrode the stub's "Budget & Economy /
Inflation" to "Health Care / Prescription Drugs"), `RELEVANCE` × 3 and
`FULFILLMENT` × 2 on gpt-5.4-mini. DEMO mode stubs only the orchestrator loop;
`interpretPromise`, `searchActions` and `evaluateEffectsTool` key their legs
on credential PRESENCE, not on the mode. In the ordinary no-key setup the two
coincide and the banner is true. With the modes forced and keys present, the
banner asserts something false and money is spent. Not reached by any deploy
today (Render infers both modes from keys); flagged because it is the copy
defect class that matters most here.

**Only Matthew can do:** run `docs/migrations/supabase-migration-009-query-trace-log.sql`
as `postgres`.

## 2026-09-20 — the explanation prompt diverges from WF11 `Build Prompt`, deliberately

`orchestrator/prompts.ts` `EXPLANATION_CONSTRAINTS` was a near-verbatim port of
WF11's reasoning-only `Build Prompt`. It is no longer a transcription, and the
divergence is the correct one for this tool.

**Why.** WF11 writes for a senator profile: a summary of a computed score.
The query tool answers one person who typed a statement. Matthew's 2026-09-18
review: the explanation "doesn't come across as conversational … explaining
to them how we got this evidence based on the initial query." On the
gun-safety run the shipped text opened "Senator Schumer co-sponsored
multiple bills…" and never mentioned that three of the five admitted bills
had been set aside as a different object — the reader saw them on the cards
below with no account of why they did not count.

**What changed.** The shape on top of the constraints, not the constraints.
Three candidate shapes were sampled against the frozen results of two real
runs (`d98db78f…` gun safety, `154ddde8…` clean air) and the current prompt
replayed the same way as a baseline. Chosen: "direct reply" — name the
question, say what was found and what the senator did, say what it means in
the statement's vocabulary, then a REQUIRED sentence for anything seen and
set aside, then the limit of the evidence. The set-aside sentence is
borrowed from the "walk-through" candidate, which was the only one that
accounted for the neutral rows on both runs. Per-card lines are now asked
for on neutral cards too, saying why the bill did not count.

**Unchanged, verbatim from the port:** never recompute, never contradict the
verdict, never attribute motive, no statistics vocabulary, the CRA
NAY-preserves rule, cloture and passage named separately, sponsorship weaker
than a vote. Plus the statement-type vocabulary rule from PR #14.

**Found while sampling, logged not fixed:** the motive-word guard in
`explanationProblems` flags "avoid" when it describes what a facility does
under a rule ("reclassified to avoid stricter controls"), not the senator.
The rejection costs a rewrite turn, not a result. Worth scoping the motive
list to sentences about the senator.

**Verified live** (`DATABASE_URL` blank, run `77b8aa22-ba45-4a82-95e9-b769442043d0`,
the gun-safety statement): the reply opens "You asked whether Schumer has
backed…", names S.3214 and S.494 with their Congress, gives the set-aside
sentence for the safe-storage and assault-weapons bills (neutral) and the
PLCAA and CDC bills (dropped at relevance), and closes on the limit —
co-sponsorship only, and red flag laws untested. Accepted by the wording
guard on the first draft; six connector lines, one per card including the
neutral ones.

**n8n side:** nothing to adopt. WF11's audience is the profile; this shape is
for the query tool only.

## 2026-09-20 — follow-up questions, explain-only, not persisted

Matthew's 2026-09-18 review, point 5: "what if someone has a follow-up
question on this query? The current system only allows them to launch a new
query." Two shapes were on the table — explain-only, or refine-and-rerun
(a follow-up that changes the question and re-runs from embedding). He chose
explain-only.

**What shipped** (`packages/server/src/followup/`, `POST /api/followup`,
`web/components/FollowUp.tsx`): one non-streamed call on the explain model,
answering from a compact context built from the run's trace — the parsed
findings of every gate, never the raw evaluator prompts, which are ~40k
tokens of inputs rather than findings. The system prompt bars a new verdict,
re-weighing, motive, statistics vocabulary, anything outside the run, and
requires the statement-type vocabulary. The answer passes the same
`explanationProblems` guard as the explanation: one retry with the problems,
then a refusal rather than a rendered bad draft. Rate-limited as a query.
Hidden in demo mode (`followups_available` on `/api/senators`).

**Decision, assumed and stated:** the exchange is NOT persisted. It lives in
the tab; the only record is the follow-up's own trace run
(`meta.followup_of` names the original). Reasoning: a follow-up is user text
about a user query, and writing it to `app_queries` would widen the training
column without a decision to. Reversible if wanted — the trace already holds
every exchange for `TRACE_MAX_FILES` runs.

**Not a pipeline concern.** No n8n equivalent; nothing to adopt either way.


## 2026-10-07 — the query's embedded text departs from WF7a, deliberately

**The departure.** WF7a `Promise Embedding Text` fills two lines with
model-written prose: `Key Policy Terms` (the classifier's terms) and
`Reasoning` (the classifier's one-line rationale). The query tool now fills
them deterministically:

| Line | WF7a (and the query tool before) | Query tool now |
|---|---|---|
| `Key Policy Terms` | classifier output, `', '`-joined, or `NA` | the user's corrected terms when they gave some; otherwise the taxonomy lookup for (Primary Issue, Sub Issue) — the same keywords as `Related Terms` |
| `Reasoning` | classifier output, or `NA` | `NA` always |

Every other line is unchanged, and the template is unchanged
(`embeddings/promiseEmbeddingText.ts` is still the WF7a port; the change is
in what `dispatch.ts` passes it). The interpretation shown to the reader
still carries the classifier's terms and reasoning.

**Why.** The classifier samples both lines afresh on every call, and they
reach the query vector. Stability measurement, 2026-10-07 (six promises ×
five runs, `tools/stability.mts`): five runs of one question produced five
embedded texts, and the retrieved top-10 overlapped as little as 28%
(Schumer, drug prices) and 57–83% elsewhere. Retrieval only, with the two
lines made deterministic: one text per promise, top-10 identical across every
repeat of all six. Recall cost, all near the WEAK floor (0.50–0.52):
`Key Policy Terms` = `NA` lost a clean-energy-credit bill and a Senate
climate resolution on clean energy; the taxonomy version lost only the
resolution, and is the one adopted. Both gained four unrelated tax bills near
the floor on the death-tax question, which the relevance step filters.

**What it does not fix.** The judges still sample. With the interpretation
frozen, the clean-air question still flipped BROKE/KEPT — that came from the
version summaries of sjres31-119 describing the overturned rule backwards
(flagged upstream 2026-10-07), not from retrieval.

**Corrections keep their effect.** `orchestrator/corrections.test.ts` pins the
rule that every correctable field is inside the embedded text. A user's
corrected key terms are deterministic, so they go in; the taxonomy keywords
stand in only when the user gave none.

**For the pipeline.** Not a proposal to change WF7a: the batch pipeline's
per-statement evaluations are not re-run per request, so its run-to-run
variance does not reach a reader the same way. Recorded so a future
re-verification of the port reads this as deliberate, not drift.

---

## 2026-10-10 — the evidence floor departs from WF7a, deliberately

**What.** `scoring/config.ts` `SIMILARITY.STRONG`, the evidence floor, is
0.50, down from WF7a `Parse and Store Matches` `STRONG_THRESHOLD` 0.575. It
now equals the retrieval floor (`WEAK`), so every retrieved candidate that
survives the relevance check is weighed and `ALL_BELOW_FLOOR` no longer
occurs. The card's "closely / loosely related" wording keeps the old line in
a new display-only constant, `SIMILARITY.CLOSE` = 0.575, so a 0.51 match is
still described as loosely related.

**Why.** The accuracy set's first run (`docs/eval/cases.json`, #47): in seven
of eight failing cases a listed bill had been retrieved and confirmed by the
relevance check, then scored 0.50–0.573. The 0.575 line was calibrated on the
corpus's promise text (GPT-4.1 terms); the query tool's text scores lower
against the same bill vectors (the gap recorded on 2026-09-07 above, still
unexplained). A replay of that run at 0.50 from its traces
(`tools/replay-floor.mts`) admitted no wrongly-directed bill. Precision is the
relevance gate's job, not the threshold's — WF7a's own reasoning when it
moved from 0.60 to 0.575 on 2026-08-09.

**What it does not change.** No model call depends on the floor: relevance
and the evaluator already ran on every candidate at or above 0.50. The band
bar (`HIGH_AVG_STRENGTH` 0.65) is unchanged, so newly admitted matches can
only lower a band.

**For the pipeline.** Receipts and the senator profile now disagree on which
matches count. Not a proposal to change WF7a until the batch pipeline is
measured the same way.

The same day, two changes with no pipeline counterpart: the classifier prompt
(written here, not ported — see `evaluation/classify.ts`) gained a rule to
classify the policy itself rather than the speaker's name for it, and the
NOT_EVALUABLE copy now says the statement is too broad to hold against
specific bills.

---

## 2026-10-10 — the bill-effect evaluator departs from WF10A v7, deliberately

**What.** The query path's fulfilment evaluator runs Receipts' own prompt v8
(`docs/fix/08_evaluator_prompt_v8_bill_only.md`, generated into
`evaluation/evaluatorPromptV8.ts`), not WF10A's v7 (`docs/fix/07_…_v7.md`, kept
as the record of what the pipeline runs). v8 judges the BILL only: same object,
and what the bill does to the statement's goal. The user message no longer
carries the `## SENATOR'S ACTION` section (role, cloture and passage votes,
cloture result, party whip, party alignment, sponsorship, action date, vote
flags) or the statement's role condition. Nothing in the message identifies
the senator. The model returns no alignment; `model_verdict` records `NA`.

**Why.** The accuracy set's second run (#48) showed the action leaking into
the bill reading. The same statement and the same bill came back NEUTRAL for
Schumer and ADVANCE for Thune (sjres81-119), and NEUTRAL and HINDER
(hjres39-118). And a majority leader's YEA on a failed cloture motion
(Thune, s5271-119) was read as a leader's procedural switch — a rule that
applies only to a NAY — and the bill marked NEUTRAL, so the vote counted for
nothing. A bill's effect on a goal does not depend on who voted on it.

**Where the removed rules live.** Every rule v7 applied to the action is
executed in code and was already: the cloture/passage precedence and the
sponsor-NAY switch (`scoring/deriveAlignment.ts`), the statement window (G1a),
the role condition (G2), the floor-leader switch (G3, NAY-only), and the
split-vote confidence cap (contract 2, `capSplitConfidence`). The leader and
sponsor exemptions are pinned NAY-only by `scoring/leaderYeaGuard.test.ts`.

**What changes in meaning.** `confidence` (stored as `alignment_confidence`,
read by the 0.7 accusation floor) now measures how defensible the reading of
the bill is, not of the whole verdict. The prompt keeps the policy-position
penalty and the broad-vehicle and policy-position caps. Lost: the model's
"cloture-only vote" weakness, which lowered confidence by one band.

**For the pipeline.** WF10A still runs v7, so the senator profile still
judges bill and action together. Not a proposal to change WF10A until the
batch pipeline is measured for the same leak.

---

## 2026-10-10 — the statement's own words set its stance

**What.** `interpret_promise` (`orchestrator/dispatch.ts`) now takes the stance
from the statement's opening word when it has one
(`evaluation/statedStance.ts`): "supports …", "promised to …", "voted for …"
are In Favor; "opposes …", "against …", "voted against …" are Opposed. That
word wins over the orchestrator and the classifier; a reader's correction
still wins over it. When it overrides the classifier, the disagreement is
logged with the others. And when the classifier's paraphrase is in the other
frame, the reader is shown the statement itself instead. A statement with no
such opening keeps the classifier's label. The classifier prompt gained the
same rule: stance is relative to the policy the statement's own words name,
and `restated` is written in that frame.

**Why.** Evaluator v8 reads the statement as typed together with the stance
label: the goal is "the direction the statement wants". The classifier
sometimes labelled the underlying object instead. Eval case 40, run
`fb5fcdba-4d23-4427-abb5-5b56165de898`: "supports ending tariffs on imported
goods" was labelled Opposed (to tariffs). The evaluator then wrote "the
statement is opposed to ending tariffs on imported goods" and read two of
three identical resolutions ending the tariff emergencies as HINDER. The
verdict was withheld, not published. The same day's traces had "supports
overturning California's electric vehicle rules" and "supports restricting
abortion" labelled Opposed, and "supports protecting clean air standards from
rollback" paraphrased as "Opposes elimination or weakening of …" beside an In
Favor label.

**What it does not change.** The evaluator prompt and its input format are
unchanged (the golden snapshot still passes); only the label's value changes.
The label is also in the embedded text, so the query vector moves by that one
word when the label flips.

**For the pipeline.** WF3's classifier labels stored statements on its own
terms, and WF10A reads them with v7. Not a proposal to change either until
the stored statements are checked for the same mismatch.

---

## 2026-10-11 — a near-miss review below the evidence floor

**What.** When the relevance check admits nothing, the best near misses
under the floor go to the same relevance check: up to five
(`NEAR_MISS_REVIEW_LIMIT`), scored from `SIMILARITY.REVIEW` (0.45) to just
under 0.50 (`orchestrator/dispatch.ts`, trace stage `NEAR_MISS_REVIEW`).
Whatever it admits is weighed: the scorer takes `evidence_floor: REVIEW`
for that answer only. Reviewed bills are labelled loosely related. Every
other answer keeps the 0.50 floor.

**Why.** Trace `7e1e8f99` ("He promised not to raise my taxes", Schumer):
all ten candidates scored 0.45–0.499, with the 2025 reconciliation tax law
(`hr1-119`) at 0.473, and the answer was "nothing found". Case 10's run
showed the trigger has to be "nothing admitted", not "nothing over the
floor": one off-topic bill at 0.509 cleared the floor, the relevance check
rejected it, and that alone blocked everything under it.

**Measured.** Four live questions (2026-10-11):
- drug prices, drug-price negotiation (case 10) and Dreamers: the review
  checked five near misses each and the relevance check rejected all of
  them, so the answer stayed "nothing found";
- insulin: it admitted S.4886 (Medicare out-of-pocket protections) as
  related but not specific, shown as not counting either way.

No wrongly directed bill was admitted. The cost is five extra relevance
calls, only on answers that would otherwise be empty.

**Not fixed by this.** Case 51, the taxes question itself, still fails:
- the classifier files it under Tax Cuts & Credits on some runs;
- three bills then clear the floor, so the review never triggers;
- it also flips between checkable and too broad.

That is the vague-question problem, left for asking the reader which taxes
they mean. Any rewording we add must be shown to them and accepted, never
applied silently.

**For the pipeline.** WF7a has no counterpart; the batch scorer has no empty
answer to protect. Not a proposal for the pipeline.

The same day, the stated-stance rule gained "promised not to …",
"pledged not to …", "will not …" and "won't …" as Opposed
(`evaluation/statedStance.ts`).

---

## 2026-10-17 — what follows is reconstructed

The entries from here down to the end of the file were written on 2026-10-17,
after the fact. They draw on merged PR descriptions (#60–#100), commit messages,
`docs/v2/phase-3-report.md`, `docs/v2/plan.md`, and the headers of migrations
016–022. They were not written down at the time each decision was made. Each
entry names its sources. Where the sources give no reason, or say nothing about
what was given up, the entry says so; nothing has been filled in.

Many of these are product decisions (wording, layout, payments), not pipeline
reconciliation. They are here because this file is the project's record of
what was decided and why.

---

## 2026-10-11 — v2 Phase 2: the query tool reads `core` behind switches that stay off

**What.** The query tool could read the new Supabase `core` schema through
`compat` views shaped exactly like the mirror (migration 015), and search a
member's bills with exact pgvector search (`SupabaseActionStore`). Both were
behind settings (`RECORD_SCHEMA`, `ACTION_STORE`) that defaulted to the old
mirror and Pinecone paths, so production did not change. The new store kept
today's Action UIDs and rounded scores to Pinecone's nine significant digits.

**Why.** The v2 plan's rule: nothing a voter sees changes until the new system
is proven equal to the old one on the eval set (`docs/v2/plan.md`, Goal).
Gate G2 compared rankings: the same bills came back in 48 of 49 cases. Gate G3
compared verdicts: 40/49 passed on both stores, with every difference traced
to a model stage.

**Given up.** The plan's G2 test, "equal to three decimals", could not hold
against an approximate reference: Pinecone's scores are off by up to 0.0011,
while pgvector's are exact. The report proposed reading G2 as "within
Pinecone's measured error" instead.

**Data change.** 90 blank Senate LIS IDs in `core.members` were filled from
legislators-current (`ingest_runs` #9), with approval.

Sources: #66, `docs/v2/phase-2-report.md`, migration 015.

---

## 2026-10-11 — the whip vote is the senator's own party's

**What.** Enrichment matched `Party Vote Positions` on the roll call alone,
so whichever party's row came back last won. It now matches on roll call *and*
the senator's party. An independent matches neither row, gets no whip vote, and
the party-line checks fail open, as they already did when the vote was missing.

**Why.** Measured against the mirror: Thune got the other party's row on 24 of
57 cloture actions, and Schumer on 33 of 57. The whip vote feeds G3's
leader-switch gate, the judge's T5 check, and the evaluator's "Party whip's
vote" line.

**Given up.** No eval run before merging ($2–6, offered, not asked for). Some
answers on cloture votes could change; the PR calls that the point of the fix,
but a change voters could see.

Source: #67.

---

## 2026-10-11 — the answer comes first, and "nothing found" says where the records start

**What.**
- The result page leads with the answer: what the search did, with three
  numbers (actions searched, came close, about your question), and two next
  steps (#60). It became one answer bar over three tabs, Why, Receipts and
  How we checked, with the chat beside it (#69).
- The coverage boundary stays on Why, the tab that opens first (#69).
- A no-results answer (`NOT_DETERMINABLE · NO_MATCHES`) says on the bar:
  "Our records start in January 2023. If they acted on this before then, it
  isn't in what we searched." The date comes from the result's own coverage
  window, never a hard-coded value (#70). The same day,
  `COVERAGE_CONGRESSES=118,119` was set on Render (#71).
- The waiting screen shows one card for the question. "Not quite right?
  Change it" stops the run and puts the statement back to edit. The check
  keeps running while the reader reads (#68).
- "We checked whether Schumer **promised** …" described the wrong check, so
  the line now names the votes and bills ("whether Schumer's votes and bills
  follow through on a promise to …") (#69).

**Why.** Before #60 the answer sat below the fold. For the boundary: false
absence is the sharpest risk, so it is never a click away (#69). The
drug-prices question (trace `5bda0373`) found nothing, and that was correct:
the 2022 Inflation Reduction Act is before the records start. But "nothing
found" is easily read as "did nothing" (#70).

**Given up.** A confirm-first step on the waiting screen. #68 records it as the
owner's choice: most readings are right, and waiting for a "yes" would slow
every one of them. Inactive tabs are hidden rather than unmounted, so the page
markup still holds the whole answer for the eval's wording checks (#69).

Sources: #60, #68, #69, #70, #71.

---

## 2026-10-11 — every topic starter is an eval case

**What.** The 25 topic starters under "Need help phrasing it?" became eval
cases 26–50. Six returned no verdict on the first live run. Four were
replaced with questions the record can answer, each run live first, and two
were removed (#62). The "Try" example under How to ask, the 15-week question,
was swapped for eval case 29 after the stance fix left it "doesn't settle it"
(#65).

**Why.** The PRs give no reason beyond the titles: replace the starters that
find nothing. Case 22 (15 weeks) stays, now expecting the honest answer,
NOT_DETERMINABLE, because the record holds no 15-week bill (#65).

**Given up.** Balance. Immigration's two starters and Environment's two now
lean one way. The examples that balanced them (Dreamers, oil and gas) find
nothing in the record (#62).

Sources: #62, #65.

---

## 2026-10-11 — ask which policy before checking a broad statement

**What.** A statement that names a side but not a policy ("He promised not to
raise my taxes") gets a "Which taxes do you mean?" card with 2–4 options. Each
option shows the exact text we would check, and nothing is checked until the
reader picks. It is one small classify-model call (`cleanup/askWhich.ts`)
behind `ENABLE_QUERY_CLEANUP`. A code check drops any option that:
- takes the other side;
- leaves the reader's topic;
- uses a camp's label;
- opens with a pronoun or is a question.

If fewer than two options survive, nothing is asked. A failure means the
statement is checked as typed, and the reader is never asked twice.

**Why.** The classifier filed the taxes statement under different categories
from run to run, and flipped between "checkable" and "too broad". "Guessing
which taxes the reader meant would misrepresent their intent, so we ask them."
This carries out the rule left open on 2026-10-11 above: any rewording must be
shown to the reader and accepted, never applied silently.

**Given up.** One extra model call per statement while clean-up is on, and a
step for the reader on broad statements. Like "which way?", the stop gives the
daily check back.

Source: #72.

---

## 2026-10-11 — the bill's path is built in code; the card's chip says how the bill counts

**What.** Each evidence card has a chip in the corner: Counts toward, Counts
against, or Not counted. A not-counted chip always says why. "The bill's path"
(introduced, text versions, the senator's own act, how it ended) is built from
the record in `scoring/billPath.ts`, "never by a model". The model-written
per-card line no longer says whether the bill counts, so it cannot contradict
the chip.

**Why.** The per-card line stopped saying whether the bill counts "so it can't
contradict the chip". No reason is written down for building the path in code
rather than by a model.

**Given up.** The prompt change altered the pipeline fingerprint, so stored
answers were recomputed on first ask.

Source: #73 (#96 later widened the path to the full card).

---

## 2026-10-12 — "Why" on an answer that doesn't settle it: the explainer's paragraph, under a direction guard

**What.** On a not-determinable answer, the Why tab shows the explainer's
paragraph, then one fixed sentence: "Why there's no verdict." For a reading
the second check held back, that sentence is written in code, one per kind of
objection (`JUDGE_REASON_COPY`). It is not taken from the check's critique. A
new guard refuses the paragraph if it gives a direction ("runs counter to",
"is consistent with", …). Negations and open questions ("whether it lines up
with") are allowed.

**Why.** The canned line said nothing about the question, while the
explainer's paragraph, often the slowest step, was thrown away. The fixed
sentences are in code "because the critique argues about the accusation we
chose not to make". The guard exists because the held-back taxes answer (run
`8c6bcba0`) said "his action runs counter to the position", the very
accusation the check had withheld.

**Given up.** Not recorded. In the live check, the first version of the guard
refused two acceptable drafts that put direction as an open question, so
"whether" and "if" were then treated like a negation.

Source: #74.

---

## 2026-10-12 — a second near-miss pass after the bills are read

**What.** The near-miss review (2026-10-11 above) also runs inside
`evaluate_effects`, once per run, when the answer is "doesn't settle it"
because nothing admitted counts (`NO_MATCHES`, `ALL_NEUTRAL`, `GATED`,
`UNDIRECTABLE_METADATA`). Bills already read keep their readings. It never
runs after a reading was held back after review.

**Why.** One loosely related bill blocked the first review. On case 51 (run
`34e21977`) a savings-account bill was admitted and read as neutral, and the
2025 tax law (H.R.1, 0.483) was never looked at.

**Given up.** Up to five more relevance calls, plus one reading per newly
admitted bill, on answers that would otherwise not settle it.

Source: #75.

---

## 2026-10-12 — v2 cutover: Supabase `core` is the system of record

**What.** Done with the owner present, in the order `docs/v2/plan.md` sets:
- the v2 orchestrator writes impact statements in `live` mode;
- the statement copy from the Sheets is disabled, not deleted;
- Render reads `RECORD_SCHEMA=compat` and `ACTION_STORE=supabase`;
- the old orchestrator and Mirror Sync are unpublished, not deleted;
- the workbooks are view-only.

The eval on the production settings passed 42 of 50. The 8 failures were the
same cases that failed in both Phase 2 runs, with the same verdicts ($5.00).

**Why.** The v2 plan's goal: one database holds the whole record, so adding a
member is a flag and a data pull, not a new pipeline run through spreadsheets
(`plan.md`). Two data errors found on 10 October were stored copies gone
wrong, hence its rule "derive, don't copy".

**Departure from WF5.** v2 fetches every bill's text and passes it to the
model inline, where WF5 told the model to browse to it. This fixed three bad
samples and costs about $0.04 a statement (#76).

**Given up.**
- The third G4 day. The plan asked for three clean days; the owner accepted
  two (11 and 12 October).
- The Sheets stopped updating from that night, so a rollback would serve the
  record as of 12 October.
- The daily G4 comparison now reports differences as `core` moves ahead.

Rollback was planned to stay open until 26 October, but see 2026-10-14.

Sources: #76, #77, `docs/v2/phase-3-report.md` (Cutover), `docs/v2/plan.md`.

---

## 2026-10-14 — the mirror schema dropped early; the server reads only `compat` and `core`

**What.** The `mirror` schema was dropped on 2026-10-14, twelve days before
the two-week window closed. A backup is at `.backups/mirror-2026-10-14/`, local
only and not in git. The server then lost its `RECORD_SCHEMA` and
`ACTION_STORE` switches, the `PINECONE_*` settings and the Pinecone store.
Fixture mode is now inferred from `OPENAI_API_KEY` + `DATABASE_URL`.
`MirrorEnrichmentSource` keeps its name and `kind: 'mirror'`, because stored
traces and answer events carry that value.

**Why.** `plan.md` records the drop as "done early, 14 Oct, at the owner's
request". **Why it was done early is not written down.** The code change
followed because the server still defaulted to `mirror`, so any run without
Render's settings (local dev, `npm run eval`) failed on its first record read
(#82).

**Given up.** Rollback in two settings. Rollback now means restoring the
mirror from the local backup. Pinecone data and the Render settings were left
in place, now ignored.

Sources: #82, `docs/v2/plan.md` (Phase 3).

---

## 2026-10-14 — the v2 statement workflow departs from WF5 in four more places

**What.** All four were published to n8n on 14 Oct:
1. **IDs.** A bill-level statement keeps its existing ID, and a new one gets
   `BL-<bill id>`. WF5's 6-character hash had collided across congresses
   (s342-118 and s342-119 were both `183U8V`) (#78).
2. **Dropped text.** Bare "Omnibus" in the large-bill list matched every bill
   amending the Omnibus Crime Control Act, so it now matches only "Omnibus
   Appropriations" and "Omnibus Consolidated". The readable-ratio check no
   longer counts GPO's ruled lines as noise (#79).
3. **Fetch again, never write "unavailable".** The bill fetch retries three
   times and falls back to the GovInfo copy when congress.gov keeps failing.
   When there is no BILLSTATUS summary, the model gets the bill's own text (#85).
4. **Budget.** The monthly stop was raised from $25 to $100, approved by the
   owner on 14 Oct (#80).

**Why.** Each fixes statements that came back empty or guessed:
- five for Collins and Ossoff (#79);
- eight in Collins' 118th Congress run (#85).

Without the budget change, October's spend ($21.59) and the senators still to
run would have stopped all statement writing until 1 November (#80).

**Given up.** Not recorded beyond the cost. Existing IDs were kept so nothing
already written moved.

Sources: #78, #79, #80, #85.

---

## 2026-10-14 — show the bills we read and did not count, each with its reason

**What.** `QueryResult.not_counted` lists each bill the relevance check read
and did not admit. Each carries what the senator did, a tier (`related` or
`unrelated`), the check's own reason (bookkeeping trimmed, nothing reworded)
and a link. The Receipts tab shows "Related bills we didn't count" (open) and
"Also looked at, not about this" (folded). Vote labels in those rows name
cloture and passage from their own slots (#84).

**Why.** Readers saw "found 2" when the senator clearly had more on the
subject. The owner asked (14 Oct) to show all of it in tiers, with the
reasoning, "without changing how the verdict is reached and without reading
deeper (budget)". #84 fixed rows that said "on passage" when the only vote
was cloture.

**Given up.** Reading deeper than the top 10. The relevance model judges each
bill on its own, so near-identical bills can land in different tiers.

Sources: #81, #84.

---

## 2026-10-15 — `core.members` keeps members who have left, and adds former senators

**What.**
- **Migration 017** adds `core.members.left_at`, where NULL means serving.
  The members workflow reads legislators-historical. For a member already in
  `core.members` whose last term ended inside the record, it sets `left_at`
  and `term_end`, and fills a blank LIS ID. It never overwrites an ID (#83).
- **Former senators are added** when their last term was in the Senate and
  ended after 2023-01-03. Each gets `in_scope=false`, `live=false`, and the
  insert never touches an existing row. That is 17 rows: Feinstein, Menendez,
  Butler, Helmy, Brown, Cardin, Carper, Casey, Stabenow, Tester, Manchin,
  Sinema, Braun, Romney, Vance, Rubio and Sasse (#86).

**Why.** Votes join to members on `lis_id`. Graham and Mullin had none, and the
16 departed senators had no row, so about 1,560 stored Senate positions joined
to no one (410 per migration 017, 1,153 per #86). Nothing marked a member as
gone.

**Given up.** Scope was the owner's call (14 Oct): Senate only, served in the
record. The rule as first briefed (both chambers, `>= 2023-01-03`) would have
added 164 rows, 74 of them people who left on 3 Jan 2023 and never cast a vote
in the record. Former House members are not added. The `VP` voter ID (one
tie-break) stays unjoined. Anything counting "current senators" must filter
`left_at IS NULL`.

Production state: by #88's dry run on 15 Oct, `core.members` held 566 rows,
539 of them serving. The repo has no separate note of when 017 was applied.

Sources: #83, #86, #88, migration 017.

---

## 2026-10-15 — members run daily, cross-checked against congress.gov

**What.** congress-legislators stays the source of record. The members
workflow runs on every daily run, not only Mondays. It compares the source with
congress.gov's current-member list on bioguide ID, chamber, state, district and
party. An email alert fires when an arrival, departure or disagreement touches
an in-scope member, or when a disagreement lasts `disagree_days` days (proposed
N = 3). Each item alerts once. Nothing is looked up at query time.

**Why.** The PR gives no reason beyond adding "a daily official cross-check
and an alert". The surrounding context is the 2026-10-15 members entry above:
departures had gone unnoticed.

**Given up.** Not recorded. The PR says nothing was published to n8n or
written to the database at merge. Each rollout step needs the owner's yes, and
the repo does not record whether it has been published since.

Sources: #88, `docs/v2/members-crosscheck.md`.

---

## 2026-10-15 — confidence measures how clearly the evidence answers, not how much there is

**What.**
- **The band.** `bandFor` no longer counts matches or reads search
  similarity. Each action is classed on its own, and the clearest one sets
  the band:
  - High: a final vote on a bill squarely about this, with certainty ≥ 0.8.
  - Medium: a vote to end debate only, a sponsorship, a broad package, or
    certainty 0.6–0.8.
  - Low: indirect evidence, a partial match, certainty < 0.6, or a
    near-miss-only find.

  `receipt.band_reason` names the reason, and mixed records keep the High cap.
- **Vote tallies.** Real tallies (`vote_context`) are counted from
  `core.member_votes` and `core.roll_calls`, for display and explanation only,
  never for scoring.
- **The explainer.** It takes WF11's nonpartisan-analyst role and writes a
  `card_summary`. Every number in the summary must be one the result handed
  over (`figuresNotGiven`).
- **No dashes.** Em dashes, en dashes and semicolons are removed from reader
  copy, and `sanitizeReaderText` runs over every reader-facing field.

**Why.** Feedback on the Collins ACA result (15 Oct): the numbers didn't add
up, and "Low confidence" stood alone even when the one bill found was the only
vote ever held on the issue. The tallies come from the record because draft
wording had S.3385's cloture vote as 51–49; it was 51–48. The owner approved
the plan, including the change to how confidence works.

**Given up.** Bands moved in the eval on purpose, with no verdict expected to
change. The prompt change emptied the 24-hour answer-reuse cache.

Sources: #87, commit `132920a`.

---

## 2026-10-15 — the waiting screen narrates each step, with no verdict mid-run

**What.** While a check runs, the waiting screen streams `note` events:
- stage;
- a summary line per subtask, with live counts;
- a line per bill, behind a closed drop-down.

Every line is built in code (`orchestrator/narrate.ts`) from what the pipeline
decided. A per-bill line says which way the *bill* pushes, never kept or broke.

**Why.** The PR states the contracts, not the motive. The verdict is decided
after every bill is read, and the judge can still hold it back, so no verdict
words appear mid-run. Raw model reasoning is written for the pipeline, so it is
never shown.

**Given up.** Notes are not recorded for replay, so a replayed answer shows no
narration.

Source: #89.

---

## 2026-10-15 — readers can pay to have a member's record added (off by default)

**What.**
- **Payment.** A reader can pay once (default $20) through Stripe Checkout to
  have a not-yet-checked member added. A payment writes one row to
  `app.member_funding` (migration 018) and nothing else. It does not set
  `in_scope`.
- **Operator steps.** An operator runs the usual steps (`plan.md`, "Funded
  members") and refunds if the member is not live in time.
- **Off by default.** It stays off unless the migration is run, the Stripe
  keys and webhook are set, and `ENABLE_FUNDING=true`.
- **Requests.** Free requests move from `.data/queue.log` to
  `app.member_requests`.
- **Directory.** `GET /api/members` lists every serving member, so anyone can
  be found (#91).
- **Policy pages.** Terms, Privacy and Refunds were added (#92).

**Why.** Adding a member costs real money: Ossoff about $12.90 and Collins
about $18.77, mostly impact statements. Funding tests "whether readers want a
member enough to pay for it". The queue log was lost on every deploy. Stripe's
reviewers look for terms, privacy and refund pages before approving a live
account.

**Rules.**
- Payment buys the work, never a finding: same pipeline, same hand review.
- Being listed is not coverage: `cached` still comes from `senatorCache`'s own
  rule.
- It is called "funding", not "sponsorship", because "sponsorship" already
  means bill sponsorships here. On 2026-10-16 the reader-facing word changed;
  see below.

**Given up.** The hand-kept "Being added next" list, which funding replaces.

Sources: #90, #91, #92, migration 018.

---

## 2026-10-15 — record questions: answered from the record with a label, never graded

**What.**
- **Intent check.** A check on the voter's own text, before any rewrite, sorts
  input into STATEMENT, RECORD_QUESTION or UNCLEAR (`cleanup/inputKind.ts`).
  Rules decide first, then one classifier call. Below 0.7, or on failure, the
  voter is asked.
- **The label.** A record question ("Did they vote to extend the enhanced ACA
  tax credits?") takes its own path. It is answered with one of six labels
  (`VOTED_FOR`, `VOTED_AGAINST`, `MIXED_RECORD`, `SPONSORSHIP_ONLY`,
  `ONLY_BROAD_VOTES`, `NO_RECORDED_ACTION_FOUND`), and no verdict or band.
- **Tool sequence.** The path is a fixed sequence with no scope check and no
  judge. Its explanation has its own wording check
  (`recordExplanationProblems`).
- **Migration 021** adds `input_kind` and `answer_label` to `app.app_queries`.
  It was applied to production on 2026-10-15, at the owner's word, and merged
  on 2026-10-17.
- **Entry page.** It now says questions are welcome, not only statements:
  option A, the owner's choice on 15 Oct.

**Why.** The sources state the rule rather than argue for it: a record
question is "never graded as the senator's own statement" (#100, migration
021). A stored record question is never evidence about a senator, same as a
statement, so the firewall is unchanged. **Why the path has no scope check and
no judge is not written down.**

**Later refinement (17 Oct, the owner's choice).** When a senator backed a
bill and their only vote was set aside by the leader-switch rule, the label
stays `SPONSORSHIP_ONLY`, because the six labels are what 021 accepts. A new
reason says so: "Backed a bill on this. Their only vote on it was set aside."
The earlier wording, "no recorded vote", was untrue for Schumer in cases 21,
23 and 28.

**Given up.** Not recorded.

Sources: #100, commits `31070dd`, `785fb45`, `e562df0`, `e9b2ab2`, `4059666`,
migration 021.

## 2026-10-16 — funders credited by name, House members fundable, a 7-day promise; the app cannot read payer emails

**What.**
- **Credit.** A payer may give a name, shown publicly only once the row is set
  `live`. The operator reviews the name at go-live and can clear it
  (migration 019).
- **Go-live email.** A go-live email is promised and recorded once
  (`notified_at`). Nothing sent it at merge (#93).
- **House members** can be funded too (#94).
- **Free requests.** "Request this record" is on every unchecked card, with no
  email and no account.
- **Seven days.** The promise drops from 14 days to 7 (`FUNDING_SLA_DAYS`)
  (#94).
- **Grants fix (migration 020).** It revokes `receipts_app`'s table-level
  SELECT on `app.member_funding` and grants back only the seven columns the
  app uses.

**Why.**
- Credit: funding "should come with a benefit". The email gives funders a
  reason to come back (#93).
- House, free requests and 7 days: the owner's call. "If people want a record
  we should build it, and if they'll pay for it we should do it, House members
  included, and faster than 14 days" (#94).
- Grants fix: checked on 16 Oct, the app role could read every column, payer
  email included. The `app` schema's default privileges had granted
  table-level SELECT, and a column grant does not narrow a table grant.

**Given up.** The query tool still reads Senate members only. A funded House
member needs the Phase 5 House work within 7 days, or the payer is owed a
refund (#94).

Sources: #93, #94, migrations 019 and 020, commit `c188a08`.

---

## 2026-10-16 — readers "sponsor" a record; the code keeps "funding"

**What.** Reader-facing copy changed from funding to sponsoring:
- the button reads "Sponsor this record — $20";
- the credit reads "Sponsored by {name}";
- the Terms section is "Sponsoring a record".

The pitch sells what the sponsor gets: the record checked within the promised
days or a full refund, their name on it, and an email when it's ready. Code,
tables and env vars keep the name "funding". Prices, payments, refunds and the
database are unchanged.

**Why.** Option A, the owner's choice on 16 Oct. "Pay $20 so it's free for
everyone" made payers feel they were paying for other people's benefit.

**Given up.** "Free for everyone" as the selling point; a test fails if the
pitch says it again. The record is still public, and the Terms say so in one
sentence. The reader-facing word now differs from the internal one, which
2026-10-15 chose to avoid a clash with bill sponsorships. That clash remains
avoided in code only.

Sources: #95, `docs/v2/plan.md` ("Funded members").

---

---

## 2026-10-17 — a promise the reader typed is answered as a promise, and stays the reader's claim

**What.** When the reader's own text says "promised", "pledged" or "vowed",
the query becomes the reader's asserted promise, as the corrections panel's
"he promised this" switch already did. The headline reads "Evidence they kept
this promise" or "… broke this promise". Under it: "You said Thune promised
to …. We didn't check that the promise was made; we checked what Thune did."

A server check rejects explanations that attribute the promise to the senator
("Thune promised…", "his promise"). Text without those words is unchanged:
"supports X" stays a position.

The answer bar has one segment per bill. "Not about this" (read, but off the
question) is now separate from "set aside" (closed by a rule before weighing).

**Why.** From the owner's Thune check (17 Oct): every free-typed statement was
treated as a Policy Position, so that we never claim a senator made a promise
we hadn't confirmed. The side effect was that a promise the reader asked about
came back in position language. "3 set aside" also covered bills that were
read and found off-topic.

**Given up.** The blanket "free-typed means Policy Position" default
(2026-09-21, #14) no longer holds for promise wordings. Attribution stays with
the reader. The hint "Tap a segment to see its bill" was not yet reviewed at
merge.

Source: #99.

---

## 2026-10-17 — Stripe test and live payments on one server

**What.** One Render server holds both Stripe key pairs. Each request's mode
is decided by the site the reader is on. A host in `FUNDING_LIVE_HOSTS` is
live; anything else, including previews, localhost and requests with no
origin, is test. One webhook tries both signing secrets, and accepts an event
only if Stripe's `livemode` matches the secret that verified it. Every row is
labelled `livemode` (migration 022), and each site shows only its own mode.
Production shows no button until live keys are set.

**Why.** The owner wanted to test sponsorship on preview links without
resetting the live site afterwards, and without paying for a second server
($7 a month). "Wrong the safe way round costs nothing": a test checkout moves
no money and never shows on the live site.

**Given up.** The go-live email still goes to any row the operator sets live,
test or not. Unlabelled rows default to test on `member_funding`, so they
never show on the live site.

Sources: #97, migration 022.

---

## 2026-10-17 — migrations, queries and loose specs moved into folders

**What.** `docs/supabase-schema.sql` and every numbered migration moved to
`docs/migrations/`. `beta-review.sql` moved to `docs/queries/`, and four loose
specs to `docs/specs/`. Filenames are unchanged. A new `docs/README.md`
indexes the folders and says new migrations go in `docs/migrations/` with the
next unused number.

**Why.** The docs root had 33 entries, 22 of them SQL files.

**Given up.** Not recorded. Every reference inside the repo was updated.

Source: #98.
