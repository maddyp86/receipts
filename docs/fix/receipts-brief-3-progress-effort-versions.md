# Receipts — brief 3: bill progress, sponsorship effort, and text versions in the query tool

**Repo:** `maddyp86/receipts` @ `2e84cda`
**Date:** 2026-09-21
**Follows:** brief 1 (judge/retry/fixtures) and brief 2 (eval harness, routing, tracing). Independent of both.

---

## Why this brief exists

The n8n pipeline now produces three kinds of data the query tool cannot yet see. Each one changes
whether an answer about a senator's promise is *correct*, not just how it reads.

1. **How far a bill got, and what the senator actually did on it.** A cosponsorship used to be a
   single boolean. It is now a tier (sponsor whose bill advanced / stalled, original cosponsor, late
   cosponsor), with the true date they joined, their ordinal among cosponsors, whether they later
   withdrew, and whether the bill died in a committee they sit on.
2. **Which text the senator acted on.** Bills are rewritten under the same number. Two confirmed
   cases in the current corpus:
   - `s1071-119` — introduced as a VA bill to disinter one veteran's remains; enrolled as the
     **FY2026 NDAA**.
   - `hr5334-119` — introduced as a tax deduction for early-childhood educators; enrolled as a
     **Russia sanctions act**.

   The query tool today evaluates every action against one summary per bill (the latest, from
   Pinecone metadata). A senator who cosponsored the introduced `hr5334` is currently judged against
   Russia sanctions. That is the defect this brief fixes.
3. **What a disapproval resolution actually undoes.** CRA resolutions cite a Federal Register rule
   and nothing else. `Target Effect` is now populated for them from the rule itself (0.93–0.98
   confidence on the sample checked), which is the only field that gives these votes a direction.

---

## Contracts that still hold — read before changing anything

- **The model's verdict is never the verdict.** `deriveAlignment` decides.
- **Weight scales magnitude, never flips a verdict.** Sponsorship tier, progress stage and committee
  membership may strengthen or weaken how a finding is presented. None of them may turn KEPT into
  BROKE or the reverse. A late cosponsorship of a bill that died in committee is still, weakly, a
  kept promise.
- **Effort is never averaged into a score.** `scoring/effortSignal.ts` states this and the reason
  (the sponsorship double-count). Tier belongs there and in the narrative — not in a numeric score.
- **Withdrawn cosponsorships are disclosed, never scored.** Rare, and a rule written without examples
  would be wrong.
- **No reader for `mirror_promise_alignment_matches` or `mirror_decision_scores`.** Migration 005 and
  the comment in `enrichment.ts` exist for this. Nothing in this brief needs them.
- Every new number goes in `scoring/config.ts` or `config.ts`. Don't hand-edit generated files.

---

## What the pipeline now writes (data dictionary)

### A. `Politician Bill Actions` → already mirrored as `mirror.mirror_politician_bill_actions`

Stored as JSONB in `row`, read today in `evaluation/enrichment.ts` with `pickRow(j, '<Column>')`.
These ten columns appear in `row` on the next Mirror Sync — **no migration needed.**

| Column | Values | Meaning |
|---|---|---|
| `Sponsor Tier` | `SPONSOR_ADVANCED` · `SPONSOR_STALLED` · `ORIGINAL_COSPONSOR` · `LATE_COSPONSOR` · `UNRESOLVED` · `NA_VOTE_ONLY` | Describes the **record**, not effort. `SPONSOR_ADVANCED` = sponsor and the bill moved past referral; it does not mean the sponsor pushed it. |
| `Cosponsored At` | `YYYY-MM-DD` · `NA` | The date the senator actually joined. **Use this, not `Action Date`**: the ingestion workflow stamps every cosponsorship with the bill's introduction date, so `Action Date` is wrong for late cosponsors. |
| `Original Cosponsor` | `TRUE` · `FALSE` · `NA` | |
| `Cosponsor Ordinal` | integer · `NA` | Position among cosponsors ordered by join date. |
| `Cosponsor Total` | integer | All cosponsors including withdrawn. |
| `Days After Introduction` | integer · `NA` | |
| `Withdrawn At` | `YYYY-MM-DD` · `NA` | Name removed from the bill. Disclose only. |
| `Committee Member` | `TRUE` · `FALSE` · `NO_COMMITTEE` · `NA_PRIOR_CONGRESS` · `UNAVAILABLE` | Whether the senator sits on a committee the bill was referred to. **Current Congress only** — 118th-Congress rows read `NA_PRIOR_CONGRESS`. |
| `Committee Member Of` | `; `-separated committee IDs · `NA` | e.g. `SSCM`. |
| `Progress Checked At` | ISO timestamp | When the pipeline last computed this row. |

### B. `Bills Master` → **not mirrored. Needs a new mirror table.**

| Column | Values | Meaning |
|---|---|---|
| `Progress Stage` | `INTRODUCED` → `REFERRED` → `IN_COMMITTEE` → `ON_CALENDAR` → `FLOOR` → `PASSED_CHAMBER` → `PASSED_BOTH` → `TO_PRESIDENT` → `ENACTED` / `VETOED` | Furthest point reached. |
| `Progress Outcome` | `ACTIVE` · `ENACTED` · `VETOED` · `FAILED` · `PROV_KILL` · `AGREED_TO` · `DIED_AT_<stage>` | `PROV_KILL` = cloture failed, can return. `AGREED_TO` = simple/concurrent resolution passed (finished, not dead). |
| `Progress Stage At` | `YYYY-MM-DD` | |
| `Last Action At` / `Last Action Text` | date / text | Verbatim from the record. |
| `Committee Activity` | text | e.g. `SSCM: Referred To, Reported By`. |
| `Referred Committees` | `; `-separated IDs | Join key for `Committee Member Of`. |
| `Cosponsor Count` | integer | Active (non-withdrawn). |
| `Enacted Via` | `SELF` · related bill ID · `NA` | A related bill whose law "contains the text". The **legitimate** version of the shell-bill pattern: a sponsor's bill "died" but its text became law under another number. |

### C. `Impact Statements - Versions` (Impact Statements workbook) → **not mirrored. Needs a new mirror table.**

One impact statement per bill **per text version**, keyed `Impact Version UID`. Same content fields
as the main `Impact Statements` tab, plus:

| Column | Meaning |
|---|---|
| `Bill ID` | Join key. |
| `Text Version Code` | `is`, `ih`, `rs`, `rh`, `es`, `eh`, `eas`, `eah`, `pcs`, `enr`, … |
| `Text Version Type` | e.g. `Introduced in Senate`, `Enrolled Bill`. |
| `Text Version Date` | `YYYY-MM-DD`. **Blank for `enr`** — congress.gov does not date enrolled versions. Treat blank as the latest version. |
| `Title` | The title printed on **that version** — differs from the bill's current title on gut-and-amend bills. |
| `Summary`, `Intended Effects`, `Mechanisms`, `Affected Stakeholders JSON`, `Primary Issue`, `Sub Issue`, `Bill Keywords` | Version-specific. Stakeholders are JSON on this tab, not a separate table. |
| `Reverses Existing Policy`, `Target Type`, `Target Name`, `Target Source`, `Target Effect`, `Direction Confidence` | Reversal block. `Target Effect` is the populated field for CRA bills. |
| `Taxonomy Divergent` / `Taxonomy Divergence Detail` | `TRUE` when versions of this bill were classified under different issue pairs. Sometimes correct (`s1071`), sometimes model drift (`s836`). |
| `Flagged For Review` | `TRUE` when the row failed a quality check. |
| `Version Mismatch` | `TRUE` when the model's response cited a different version than it was given. **Do not use a row where this is TRUE.** |
| `Version Title Source` | `TEXT` (read from the bill) · `MODEL` · `CANONICAL` (fallback — title may not match the version). |

Only versions whose **operative text differs** are stored. A version identical to an earlier one
(e.g. `pcs` identical to `is`) is skipped, so the earliest version carrying a given text is the one
present. Not every bill has rows here — only multi-version bills with changed text.

### D. Not for the query tool

`Reprocess Queue`, `Reprocess Archive`, `Source Changed`, `Source Updated At`, and any `QA` tab are
pipeline-internal bookkeeping. Don't read them.

---

## Tasks

One commit per task, tests in each. `tsc -b` and `vitest run` green after every one.

### Task 1 — Migration 010: two new mirror tables

Create `docs/supabase-migration-010-bill-progress-and-versions.sql` adding exactly these two tables.
**The column names and types are fixed**: the n8n Mirror Sync sub-workflow declares the same list and
introspects the live table before writing, dropping any declared column the table lacks and
reporting it as schema drift. The two must agree.

```
mirror.mirror_bills_master
  bill_id            text  PRIMARY KEY
  row                jsonb
  source_row_number  integer
  synced_at          timestamptz

mirror.mirror_impact_statement_versions
  impact_version_uid text  PRIMARY KEY
  bill_id            text          -- index this; every read is by bill
  text_version_code  text
  text_version_date  text          -- text, not date: blank for enrolled versions
  row                jsonb
  source_row_number  integer
  synced_at          timestamptz
```

The PRIMARY KEY on each matters: the sync upserts on it. Without a unique constraint it falls back
to delete-and-reload on every run and reports that as drift.

Follow the grants of the existing mirror tables exactly — the `_read` / `_sync` role pattern — so
`receipts_app` can read them and the sync role can write them. Read `supabase-schema.sql` and
migration 005 for the pattern; do not invent a new one. Every other field is read from `row` with the
same `pickRow` helper `enrichment.ts` already uses.

*Mirror Sync is extended separately in n8n, after this migration is applied. Build tasks 2–5
against fixtures until then.*

### Task 2 — Enrichment: sponsorship tier and bill progress

Extend `ActionEnrichment` in `evaluation/enrichment.ts` with the ten fields from section A, read with
the existing `pickRow` helper. Add a bill-level read from `mirror_bills_master` for the section B
fields, batched by `bill_id` the same way `forActions` batches by `action_uid`. The `null` enrichment
source must return empty values and every consumer must treat absence as "unknown", never as a
negative.

Make every date-sensitive consumer use `Cosponsored At` in place of `Action Date` for
cosponsorships. Grep for `action_date` — the gates, `deriveAlignment`, `effortSignal` and the
temporal checks all read it.

### Task 3 — Evaluate each action against the text that existed when it happened

This is the core fix. For each candidate action, choose the version statement in effect on the
action's date, and use it in place of the Pinecone-metadata summary:

- **Sponsorship / cosponsorship** → the latest version dated **on or before `Cosponsored At`**.
  In practice this is almost always the introduced version.
- **Vote** → the latest version dated **on or before the vote date** (cloture date for a cloture
  vote, passage date for passage).
- Undated versions (`enr`) sort **last**, never first.
- **Skip any row** with `Version Mismatch = TRUE`, and prefer rows where `Flagged For Review` is
  FALSE.
- **No version rows for the bill** → fall back to today's behaviour exactly. Most bills will take
  this path; it must be unchanged.

Substitute into the evaluator input: `bill_summary`, intended effects, mechanisms, stakeholder
groups, and the reversal block including `target_effect`. Record on the evidence which version was
used (`text_version_code`, `text_version_date`, version title) so the result can disclose it.

When the chosen row has `Taxonomy Divergent = TRUE`, attach a disclosure flag rather than suppress
anything.

**Fixtures and tests — use these exact cases:**
- `s1071-119`: a cosponsorship dated in March 2025 must be evaluated against the VA disinterment text;
  a vote in December 2025 against the NDAA text. Assert the two produce different `bill_summary`
  inputs.
- `hr5334-119`: same pattern — introduced tax-deduction text vs. enrolled sanctions text.
- A bill with no version rows produces byte-identical evaluator input to today.
- A row with `Version Mismatch = TRUE` is never selected.
- An `enr` row with a blank date is never chosen for a sponsorship.

### Task 4 — Effort and narrative, not score

Split `AUTHORED` / `CO_SIGNED` in `scoring/effortSignal.ts` by tier, and feed progress stage and
committee membership into the explanation. **No change to any numeric score.**

The narrative sentence is the product here. Every clause must be citable from the fields above:

> *Co-sponsored as the 34th of 41, three months after introduction. Referred to Commerce, where he
> sits; no hearing before the 118th Congress ended.*

Rules:
- State the record, not motive. "Did not advance past committee", never "abandoned".
- `SPONSOR_ADVANCED` ≠ "pushed it". The data shows the bill moved, not who moved it.
- `Enacted Via` pointing at another bill → say the text became law under that number. That is a
  kept promise the current output would miss entirely.
- `Withdrawn At` present → state the date the name was removed. Disclose only.
- `Committee Member = NA_PRIOR_CONGRESS` → say nothing about membership rather than guess.

### Task 5 — Disclosure fields in the result

Surface on the rendered result: which text version was evaluated (with its own title and date),
progress outcome, and the taxonomy-divergence flag when present. A voter reading a verdict on
`hr5334` must be able to see that the text they're reading about is the introduced version, and that
the bill later became something else.

---

## Acceptance

- `tsc -b` clean, `vitest run` green after every task.
- Migration 010 follows the existing mirror pattern with matching grants.
- The five Task 3 fixtures pass, including the unchanged-behaviour case.
- No numeric score moves as a result of Tasks 2–5. A test pins this: same inputs with and without
  tier data produce the same score.
- Brief 2's `npm run eval` (if landed) run before and after, with the result in the PR description.

## Known data caveats

- 2 of 13 sampled versions had no readable title — Engrossed Amendment versions (`eah`, `eas`) carry
  amendment text rather than a heading. `Version Title Source = CANONICAL` marks them. On
  `hr5334-119`, `eas` is likely where the sanctions text first appears, so its title understates the
  change.
- Committee membership covers the current Congress only.
- Version rows exist only for bills whose text changed and that were processed; coverage grows as the
  weekly pipeline runs. Absence of version rows is normal, not an error.
