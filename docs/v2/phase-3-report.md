# Phase 3 report: the v2 pipeline, running beside the old one

Built and published 10–11 October 2026. **Cut over on 12 October 2026** (evening, Pacific): the live tool reads `core`, the v2 pipeline writes it, and the old pipeline is unscheduled. See "Cutover" below.

Status: G4 passed on two clean days (11 and 12 October); Matt accepted two days in place of three. Rollback stays available until 26 October.

## What exists

Nine workflows in n8n folder `v2`. The eight that make up the pipeline are published, and each one's versionId equals its activeVersionId. Each sends failures to the alert workflow.

| Workflow | ID | What it does |
|---|---|---|
| orchestrator | `7QF697TzBBToCLMg` | Daily at 07:00 Pacific, an hour after the old one. Runs the steps below in order, members on Mondays only, then the G4 comparison. A manual start is a dry run. |
| roll calls | `afD0D175IIvQq6JE` | Lists the Senate vote files in the bucket and reads only those never read (a vote file's hash changes daily, so a file is read once). Keeps passage and cloture votes on a bill, as WF1 does. |
| sponsorships and bills | `pSMxbhgKiNuT8k7J` | In-scope members' bill lists from congress.gov, plus bill files whose hash changed. Builds new and changed bills and sponsorships with WF2, WF2b, WF2c and WF4's rules. |
| statement copy | `UfBVi6J04kywHvII` | Parallel run only. Copies the old pipeline's statements, stakeholders and version statements into `core.bill_impacts` when they change. Retired at cutover. |
| impact statements | `bju40moJW95vWE2g` | WF5's prompt, context builder, parser and taxonomy gate, unchanged; WF5b's version requests. Runs in **plan** mode until cutover (no model calls). `sample` writes `core.impact_drafts`; `live` writes `core.bill_impacts`. |
| embeddings | `yXhFh4whNIECxyd5` | WF6's exact text, `text-embedding-3-small` at 1024 dimensions, for bill-level statements whose text hash changed. |
| members | `Ruy16Yem9fYBSnMt` | Weekly refresh from congress-legislators. Never sets `in_scope`, `live` or `congresses`. |
| failure alert | `mRReCVsl8NW9mWCU` | Emails Matt (credential "Gmail account 2") and records the failure in `core.ingest_runs`. |
| statement samples (one-off) | `GOxSFajHNvbOzdZS` | Ran the samples below. Not published; archived after this report. |

Every workflow is generated from `docs/v2/pipeline/` by `build.py`. Every write is guarded, so a row changes only when a value differs. Every write run leaves one `core.ingest_runs` row.

## Data changes made in this phase

- **Migration 016** (`docs/supabase-migration-016-pipeline-ledger.sql`, applied): `core.source_files` (which bucket files were read), `core.impact_drafts`, and on `bill_impacts` the columns `title_only`, `embedded_text_md5` and `content_changed_at`.
- **Seeding**, five orchestrator write runs on 11 October (`ingest_runs` 10–35):
  - all 1,606 Senate vote files and 973 bill files read and recorded in `source_files`;
  - roll calls, member votes, sponsorships, members and statements: **no changes**;
  - 68 bills gained a text link where core had none (see G4);
  - all 973 bill-level statements re-embedded from core's own text: 512,935 tokens, about $0.01.
- Members: 11 new members (none in scope), K000401's party Republican → Independent, and 2 term-end dates. These are written on the first Monday run.

## Gate G4: core against the Sheets, Schumer and Thune

A day passes when every run is clean and no difference is unexplained.

| Day | Runs | Member-bill rows (Sheets / core) | Bills | Roll calls (Sheets / core) | Differences | Unexplained |
|---|---|---|---|---|---|---|
| 11 Oct | all ok | 1,162 / 1,164 | 973 | 228 / 228 | 76 explained | **0** |
| 12 Oct | all ok | 1,162 / 1,164 | 973 | 228 / 228 | 76 explained | **0** |

The explained differences:
- **5 Phase 1 vote corrections** (8 rows), where the Sheets are wrong and core is right: Schumer's hr5371-119 passage vote, Thune's sres13-118 and sres21-118 rows, and the s870-118 passage vote for both senators.
- **68 text links by design** (agreed 11 October): v2 fills a bill's text link once congress.gov publishes it; the old pipeline sets the link only when it first sees a bill.

**Caution.** Day 1 had nothing new: no unread vote file, no changed bill file, no new sponsorship pair, on both pipelines. Day 2 was the same. The Senate is likely out until after the 3 November election. Two consequences:
- The changed-bill and vote paths *were* exercised end to end during seeding, on every file, with zero differences.
- The new-bill and new-pair paths were tested only locally (35 bills). No n8n run has written one yet.

## Statement samples, beside the old pipeline's

Ten bills, `statements_mode: sample`, drafts in `core.impact_drafts` (run 43). They were chosen for the cases that most often go wrong.

| Bill | Old issue | Draft issue | Verdict |
|---|---|---|---|
| hjres7-118 | Gov. Reform / Executive Branch Power | same | Same; executive-action reversal kept |
| s1992-118 | Tax Reform / Tax Cuts & Credits | same | Same |
| sconres33-119 | Budget / Government Budget & Spending | same | Same |
| s1071-119 | Budget / Government Budget & Spending | Foreign Policy & Defense / Defense Spending | Draft better |
| s4796-119 | Budget / Taxes | Tax Reform / Corporate Taxes | Draft better; the old summary's "revenue funds infrastructure" isn't in the text |
| hjres142-119 | Gov. Reform / Federal, State, Local Relations | Budget / Taxes | Draft better (a DC income-tax act); target effect more specific |
| hjres25-119 | Tax Reform / Individual Income Taxes | Gov. Reform / Gov. Operations & Oversight | Old better; reversal and target effect agree |
| hr5334-119 | Education / K-12 | Budget / Taxes | **Draft worse**: "text unavailable", effects and stakeholders empty |
| sres13-118 | Crime / Violent Crime | same | **Draft worse**: "text unavailable", no keywords |
| hr1-119 | Budget / Government Budget & Spending | same | **Draft worse**: summarised appropriations, missed every tax provision |

**Why three are worse.** This comes from WF5's design, which was ported unchanged:
- For a normal-sized bill, WF5 doesn't fetch the text; it tells the model to read the bill's URL.
- The prompt also limits web search to external documents, so whether the model reads the bill varies from call to call. The two "unavailable" drafts made no web searches.
- hr1-119's title isn't on WF5's large-bill list, so it didn't get the summary path either.
- In live mode these drafts would be written to `bill_impacts`: they are flagged for review, but not marked title-only, because a text link exists.

**Fixed and re-tested (11 October, run 44).** Every bill's text is now fetched and handed to the model inline, as version requests already were. Reconciliation bills take the large-bill summary path, and a bill with no published text gets the CRS summary rather than its title. The three bad bills, re-run:

| Bill | Before | After |
|---|---|---|
| hr1-119 | Appropriations details; no tax provisions | Leads with the $5 trillion debt-limit increase, the tax extensions and new credits, and the SNAP and Medicaid changes |
| hr5334-119 | "Text unavailable" | The educator expense deduction extended to early childhood educators (section 62(d)(1), from 2026) |
| sres13-118 | "Text unavailable" | National Stalking Awareness Month: prevalence, technology-facilitated stalking, victim services |

All three passed the parser's checks, with no flags and no missing fields. They cost $0.115 in all, with no web searches. Fetching the text is also cheaper: about $0.04 a bill.

**Cost.** $0.61 for the ten (380,438 input tokens, 14,490 output, 26 web searches), about $0.06 a bill. A first run cost about the same but wrote only one draft: a bug, fixed below. The samples cost about $1.20 in all, against a $5 build budget. With the text fetched inline, a statement costs about $0.04; at the cap of 60 bills a day, live mode costs at most about $2.40 a day. The monthly budget stop is $25.

## Cutover, 12 October 2026

Done with Matt present, in the order `plan.md` sets.

1. **Gates.** G2 and G3 passed in Phase 2. G4 passed on 11 and 12 October; Matt accepted two days in place of three.
2. **Statements.** The v2 orchestrator calls impact statements in `live` mode, and its statement copy from the Sheets is disabled, not deleted. A dry run first: live mode found no bill needing a statement and wrote nothing. Published as version `cb0bc487`.
3. **Render.** `RECORD_SCHEMA=compat` and `ACTION_STORE=supabase` were set on service `receipts`. The deploy carried #76. `/api/health` reports `store: supabase`, and `/api/senators` returns Schumer and Thune with `coverage_congresses` [118, 119], a key only `core` has.
4. **Eval on the production settings.** All 50 cases, run locally with the two settings: **42 pass**, and the 8 failures are exactly the cases that failed in both Phase 2 runs (1, 3, 8, 12, 15, 22, 23, 29), with the same verdicts. Nothing new failed. Case 34 (Thune border), which failed only on the old store, passes on core. Cost $5.00. Report: `.data/eval/2026-10-13T05-04-39-095Z.json`.
5. **Old workflows unpublished, not deleted:** the old orchestrator `JWMFbg6I0cDTxzwu` (version `bd64efc5`) and Mirror Sync `tGcHOxabA29Tjob2` (version `54961739`).
6. **Workbooks view-only:** Matt.

**Rollback, until 26 October:** set `RECORD_SCHEMA=mirror` and `ACTION_STORE=pinecone` on Render, then republish the two old workflows. The Sheets and `mirror` stop updating from tonight, so a rollback serves the record as of 12 October until the old pipeline catches up on its first run.

**After two clean weeks:** delete the old workflows, drop the `mirror` schema, remove the Pinecone code path, and delete the Pinecone bill namespaces.

**Still running daily:** the G4 comparison in the orchestrator. The Sheets no longer update, so from now on it will report differences as `core` moves ahead. That's expected, and it can be switched off once the rollback window closes.

## Bugs found by running on n8n, all fixed

1. **Reports dropped data.** A Code node set to execute once sees only its first input item, so reports kept one table of several. Fixed for Code nodes that read their input.
2. **Only the first sample was kept.** The same setting on the IF node "Model was called?" passed on only the first of ten model answers.
3. **Out of memory.** The statement copy repeated about 6 MB of previews on each of its 11 output items. Previews now go on the first item only. Running five workflows at once also crashed the instance; the orchestrator runs them in sequence.
4. **First write failed.** Partial rows written as `INSERT … ON CONFLICT` fail Postgres's NOT NULL check before the conflict is found, so the batch rolled back. Changed-bill refreshes, text-link fills and the members LIS id are now guarded `UPDATE`s.
5. **Orchestrator failed at once.** It passed `dry_run` to sub-workflows as a boolean where the input is typed string.
6. **No cost record.** The OpenAI node's simplified output carries no token usage, so cost read $0 and the budget stop could never fire. The node now returns the raw response, which keeps the same `output` array WF5's parser reads.

## Known differences between the source and n8n

- Six Code nodes that never call the shared `emit` helper still carry its pre-fix body. They behave identically.
- `compare.js` has a comment recording the 11 October decision that isn't in the stored node.

## Before cutover (decisions for Matt)

1. ~~Fetch the bill text inline for every statement~~: done 11 October and re-tested (above).
2. Exercise the new-bill and new-pair paths on n8n once Congress is back in session, or before cutover with a staged bill.
3. **Queued for after Phase 3, with the tax-query work:** only bill-level statements are embedded, in the old pipeline and v2 alike, so a gut-and-amend bill can be found only by its bill-level statement. For example, hr5334-119 is searchable as the educator deduction, not as the Russia sanctions text that was enacted.
