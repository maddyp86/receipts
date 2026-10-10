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

Rollback is one environment variable. Pinecone and the mirror stay untouched for two weeks after cutover.

## Order of work

| Phase | What | Done when |
|---|---|---|
| 0 | Decisions, database access, Ossoff load rolled back | Access works |
| 1 | Schema, members, imports, roll calls, vectors | G1 passes |
| 2 | Query tool: new search store and compatibility views behind a switch | G2 and G3 pass; reads cut over |
| 3 | The five new workflows go live; old pipeline, Mirror Sync and Sheets retired | G4 passes |
| 4 | Senators: set `in_scope`, load, review, set `live`. Ossoff first | Each member reviewed before `live` |
| 5 | House: resolutions in the scraper, House vote categories, chamber-aware wording in the tool | First House member live |

Until Phase 3, the old pipeline keeps running for Schumer and Thune so the live tool stays current.

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
