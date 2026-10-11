# Phase 1 report: foundation

Run on 10 October 2026. Schema `core` is created and loaded. Nothing a voter sees has changed: the query tool still reads Pinecone and `mirror`.

## What exists

- **Migration 014** (`docs/supabase-migration-014-core-schema.sql`), applied to the Receipts project. pgvector is enabled in schema `extensions`. `receipts_app` and `receipts_trust` can only read `core`, `receipts_sync` can read and write it, and `anon` and `authenticated` get nothing. No foreign key leaves `core`.
  - Checked as `receipts_app`: `match_member_bills` and `member_bill_actions` work, and an insert into `core` is refused.
- **n8n folder "v2"** in Politician Trustworthy holds seven published workflows. Each one's live version equals its saved version, and each import has `dry_run` true.

| Workflow | Id | Writes |
|---|---|---|
| v2 Import: members | `olX5oKiOtfU9kNwt` | `members` |
| v2 Import: bills and impact statements | `2KDZn0FxDxlwp48b` | `bills`, `bill_impacts` |
| v2 Import: sponsorships and action UIDs | `DsCGQeTpUa42UDdM` | `sponsorships`, `action_uids` |
| v2 Import: donors | `lLPvmFjp9cYRIikm` | `donors`, `donor_alignments` |
| v2 Import: roll calls | `qWYEyByNgDHunwuZ` | `roll_calls`, `member_votes` |
| v2 Import: bill vectors | `mOomiHEQSla2l7Mh` | `bill_impacts.embedding`, one Pinecone namespace per run |
| v2 Check: re-embed bills | `Gz4aofn8bnHmewkf` | nothing |

All seven start manually. Each also has a passive "When called by another workflow" trigger, because n8n will not publish a workflow whose only trigger is manual. Nothing calls it.

**The Postgres credential connects as `postgres`, not `receipts_sync`.** `pg_stat_statements` shows every mirror upsert running as `postgres`. The imports therefore needed no new grant. The migration still gives `receipts_sync` write access to `core`, so the credential can be moved to the narrower role.

## Row counts

| Table | Loaded | Brief | Note |
|---|---|---|---|
| members | 538 (100 Senate, 438 House) | 541 | The Politicians tab has 538 rows. Its grid is 542 rows tall and the last three are empty |
| in_scope, live | Schumer, Thune | Schumer, Thune | Congresses collected: 118, 119 |
| bills | 973 | 973 | |
| bill_impacts | 973 bill-level + 617 text versions | 973 | |
| stakeholders on bill-level statements | 3,269 | 3,420 | The other 151 rows belong to 44 statements that were regenerated under a new Impact UID; each of those bills has a current statement with its own stakeholders. Not loaded |
| bill_impacts with an embedding | 973 | 973 | |
| roll_calls | 228 | about 228 | 120 passage, 108 cloture, all Senate |
| member_votes | 22,797 | | 119 senators |
| sponsorships | 919 (196 sponsor, 723 cosponsor) | 919 | |
| action_uids | 1,162 | 1,162 | |
| donors | 879 | about 884 | 880 rows have a Donor UID; JHKT5J has no Politician ID and is skipped |
| donor_alignments | 8,440 | as is | |
| ingest_runs | 8 | | One per write run |

## Bill vectors

- Copied from `S000148_bills` (609) and `T000250_bills` (553), 1,162 in all, keeping one per bill: 973.
- **189 bills had two vectors, one per senator. All 189 pairs agree at cosine 0.99995 or higher**, so none was set aside. Every vector is 1024-dimensional, and every vector id is a known Action UID for the same bill.
- **The model is text-embedding-3-small at 1024 dimensions.** Five bills were re-embedded from the exact text WF6 built, taken from each vector's own metadata.
  - Cosine against the stored vector: 1.000000 for all five with 3-small, between −0.025 and 0.013 with 3-large. The index's 3-large tag is stale.
  - Cost: 6,774 tokens, about $0.0005.

## Gate G1

`docs/v2/g1-check.sql` compares `core.member_bill_actions` with `mirror.mirror_politician_bill_actions` for both senators, field by field.

**Votes: exactly the five corrections in `reference/vote-slot-rules.md`, and nothing else.**

| Member, bill | Field | Mirror | core |
|---|---|---|---|
| Schumer, hr5371-119 | vote, passage_vote | Yea | Nay (s618-119.2025) |
| Thune, sres13-118 | whole row | no row | Yea, s2-118.2023, 2023-01-26 |
| Thune, sres21-118 | whole row | no row | Yea, s4-118.2023, 2023-02-01 |
| Schumer, s870-118 | passage vote | none (vote_id s78-118.2023) | Yea, s200-118.2024, 2024-06-18, count 2 |
| Thune, s870-118 | passage vote | s94-118.2023, 2023-04-20, count 1 | Yea, s200-118.2024, 2024-06-18, count 2 |

The two Thune rows account for every presence, action_uid, action_type, action_date, state, sponsor_tier, is_sponsor, is_cosponsor and impact_statement_created difference: 2 each.

**Other differences, none of them votes:**

| Field | Rows | Cause |
|---|---|---|
| progress_checked_at | 1,164 | The mirror is stale. It last synced at 2026-10-09 13:00 UTC and holds 2026-10-08. The sheet, and so `core`, hold 2026-10-10 13:30 from today's WF2c run. Includes the two new Thune rows |
| party | 6 | The sheet writes `R` / `D` on six action rows for hr5334-119 and hr6500-119; `core` takes party from the member |
| cosponsor_total | 2 (+2 new rows) | s1383-119 is vote-only for both senators. The action rows say 8; Bills Master says 2 active cosponsors. The view takes the bill's count on vote-only rows |

## Decisions made on the way

1. **Bills Master `Date` is not the introduction date.** It is the date of the bill's current status. For s4243-118 the bill file says introduced 2024-05-02 and status 2024-12-12, and Bills Master holds 2024-12-12. The column is therefore `bills.status_date`. Bills Master has no introduction date; the Phase 3 bill workflow can read it from the bill file.
2. **Today's Action Date is kept with its Action UID** (`action_uids.legacy_action_date`). On the sheet it is sometimes the introduction date, sometimes the first vote, the last vote or another vote, depending on which workflow made the row. No rule reproduces it, and the query tool's date-window gate reads it. A new pair derives its date: the true cosponsor date, else the first vote.
3. **On vote-only rows the view falls back to the bill's values** for `cosponsor_total` and `progress_checked_at`, which is what the sheet does.

## For later phases

- **Only 8 of 100 senators have an LIS ID** on the Politicians tab, and Senate vote files identify members by LIS ID. So 20,973 of the 22,797 stored positions do not yet join to a member row. The positions are stored, which is the design, but "add a member and the votes are already there" needs every senator's LIS ID. legislators-current has all 100. The two whips are affected too: Durbin S253 and Barrasso S317 have LIS IDs on the Party Whips tab but not on Politicians, and the whip-vote check depends on them.
- **legislators-current vs the Politicians tab**, reported and not applied:
  - LIS ID blank on the sheet for 90 senators.
  - OpenSecrets ID blank for 521 members.
  - 10 sheet members are no longer in the file: G000359 Lindsey Graham, M001190 Markwayne Mullin, S001157 David Scott, L000578 Doug LaMalfa, S001193 Eric Swalwell, S001207 Mikie Sherrill, G000590 Mark E. Green, G000596 Marjorie Taylor Greene, G000594 Tony Gonzales, C001127 Sheila Cherfilus-McCormick.
  - 11 members in the file are not on the sheet: W000831, G000606, V000139, M001245, A000383, F000485, M001246, G000607, G000608, B001328, W000832.
  - Term end: Moody and Husted 2029-01-03 on the sheet, 2026-11-03 in the file.
  - Party: Kiley Republican on the sheet, Independent in the file.
- **The Party Whips tab lists Thune's state as WY.**
- **Bill introduction date:** see decision 1.
