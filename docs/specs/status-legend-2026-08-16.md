# Status Legend — 2026-08-16

Vocabularies, sheet columns, workflow IDs and traps. Supersedes the 08-15
legend.

---

## Workflow IDs

| ID | Workflow | State |
|---|---|---|
| `sZ0FYT0J-8zHqsHy9yPb-` | Orchestrator | `active: false`, `activeVersionId: null`, schedule disabled |
| `nLhnLFVtkQPooyyJ` | Drain Loop (repointable) | manual trigger, runs draft |
| `N4gE8gAvyC6cw5aY` | WF2 Senate Bill Data | published |
| **`1uIqt0sVZcUvrsmv`** | **WF2b Bill Status Refresh (NEW)** | published, schedule disabled, never fully run |
| `QgLsT0CsWwFe1T6b` | WF4 Senate Roll Call | published |
| `0lCgjIQfM7XDUY8A` | WF5 Bill Impact Statement | published |
| **`sQufF4nSFoKoAoS2`** | **WF5b Regulatory Action Backfill (NEW)** | published, backfill complete |
| `2tfR7BINlNlE0KhF` | WF6 Bill Embeddings | published |
| `UOpu690tosAwbvMB` | W7a Promise→Bill | published |
| `dwO2OT2iRpR7bCov` | W7b Process & Store | published |
| `UbIYriUDKdcZRWRG` | B2P / WF8 | published |
| `Q1LEeUn0HLVHXlsR` | WF9 Bill→Platform | published |
| `BuA0XMoRIeA8K-IziChwR` | WF10A Promise Alignment | published, `active: true` |
| `WxPj36G4o5OfbgRG` | WF10B No Matches | published |
| `toxQrXxgx8QNvXoc` | WF11 Decision Scoring | published |
| `DwENAFZOlYVRS3-_Rz7dt` | Aggregation (WF12) | published, never executed |
| `nJKzPODHOSn0NQi9` | MIGRATE Match UID | `mode: dry` (disarmed) |

---

## Vocabularies

**Relevance** (`Promise Matches.Current Verdict`)
`TRUE_POSITIVE` · `PARTIAL` · `FALSE_POSITIVE` · `ERROR`

**Partial Subtype** — derived identically in W7b, B2P and WF10A's dedupe
`NA` · `SPECIFICITY` (admitted, ×0.85) · `DIRECTIONAL` (excluded) ·
`AMBIGUOUS` (conf < 0.70) · `UNCLASSIFIED`

**Fulfillment** (`Promise Alignment - Matches.Promise Alignment`)
Campaign Promise → `KEPT` · `BROKE`
Policy Position → `CONSISTENT` · `INCONSISTENT`
Both → `NOT_DETERMINABLE` · `PROCEDURAL_SWITCH` · `ERROR`

**Omission** (`Promise Alignment - Non Matches`)
`PENDING` (term active) · `UNFULFILLED` (after 2029-01-03) · `NO_PROMISE`

**Bill Effect** — `ADVANCE` · `HINDER` · `NEUTRAL` · `ERROR`

**Action tier (WF11)** — `VOTED` · `SPONSOR` · `CO_SPONSOR` · `ABSTAIN` ·
`PROCEDURAL` · `NONE`

**Vote pattern (WF11)** — `DECISIVE_BLOCK` ×1.15 · `CONSISTENT_OPPOSE` ×1.05 ·
`CONSISTENT_SUPPORT` ×1.05 · `PASSAGE_ONLY` ×1.00 · `NO_FLOOR_ACTION` ×1.00 ·
`BLOCKED_THEN_JOINED` ×0.90 · `ENABLED_THEN_OPPOSED` ×0.90 ·
`CLOTURE_ONLY_YEA` ×0.90

**Scoring flags (WF11)** — `PROCEDURAL_SWITCH` · `VERDICT_WITHOUT_ACTION` ·
`MISSING_ALIGNMENT` · `PARTY_WHIP_DATA_MISSING` · `PARTY_PROCEDURAL_SWITCH`

**Party alignment** — `WITH_PARTY` · `CROSS_PARTY` · `NOT_VOTED` (recorded
abstention) · `PROCEDURAL` (sponsor + NAY) · `NA`

**Regulatory target type (WF5/WF5b)** — `AGENCY_RULE` · `STATUTE` ·
`EXECUTIVE_ACTION` · `APPROPRIATION` · `PROGRAM` · `NONE`
⚠ `target_direction` was **removed**. Reason under Traps → Modelling.

**Bill Status** (congress.gov / unitedstates-congress scraper, prefix-matched)
`ENACTED:*` became law · `VETOED*` vetoed · `PASSED:*` / `PASS_OVER:*` /
`PASS_BACK:*` / `REPORTED` advanced · `REFERRED` / `FAIL:*` / `PROV_KILL` dead
⚠ Terminal = `ENACTED*` and `VETOED*` **only**. `FAIL:*` is not terminal — a
bill that failed cloture can return under a motion to reconsider.
⚠ Never normalise these strings. Aggregation prefix-matches them.

---

## UID formats

```
P2BM-{pol}-{promise}-{bill}      W7a promise→bill match
B2PM-{pol}-{bill}-{promise}      B2P bill→promise match
B2PU-{pol}-{bill}-00             B2P unmatched
PLTM-{pol}-{bill}-{platform_uid} WF9 platform match  (was -{rank})
PLTU-{pol}-{bill}-00             WF9 unmatched
ALIGN-{Match UID}                WF10A alignment
OMIT-{pol}-{promise}             WF10B omission
SURP-{pol}-{bill}                WF10B surprise
SCORE-{Promise Alignment UID}    WF11 decision score
RUN-{pol}-{iso}                  Aggregation summary
```

⚠ Cross-direction dedup is by **TUPLE**, not UID. `P2BM-` and `B2PM-` keys can
never match. B2P joins on normalised `{pol}|{promise}|{bill}`.

---

## Sheet columns added since 08-15

**`Impact Statements`**
`Reverses Existing Policy` · `Target Type` · `Target Name` · `Target Source` ·
`Target Effect` · `Direction Confidence` (holds **effect** confidence — rename)
`Target Direction` was added then deleted.

**`Bills Master`**
`Status Checked At` · `Status Changed At`
`Status Changed At` values: an ISO date from `j.status_at`, or `No Change`
(checked, unmoved), or `Unverified` (fetch failed).

**`Promise Alignment - Matches`** (62 mapped / 63 schema)
`Reverses Existing Policy` · `Target Name` · `Target Source` · `Target Effect`
(plus the 08-15 additions). `Grade` is human QA — deliberately **unmapped**.

**`Summary Output`**
`Status As Of` (oldest check date in the report) · `Status Unverified Bills`
⚠ The second sums per-promise counts, so it counts unverified **bill-promise
pairs**, not distinct bills. Do not label it as a bill count.

---

## Traps

### n8n
- **`update_workflow` writes the DRAFT.** `versionId == activeVersionId` is the
  only proof a change is live.
- ⚠ **Large `jsCode` pushes failed twice** — a placeholder string was sent
  instead of code, destroying two nodes. For bodies over ~10k chars, hand
  paste-ready blocks to the user.
- **Array index paths fail** — `/columns/schema/53` errors. Send the full array.
- **`setNodeParameter` cannot delete a map key** — rebuild the whole `value`
  object to rename or remove.
- **`get_execution` `truncateData` caps items.** Use 40+.
- **`.all()` on a looped node returns only the LAST run.** Count from a node
  that ran once.
- **`.item` in a Code node running once for all items resolves to the SAME item
  for every row.** Index-pair against an upstream `.all()` instead, with a
  length assertion.
- **`create_workflow_from_code` drops `splitInBatches` batchSize.** Set it
  explicitly.
- **HTTP Request nodes never get credentials auto-assigned.**
- Close the editor before API writes; hard-refresh before opening after.

### JavaScript / data
- **`Number(null) === 0` and `Number("") === 0`.** `safeNum(v, null)` never
  returns null for the values you are trying to catch. Every score arrives from
  Sheets as a **string**, so `=== null` guards never fire. Use a strict parser.
- **Whitelist objects silently drop new columns.** Spread `...data` first.
- **Case-mismatched field reads.** Nodes emit lowercase; readers ask TitleCase.
  Killed the entire donor axis. Prefer lowercase-first with TitleCase fallback.
- **Merge `enrichInput1` overwrites same-named columns.**
- **Trailing spaces in headers**: `Specificity Match `, `Evaluated By `.
- **`appendOrUpdate` only writes MAPPED columns** — unmapped are safe.
- **`matchingColumns` on a plain `append` node is inert.**

### Scaling
- **Per-batch `appendOrUpdate` is expensive.** 87 batches of 10 against an
  867-row tab is ~260 Sheets writes against a ~300/min project quota. If no
  per-item state is needed, drop the loop and write once.
- **Do not run two Sheets-heavy workflows concurrently.** Drains and refreshes
  contend on the same project quota.

### Modelling
- **LLMs fail deterministic lookups** — 18% on a six-row table at temperature 0.
  Anything expressible as a table belongs in code.
- **Promise-relative judgements do not belong in the bill-description layer.**
  `target_direction` (RESTRICTS/EXPANDS) had no fixed referent: 7 of 12 stated
  directions contradicted the model's own `target_effect` sentence.
- **Not every judgement can move to code.** A regex vacuous-effect classifier
  scored 5 of 21 wrong and was rejected. The test is whether the input is
  categorical (→ code) or free text (→ model).
- **Sponsored + NAY is a Rule XIII maneuver**, not opposition.
- **A NAY at either cloture or passage is opposition** — the any-NAY rule must
  stay identical in `deriveAlignment` and `Compute Party Vote Alignment`.
- **`Limit` reads in write order** — every batch this project has evaluated was
  a contiguous sample. **Eight** occurrences. Never quote a rate from one.
- **`run_id` is also the Pinecone `embedding_version` join key.** A new
  `run_id` matches zero vectors AND makes every promise look unevaluated.
- **Status freshness ≠ record freshness.** `status_at` is when the bill moved;
  `updated_at` is when the scraper last touched the record (moves for CRS
  summary edits). Use `status_at`.

### Silent-success shapes seen so far
- Empty Sheets read → dead merge branch → 20-second `success`, nothing written
- `Match Count = 0` filter where the column is blank → zero rows, reports success
- Rows written but never marked reviewed → re-selected forever → drain spins
- Frozen rows scored `0.0` → enter the mean as real zeros
- Skipped rows never written → blank timestamps indistinguishable from
  never-processed
- `.item` mispairing → ten rows written against one Bill ID, last write wins
