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
