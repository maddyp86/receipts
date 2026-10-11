# Where today's data lives (reference)

Read on 10 October 2026, after the partial Jon Ossoff load was rolled back. Row counts exclude the header row.

Everything here is read-only for v2 work until cutover.

## Google Sheets

### Master Data Workbook

`1AJK0A8rJ5oY4kUwnYR7Z_g_W2tGnwCNlfMsGwbGaTj0`

| Tab | Rows | Goes to | Columns |
|---|---|---|---|
| `Politicians` | 541: 100 Senate, 441 House including delegates | `members`. Only Schumer and Thune are In Scope. | Politician ID, Full Name, In Scope, Chamber, LIS ID, openSecretsID, Party, State, Class, Role, District, Term Start, Term End, Website |
| ` Politician Bill Actions` | 1,162 | `sponsorships` (votes are re-read from source) | see below |
| `Bills Master` | 973 | `bills` | Bill ID, Congress, Bill Type, Bill Number, Bill Base, Date, Official Title, Short Title, Popular Title, Subject, Subjects, Summary, Status, Active, Primary Sponsor, Bill Status URL, Bill Text URL, Status Changed At, Status Checked At, Progress Stage, Progress Outcome, Progress Stage At, Progress Checked At, Last Action At, Last Action Text, Committee Activity, Referred Committees, Cosponsor Count, Enacted Via, Source Updated At, Source Changed |
| `Roll Call Votes` | about 228 | the list of roll calls to re-read | Vote ID, Session, Chamber, Roll Call No, Bill Type, Bill No, Congress, Bill Base, Bill ID, Date, Category, Question, Type, Result, URL |
| `Party Vote Positions` | about 456 | derived in v2 from `member_votes` and roles | UID, Politician ID, Vote ID, Name, Party, State, Vote, Bill Type, Bill No, Congress, Bill ID |
| `Party Whips` | 6 | `members` roles | Politician ID, LIS ID, Full Name, Congress, Party, Chamber, State, Class, District, Term Start, Term End, Website |
| `Donors` | about 884 | `donors`, copied as is | Donor UID, Politician ID, openSecretsID, Cycle, Contributor, Industry, PAC Sector, Policy Area, Primary Issue, Sub Issue, Description, Total Amount, PAC Amount, Individual Amount |

The leading space in ` Politician Bill Actions` is the tab's real name. Trimming it breaks the read.

Columns of ` Politician Bill Actions` (47): Action UID, Bill ID, Politician ID, Full Name, Party, State, Vote, Vote ID, Action Date, Cloture Vote, Cloture Vote Date, Cloture Vote ID, Cloture Vote Count, Passage Vote, Passage Vote ID, Passage Vote Count, Passage Vote Date, Is Sponsor, Is Co-Sponsor, Action Type, Sponsor Tier, Cosponsored At, Original Cosponsor, Cosponsor Ordinal, Cosponsor Total, Days After Introduction, Withdrawn At, Committee Member, Committee Member Of, Progress Checked At, Impact Statement Created, Embedded, Embedded At, Embedding Version, P2B Reviewed, B2P Reviewed, Match Status, Match Count, Partial Match Count, False Positive Count, Total Match Count, Unmatched Count, Strongest Match UID, Strongest Match Confidence, Promise UIDs Matched, Evaluated Promise UIDs, Last Evaluated.

One row is one member and one bill. Sponsorship rows have UIDs like `ACT-S-{bill}-{member}`; vote rows have `ACT-{bill}-{member}`. A row that is both keeps whichever UID it got first. The match columns from `P2B Reviewed` onward belong to the old evaluation pipeline and are not read by the query tool.

### Impact Statements workbook

`1eQFWCstVau5GpB6NnQwGHc_ZytO54Hjyj5RPEK2nOko`

| Tab | Rows | Goes to | Columns |
|---|---|---|---|
| `Impact Statements` | 973 | `bill_impacts` | Impact UID, Bill ID, Congress, Title, Policy Area, Primary Issue, Sub Issue, Bill Keywords, Reviewed, Intended Effects, Mechanisms, Summary, Reverses Existing Policy, Target Type, Target Name, Target Source, Target Effect, Direction Confidence, Flagged For Review |
| `Affected Stakeholders` | 3,420 | `bill_impacts` (stakeholders) | Stakeholder UID, Impact UID, Bill ID, Stakeholder Group, Positive Impacts, Negative Impacts |
| `Impact Statements - Versions` | not counted | `bill_impacts`, one per text version | Impact Version UID, Run ID, Bill ID, Congress, Text Version Code, Text Version Type, Text Version Date, Text URL, Summary Action Date, Title, Policy Area, Primary Issue, Sub Issue, Taxonomy Divergent, Taxonomy Divergence Detail, Bill Keywords, Intended Effects, Mechanisms, Summary, Affected Stakeholders JSON, Reverses Existing Policy, Target Type, Target Name, Target Source, Target Effect, Direction Confidence, Flagged For Review, Version Mismatch, Version Title Source, Generated At |

### Other workbooks

- **Donor Alignments:** workbook `1R8BAa8Btm38RwxhLhzNgokwWZbd8yofHaK60ZcCWeN4`, tab `Donor Alignments`. Columns: Donor Alignment UID, Politician ID, Bill ID, Impact UID, Donor UID, Donor Name, Donor Cycle, Alignment, Confidence, Rationale. The mirror rolls this up to one row per member and bill.
- **Manifest tracker:** workbook `1fx_1JSvJNhkeC9DUd7xoIy8_42XLupcyByZEbtz7XuA`, tabs `Bill Manifest`, `Vote Manifest`, `Pipeline Run Log`. Not imported. v2 replaces them with `ingest_runs`.

## Source files

- **Roll call:** `https://storage.googleapis.com/congress-legislative-data/congress-vote-data/data/{congress}/votes/{year}/{chamber}{number}/data.json`. For Vote ID `s618-119.2025` that is `.../data/119/votes/2025/s618/data.json`.
- **Bill:** `https://storage.googleapis.com/congress-legislative-data/congress-bill-data/data/{congress}/{type}/{type}{number}/data.json`.
- The bucket is filled by GitHub Actions in the fork `maddyp86/congress`. Both chambers' votes are scraped. Bills cover `s sres sjres sconres hr hjres hconres`; House simple resolutions (`hres`) are not uploaded yet.
- **Member sponsorships:** congress.gov API, `/v3/member/{bioguide}/sponsored-legislation` and `/cosponsored-legislation`, 250 per page, newest congress first.
- **Members:** the `legislators-current` file from `unitedstates/congress-legislators`.

## Pinecone

Index `bills-promises`, 1024 dimensions, cosine.

| Namespace | Vectors | Note |
|---|---|---|
| `S000148_bills` | 609 | One per action row; vector id is the Action UID |
| `T000250_bills` | 553 | Same |
| `S000148_statements` | 1,862 | Promise vectors. Not read by the query tool. Not migrated. |
| `T000250_statements` | 1,366 | Same |

The index is tagged `text-embedding-3-large`, but the embedding workflow calls `text-embedding-3-small` with `dimensions: 1024`. Check a sample before trusting either.

The Pinecone connector tools cannot return vector values. Copy vectors through an n8n HTTP node that calls the index host (`bills-promises-zp2qtjn.svc.aped-4627-b74a.pinecone.io`) with the `Pinecone API` credential n8n already holds.

The query tool's own setting is `text-embedding-3-small` at 1024 dimensions, the same as the embedding workflow, so the index tag is believed to be stale.

## Supabase

- Schemas today: `mirror` (ten tables copied from Sheets, each with a jsonb `row` plus typed keys) and `app` (queries, traces, usage, feedback).
- Roles: `receipts_sync` writes pipeline data, `receipts_app` is the query tool, `receipts_trust` is read-only.
- Migrations live in `docs/supabase-migration-0NN-*.sql`. The latest is 013, so the next is 014.
- The mirror is filled by n8n workflow `tGcHOxabA29Tjob2` (Tuesday and Friday 06:00 Pacific), which calls `hHgKPuixmqESi1uX` once per table. That child workflow shows the chunked upsert pattern.

## n8n

Instance `maddyp.app.n8n.cloud`, project "Politician Trustworthy".

Credentials already stored there: `Google Sheets account`, `Postgres account`, `Pinecone API`, `n8n OpenAI`.

| Workflow | Id |
|---|---|
| Orchestrator - Query Tool (daily 06:00 Pacific) | `JWMFbg6I0cDTxzwu` |
| Senator Vote Data (WF1) | `6sKWQTlkGhl0ftGh` |
| Senate Bill Data (WF2) | `N4gE8gAvyC6cw5aY` |
| Party Whip Vote Data (WF3) | `a5NrBYIJNuedFipe` |
| Senate Sponsorship Data (WF4) | `QgLsT0CsWwFe1T6b` |
| Bill Impact Statement (WF5) | `0lCgjIQfM7XDUY8A` |
| Bill Progress and Effort (WF2c) | `5xNtymvidje2ifRa` |
| Impact Reprocess Queue | `rT1uifUFvmhUvj7r` |
| Bill Embeddings (WF6) | `2tfR7BINlNlE0KhF` |
| Mirror Sync | `tGcHOxabA29Tjob2` |
| Mirror Sync, one table | `hHgKPuixmqESi1uX` |

Three of these were changed on 10 October 2026 to stop a daily out-of-memory crash, and stay as they are: WF4 reads the actions tab once and caps a run at 100 bills; WF5 caps a run at 60 bills; WF6 retries its calls.

## The rolled-back Ossoff load

`ossoff-load-backup-2026-10-10.json` in this folder holds every row the partial load added and the cleanup removed: 200 sponsorship rows, 157 bills, 41 impact statements and 139 stakeholder rows. Phase 1 does not import it. When Ossoff is loaded in Phase 4, the 41 statements can be reused instead of paid for again.
