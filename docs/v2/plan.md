# Receipts v2: rebuild on Supabase

**Status:** approved in outline on 10 October 2026. Phase 0 is done except for database access. Phase 1 has not started.
**Replaces:** the Google Sheets pipeline, the Mirror Sync, and the per-member Pinecone namespaces.
**Reference material:** `docs/v2/reference/` in the `maddyp86/receipts` repo.

## Goal

One database holds the whole legislative record. Adding a member is a flag and a data pull, not a new pipeline run through spreadsheets. The query tool reads from one place.

There is no election deadline on this. Nothing a voter sees changes until the new system is proven equal to the old one on the eval set.

## Design rules

1. **One store.** Supabase Postgres is the system of record. Sheets and the mirror are retired at cutover.
2. **Store each fact once.** A bill is summarised once and embedded once. A member's record is rows that link the member to bills.
3. **Derive, don't copy.** A member's cloture and passage vote on a bill is computed from the roll calls when it is read. It is never stored a second time. Both data errors found on 10 October (Schumer on H.R. 5371, the stale S. 870 passage vote) were stored copies that had gone wrong.
4. **Ingest by source, not by member.** Each roll call is loaded whole, with every member's position. A new member's votes are already there the day they are added.
5. **Loading is not publishing.** A member is collected when `in_scope` is true and shown to voters only when `live` is true.
6. **The firewall stays.** The query tool's database role can read the record and write only its own `app` tables. A stored voter query can never become evidence.

## Today and v2

| | Today | v2 |
|---|---|---|
| System of record | Google Sheets (4 workbooks) | Supabase, schema `core` |
| What the query tool reads | Pinecone for search, the Supabase mirror for detail | Supabase for both |
| Bill search | One vector per member and bill, in a Pinecone namespace per member | One vector per bill, in Supabase (pgvector) |
| Votes | Stored per covered member; a new member has no history | Every roll call stored with all positions |
| Freshness in the query tool | Mirror syncs Tuesday and Friday | Immediate; no sync |
| Pipeline | 9 workflows plus Mirror Sync, reading whole tabs | 5 workflows that upsert rows |
| Adding a member | New namespace, re-embed, backfill votes by hand | Set `in_scope`; only bills never seen before cost anything |

## Data model (schema `core`)

| Table | One row per | Notes |
|---|---|---|
| `members` | member of Congress | All 541 rows of the Politicians tab (100 Senate, 441 House including delegates). Holds chamber, district, party, Senate vote ID, leadership roles, `in_scope`, `live`, and the congresses collected. |
| `bills` | bill | Titles, dates, status, progress stage and outcome, committees, text link. |
| `bill_impacts` | bill and text version | The impact statement, issue tags, keywords, stakeholders, and the embedding. Replaces three tabs. |
| `roll_calls` | roll-call vote | Chamber, real timestamp, bill, category, result. |
| `member_votes` | roll call and member | Yea, Nay, Not Voting, Present. |
| `sponsorships` | bill and member | Sponsor or cosponsor, the true cosponsor date, original or late, withdrawn date. |
| `donors`, `donor_alignments` | as today | Copied as they are for Schumer and Thune. No new-member path yet. |
| `ingest_runs` | pipeline run | What was fetched, counts, errors. Replaces the manifest and log tabs. |

Two views sit on top:

- **`member_bill_actions`**: one row per member and bill, with sponsor flags and the cloture and passage vote worked out from the roll calls. Same fields the query tool reads today. The tested rules are in `docs/v2/reference/vote-slot-rules.md`.
- **Compatibility views** that present `core` in the exact shape of today's mirror tables. With these, the only query-tool change at cutover is the search store.

## Search

One database function: given a member and a query vector, rank that member's bills by similarity and return the top results.

A member has hundreds to a couple of thousand bills, so the search is exact. There is no approximate index to tune and no namespace to manage. The query tool already has a swap point for this (`ActionStore`, ADR-009), so it is one new class behind an environment switch.

The rule that the tool never embeds or re-analyses a bill at query time does not change.

## Pipeline: five n8n workflows

All five write to Postgres with upserts. None reads a whole table to find out what is new.

1. **Members.** Weekly refresh of names, parties, districts and terms.
2. **Roll calls.** New vote files from the storage bucket, both chambers, loaded whole.
3. **Sponsorships and bills.** For each `in_scope` member, their sponsored and cosponsored bills; plus bill detail and progress.
4. **Impact statements.** Bills touched by an `in_scope` member that have no statement. Same prompt as today, same daily cap.
5. **Embeddings.** Statements with no embedding, or whose text changed.

The embedding workflow per senator, the Embedded and Impact flags, the manifests and the Mirror Sync all go away.

## Moving what exists

Counts are as read on 10 October 2026, after the partial Ossoff load was rolled back.

| What | How | Size |
|---|---|---|
| Members | Import the Politicians tab; check it against the public legislators file | 541 |
| Bills | Import from Bills Master | 973 |
| Impact statements, versions, stakeholders | Import from the Impact Statements workbook | 973 statements, 3,420 stakeholder rows |
| Sponsorships | Import from the action rows that carry a sponsor or cosponsor flag | 919 of 1,162 |
| Votes | **Not copied.** Re-read from the roll-call files so every senator's position is stored and the known sheet errors are not carried over | about 228 roll calls |
| Bill vectors | Copy from Pinecone, one per bill instead of one per action row; embed only what is missing | 1,162 down to 973 |
| Donors and donor alignments | Straight copy | as is |

## Proof before switching

| Gate | Test | Pass means |
|---|---|---|
| G1 Record | Compatibility views against the current mirror, row by row, for Schumer and Thune | Identical, except the five known corrections listed in `vote-slot-rules.md` |
| G2 Search | The same query vectors against Pinecone and Supabase | Same bills, same order, scores equal to three decimals |
| G3 End to end | The 18-case eval set on the new store | Same pass rate as the old store |
| G4 Daily run | New pipeline for three consecutive days | Clean runs, no drift against the old pipeline |

Rollback is two settings on the server. Pinecone and the mirror stay untouched for two weeks after cutover.

## Order of work

| Phase | What | Done when |
|---|---|---|
| 0 | Decisions, database access, Ossoff load rolled back | Access works |
| 1 | Schema, members, imports, roll calls, vectors | G1 passes |
| 2 | Query tool: new search store and compatibility views, built behind a switch that stays off | G2 and G3 pass |
| 3 | The five new workflows run daily into `core` beside the old pipeline; then the switch is flipped and the old pipeline, Mirror Sync and Sheets are retired | G4 passes, then cutover |
| 4 | Senators: set `in_scope`, load, review, set `live`. Ossoff first | Each member reviewed before `live` |
| 5 | House: resolutions in the scraper, House vote categories, chamber-aware wording in the tool | First House member live |

The live tool keeps reading the old system until the cutover at the end of Phase 3. The switch is not flipped at the end of Phase 2, because `core` is loaded once in Phase 1 and would go stale until the new pipeline is filling it every day.

## Phase by phase

### Phase 1: foundation

The task list is in `phase-1-prompt.md`. In short: migration 014 creates `core`; members, bills, impact statements, sponsorships and donor tables are imported from Sheets; roll calls are re-read from source; bill vectors are copied from Pinecone, one per bill.

**Done when** gate G1 passes: the derived votes match the mirror for both senators except the five known corrections.

### Phase 2: the query tool, built but not switched

**Starts when** G1 has passed.

1. **One place for the schema name.** The server names `mirror.mirror_*` directly in 15 places across four files (`enrichment.ts`, `SenatorCache.ts`, `textVersions.ts`, `summaryReview.ts`). Read the schema from one setting, `RECORD_SCHEMA`, default `mirror`.
2. **Compatibility views.** A new schema `compat` with one view per mirror table the tool reads (ten of them), with the same column names and the same keys inside `row`. Migration 015.
3. **New search store.** `SupabaseActionStore`, implementing the existing `ActionStore` interface and chosen by a setting, `ACTION_STORE`, default `pinecone`. It returns the same fields, applies the same similarity floor, and reports the same near-miss counts. It keeps today's Action UIDs, so stored queries, traces and reused answers still line up.
4. **Picker.** A member is listed when `in_scope` and `live` are both true and a record exists. The coverage sentence uses the congresses collected for that member. The parked branch `feat/live-flag-and-member-coverage` already has this logic and its tests.
5. **Gate G2.** Extend `tools/rank-check.mts` to run each saved eval query vector against both stores and compare. Pinecone can return a bill more than once; compare on each bill's best rank.
6. **Gate G3.** Run `npm run eval` once per store and compare case by case.

**Done when** G2 and G3 pass and the pull request is merged with both settings at their defaults. Production behaviour is unchanged.

**Not in this phase:** flipping either setting in production, or any change to prompts, checks or voter-facing copy.

**Cost:** two eval runs, about $4 to $12.

### Phase 3: the new pipeline, then cutover

**Starts when** Phase 1 is done. It can overlap Phase 2.

**Build.** A new n8n folder `v2` with five workflows and a daily orchestrator that runs an hour after the old one. Every workflow upserts into `core` and writes one `ingest_runs` row with what it read, what it wrote, errors, and model tokens used.

1. **Members.** Weekly. Refreshes names, parties, districts and terms. Never touches `in_scope`, `live` or the congresses collected.
2. **Roll calls.** Lists the storage bucket for vote files changed since the last run. Keeps the filter used today (passage and cloture votes on a bill) and loads each one whole.
3. **Sponsorships and bills.** For each `in_scope` member, reads their sponsored and cosponsored bills, stopping once the list passes the congresses collected for that member and failing loudly if it is cut off early. New bills get their detail from the bucket. The progress rules come from the current progress workflow. True cosponsor dates and withdrawals come from the bill file.
4. **Impact statements.** Bills linked to an `in_scope` member that have no statement. Same prompt and bill-context builder as today, same cap of 60 a run, plus a monthly budget stop. A statement written from the title alone, because the text is not published yet, is marked and redone when the text appears. Bills whose text changed get a statement per text version.
5. **Embeddings.** Statements with no embedding, or whose text changed. Same recipe as today.

A failure in any of them emails Matt.

**Run in parallel.** The old pipeline stays the source for the live tool.

- Impact statements are generated once, by the old pipeline, and copied into `core` each day by the Phase 1 import. The new statement workflow runs in dry-run on the same bills. This avoids paying twice and keeps the two systems comparable.
- A daily report compares `core` with the Sheets for Schumer and Thune: bills, sponsorships, roll calls and derived votes.
- **Gate G4:** three consecutive days with clean runs and no differences.

**Cutover, in one sitting and in this order.**

1. Confirm G2, G3 and G4.
2. Switch the new statement workflow from dry-run to live and stop the daily copy.
3. On Render, set `ACTION_STORE=supabase` and `RECORD_SCHEMA=compat`.
4. Run the eval set once on the production settings.
5. Unschedule the old orchestrator and the Mirror Sync. Do not delete them.
6. Set the four workbooks to view-only.

**Rollback** for two weeks: set the two Render settings back and reschedule the old orchestrator and the Mirror Sync.

**After two clean weeks:** delete the old workflows, drop the `mirror` schema, remove the Pinecone code path, and delete the Pinecone bill namespaces.

**Done when** the cutover has held for two weeks.

### Phase 4: senators

One member at a time, with the same checklist:

1. Set `in_scope` and the congresses to collect (119th first, 118th after).
2. Run the sponsorship pull. Votes are already in `core`.
3. Show the count of new bills and the estimated statement cost before spending anything.
4. Run statements and embeddings.
5. Review: five bills checked by hand for sponsorship, vote and statement, plus three test queries.
6. Set `live`.

Order: Ossoff (41 of his statements can be reused from the backup), Collins, Sullivan, Marshall, Warner, Luján.

### Phase 5: House members

1. **Scraper.** Add House simple resolutions (`hres`) to the bill upload.
2. **Roll calls.** Take House vote files, which identify members by bioguide id. Decide which House categories count as a bill vote (`passage` and `passage-suspension` at least) and test the choice on one member.
3. **Party-line checks.** The tool's checks use the Senate whip's vote. Add the House equivalent.
4. **Wording.** The voter-facing copy says "senator" in 46 places. Make it follow the member's chamber. This needs copy sign-off.
5. **Picker.** By chamber, state and district. The web roster already carries this.
6. **First members:** Lawler, Valadao, Perry, Gluesenkamp Perez, Kaptur, Gonzalez.

## Decisions taken by default

Say so if any of these is wrong.

1. **Bill vectors move into Supabase and Pinecone is retired for bills.** One store means search and record cannot disagree.
2. **n8n stays as the runner**, rebuilt as five workflows. The alternative is scheduled jobs in the code repo: fewer memory limits, but not something you can open and inspect.
3. **Vote dates keep today's convention at cutover** so the timing checks behave identically. The real timestamp is stored alongside for later.

## Not in scope

- The 3,228 promise vectors and the evaluation workbooks. The query tool does not read them. They stay where they are as an archive.
- The trust-profile scoring pipeline.
- Any change to verdict logic, prompts or voter-facing copy before Phase 5.

## Cost

- **Impact statements** remain the real cost: an estimated $0.03 to $0.07 per new bill, so roughly $5 to $15 per new senator, falling as bills overlap. This is an estimate; the runs do not record token counts.
- **Embeddings:** cents.
- **Each eval run:** about $2 to $6.
- **Supabase:** the data is small. Plan limits to be checked once access is in place.

## Risks

- **Silent behaviour change in the query tool's checks.** They read specific fields. The compatibility views and gates G1 and G3 exist for this.
- **This is a rebuild of storage and plumbing, not of logic.** The impact prompt, the bill-context builder, the progress rules and the vote rules carry over as they are. Rewriting those too would turn weeks into months.
- **Two pipelines run side by side until Phase 3.** Kept short on purpose.

## What happened on 10 October 2026

- **Pipeline fixes, kept.** WF4 reads the actions tab once and caps a run at 100 bills; WF5 caps a run at 60 bills; WF6 retries its calls. These stopped a daily out-of-memory crash and stay until the old pipeline is retired.
- **Senate vote IDs, kept.** Filled in for Collins, Sullivan, Marshall, Ossoff, Warner and Luján.
- **Partial Ossoff load, rolled back.** 200 action rows, 157 bills, 41 impact statements and 139 stakeholder rows were removed from the Sheets, and the bill manifest was put back. The removed rows are in `docs/v2/reference/ossoff-load-backup-2026-10-10.json`. Ossoff is out of scope again.
- **Still wrong in the live system:** Schumer's passage vote on H.R. 5371. The sheet and the vector say Yea; the roll call says Nay.
