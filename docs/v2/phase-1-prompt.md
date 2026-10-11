# Phase 1 kickoff prompt

Paste everything in the block below into a new Claude Code session opened on this repo.

```
You are starting Phase 1 of "Receipts v2": moving a legislative-record pipeline
off Google Sheets and Pinecone onto Supabase Postgres. Work in the repo
maddyp86/receipts, on a new branch from main. Do Phase 1 only, then stop and
report.

READ FIRST, in this order
1. docs/v2/plan.md                         the whole design and all five phases.
                                           You are doing "Phase 1: foundation".
2. docs/v2/reference/sources.md            every sheet, tab, column, file path, id
3. docs/v2/reference/vote-slot-rules.md    how votes are derived, with test results
4. docs/supabase-schema.sql and docs/supabase-migration-*.sql   what exists today
5. packages/server/src/data/ActionStore.ts and
   packages/server/src/evaluation/enrichment.ts
   what the query tool reads. Do not change them in this phase.

BACKGROUND
Receipts is a nonpartisan tool: a voter types a promise and it is checked against
a member of Congress's record. Today n8n writes to Google Sheets, a Mirror Sync
copies ten tabs into Supabase schema `mirror`, and the query tool (Express on
Render) searches Pinecone and reads `mirror` for detail. Two senators are live:
Schumer (S000148) and Thune (T000250), 118th and 119th Congress. The design does
not scale: one vector per member-and-bill pair, votes stored per member, whole
tabs read on every run.

TARGET
Postgres is the single system of record, in a new schema `core`:
- members: all 541 rows of the Politicians tab, with in_scope, live, the
  congresses collected, Senate LIS id and roles
- bills
- bill_impacts: one per bill and text version; the impact statement and a
  vector(1024) embedding
- roll_calls and member_votes: every member's position on every roll call loaded
- sponsorships: bill, member, sponsor or cosponsor, true cosponsor date
- donors, donor_alignments: copied as they are
- ingest_runs
- a small table of today's Action UIDs by member and bill, so later phases can
  keep the ids that stored queries and traces already use
- view member_bill_actions: one row per member and bill, with cloture and
  passage votes DERIVED from roll calls
- a function that ranks one member's bills by cosine similarity to a query vector
Bill vectors live in Supabase via pgvector. Pinecone is retired for bills in a
later phase.

HOW TO DO THE LOADING
Build the imports as n8n workflows in a new n8n folder named "v2": manual
trigger, a dry_run setting that defaults to true, upserts so every import can be
re-run. Model them on "Mirror Sync, one table" (hHgKPuixmqESi1uX). n8n already
holds the credentials you need: Google Sheets account, Postgres account,
Pinecone API, n8n OpenAI. Do not ask Matt for API keys. Check which database
role the Postgres credential uses, and give that role write access to `core` in
the migration.

PHASE 1 TASKS
1. First reply: an access report and your plan in about ten lines. Then wait for
   Matt's go. Access means: the Supabase project that contains schemas `mirror`
   and `app`, n8n, Google Sheets, GitHub. If your Supabase connection cannot see
   that project, say so and stop.
2. Write docs/supabase-migration-014-core-schema.sql. Enable pgvector.
   receipts_app gets SELECT only on core; receipts_trust SELECT only. No foreign
   key from core to app. If you cannot apply it yourself, hand Matt the file to
   run in the Supabase SQL editor.
3. Members: import the Politicians tab (541 rows: 100 Senate, 441 House
   including delegates). in_scope comes from the In Scope column. live is true
   for Schumer and Thune only. Check the rows against the
   unitedstates/congress-legislators legislators-current file and report
   mismatches. Do not overwrite on a mismatch.
4. Import bills (973), impact statements (973, with their versions and 3,420
   stakeholder rows), sponsorships (the 919 action rows that carry a sponsor or
   cosponsor flag), the Action UIDs of all 1,162 action rows, and the donor
   tables.
5. Do NOT copy votes from Sheets. For each row of the Roll Call Votes tab (about
   228), read the roll-call file from storage and load the roll call and every
   member's position.
6. Copy bill vectors from Pinecone index `bills-promises`, namespaces
   S000148_bills and T000250_bills (1,162 vectors; vector id = Action UID),
   keeping one per bill (973). Where a bill has more than one vector, confirm
   they match before keeping one, and report any that do not. Then re-embed five
   bills and report the cosine similarity against the stored vectors. The
   pipeline and the query tool both use text-embedding-3-small at 1024
   dimensions; the index is tagged 3-large, which is believed to be a stale tag.
7. Gate G1: compare member_bill_actions with
   mirror.mirror_politician_bill_actions for both senators, field by field.
   The only differences should be the five listed in vote-slot-rules.md.
   Report every difference, expected or not.

RULES
- Sheets, Pinecone, schemas `mirror` and `app`, the Render service and every
  existing n8n workflow are READ-ONLY in this phase.
- Nothing a voter can see may change.
- Dry run before any write. Show the counts, then write.
- n8n: creating a workflow needs Matt's approval in the moment. update_workflow
  only writes a draft; publish, then confirm versionId equals activeVersionId.
  Write to n8n only after Matt confirms the editor is closed.
- Do not import docs/v2/reference/ossoff-load-backup-2026-10-10.json. It is for
  Phase 4.
- Do not set any member in_scope or live beyond what the sheet says.
- OpenAI spend this session: $5 at most. Ask before exceeding it.
- Ask before anything destructive or anything not listed here.
- Plain names over clever ones. Prefer the simplest thing that passes G1.
- Run npm test and npm run typecheck before opening a pull request.

DONE WHEN
A pull request holds the migration; the import workflows are published in n8n
folder "v2"; `core` is loaded; and you have reported the row count of every
table against the counts above and the full G1 difference list. Do not start on
the query tool or the new pipeline workflows.
```

## If you want to keep Pinecone

The prompt assumes bill vectors move into Supabase. To keep Pinecone instead, replace the last two sentences of TARGET with "Bill vectors stay in Pinecone, one per bill, in a single `bills` namespace" and replace task 6 with "Re-index Pinecone to one vector per bill in a new namespace `bills`, leaving the existing namespaces untouched."
