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

`docs/supabase-migration-003-v7-fields.sql` closes the database half:

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
