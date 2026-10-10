# Phase 1 kickoff prompt

Paste everything in the block below into a new Claude Code session opened on this repo.

```
You are starting Phase 1 of "Receipts v2": moving a legislative-record pipeline
off Google Sheets and Pinecone onto Supabase Postgres. Work in this repo
(maddyp86/receipts). Do Phase 1 only, then stop and report.

READ FIRST, in this order
1. docs/v2/plan.md                         the design and the phases
2. docs/v2/reference/sources.md            every sheet, tab, column, file path, id
3. docs/v2/reference/vote-slot-rules.md    how votes are derived, with test results
4. docs/supabase-schema.sql and docs/supabase-migration-*.sql   what exists today
5. packages/server/src/data/ActionStore.ts and evaluation/enrichment.ts
   what the query tool reads (do not change them in this phase)

BACKGROUND
Receipts is a nonpartisan tool: a voter types a promise and it is checked against
a member of Congress's record. Today n8n writes to Google Sheets, a Mirror Sync
copies ten tabs into Supabase schema `mirror`, and the query tool (Express on
Render) searches Pinecone and reads `mirror` for detail. Two senators are live:
Schumer (S000148) and Thune (T000250), 118th and 119th Congress. The design does
not scale: one vector per member-and-bill pair, votes stored per member, whole
tabs read on every run.

TARGET
Postgres is the single system of record, in a new schema `core`: members, bills,
bill_impacts (statement plus a vector(1024) embedding), roll_calls, member_votes
(every member's position on every roll call), sponsorships, donors,
donor_alignments, ingest_runs; a view member_bill_actions that DERIVES each
member's cloture and passage vote from the roll calls; and a function that ranks
one member's bills by cosine similarity to a query vector. Bill vectors live in
Supabase via pgvector. Pinecone is retired for bills in a later phase.

PHASE 1 TASKS
1. Check access first and report anything missing before you build:
   - the Supabase project that contains schemas `mirror` and `app`
   - n8n, Google Sheets, GitHub
   - PINECONE_API_KEY and OPENAI_API_KEY in the environment
2. Write docs/supabase-migration-014-core-schema.sql. Enable pgvector. Roles
   already exist: receipts_sync writes pipeline data; receipts_app gets SELECT
   only on core; receipts_trust SELECT only. No foreign key from core to app.
3. Import members from the Politicians tab (541 rows) and check them against the
   unitedstates/congress-legislators legislators-current file.
4. Import bills, impact statements (with versions and stakeholders),
   sponsorships and the donor tables from Sheets.
5. Do NOT copy votes from Sheets. For each row of the Roll Call Votes tab, read
   the roll-call file from storage and load every member's position.
6. Copy bill vectors from Pinecone index `bills-promises`, namespaces
   S000148_bills and T000250_bills (vector id = Action UID), keeping one per
   bill. Before trusting them, re-embed five bills and compare: the pipeline
   calls text-embedding-3-small at 1024 dimensions, but the index is tagged
   3-large. Report the cosine similarity you get.
7. Gate G1: compare member_bill_actions with
   mirror.mirror_politician_bill_actions for both senators, field by field.
   The only differences should be the five listed in vote-slot-rules.md.
   Report every difference, expected or not.

RULES
- Sheets, Pinecone, schemas `mirror` and `app`, the Render service and every
  existing n8n workflow are READ-ONLY in this phase. Build any new workflow in a
  new n8n folder named "v2".
- Nothing a voter can see may change.
- Dry run before any write. Show the counts, then write.
- n8n: update_workflow only writes a draft. Publish, then confirm versionId
  equals activeVersionId. Make n8n API writes only after Matt confirms the
  editor is closed.
- Do not import docs/v2/reference/ossoff-load-backup-2026-10-10.json. It is for
  Phase 4.
- OpenAI spend this session: $5 at most. Ask before exceeding it.
- Ask before anything destructive or anything not listed here.
- Plain names over clever ones. Prefer the simplest thing that passes G1.
- Run npm test and npm run typecheck before opening a pull request.

DONE WHEN
A pull request holds the migration and the import tooling; `core` is loaded; and
you have reported the row count of every table and the full G1 difference list.
Do not start on the query tool or the new pipeline workflows.
```

## If you want to keep Pinecone

The prompt assumes bill vectors move into Supabase. To keep Pinecone instead, replace the last two sentences of TARGET with "Bill vectors stay in Pinecone, one per bill, in a single `bills` namespace" and replace task 6 with "Re-index Pinecone to one vector per bill in a new namespace `bills`, leaving the existing namespaces untouched."
