# Phase 2 kickoff prompt

Use this only after Phase 1 has finished and gate G1 has passed. Before pasting, check it against what Phase 1 actually built: table names, the search function's name, and the migration number.

```
You are doing Phase 2 of "Receipts v2" in the repo maddyp86/receipts: teaching
the query tool to read Supabase, behind switches that stay OFF. Do Phase 2 only,
then stop and report.

READ FIRST
1. docs/v2/plan.md, especially "Phase 2" and "Proof before switching"
2. docs/v2/reference/sources.md
3. The Phase 1 pull request: the `core` schema and what was loaded
4. packages/server/src/data/ActionStore.ts, PineconeActionStore.ts,
   SenatorCache.ts, services.ts, evaluation/enrichment.ts
5. docs/adr/README.md (ADR-005, ADR-009, ADR-010) and tools/eval.mts,
   tools/rank-check.mts

WHAT EXISTS
Phase 1 loaded schema `core` (members, bills, bill_impacts with embeddings,
roll_calls, member_votes, sponsorships, donors, donor_alignments), the view
member_bill_actions, and a function that ranks one member's bills against a
query vector. The live tool still searches Pinecone and reads schema `mirror`.

TASKS
1. One place for the schema name. The server names mirror.mirror_* directly in
   15 places across enrichment.ts, SenatorCache.ts, textVersions.ts and
   summaryReview.ts. Read it from one setting, RECORD_SCHEMA, default "mirror".
2. Compatibility views: a new schema `compat` with one view per mirror table the
   tool reads, same column names, same keys inside `row`. Next migration number.
   receipts_app gets SELECT only.
3. SupabaseActionStore implementing ActionStore, chosen by a setting
   ACTION_STORE, default "pinecone". Same MatchedAction fields, same similarity
   floor, same returned / belowFloor / topScore / nearMisses. Keep today's
   Action UIDs.
4. Picker: a member is listed when in_scope and live are true and a record
   exists; the coverage sentence uses that member's congresses. The branch
   feat/live-flag-and-member-coverage has this logic and its tests. Fold it in.
5. Gate G2: extend tools/rank-check.mts to run each saved eval query vector
   against both stores and compare bills, order, and scores to three decimals.
   Pinecone can return a bill more than once; compare each bill's best rank.
6. Gate G3: run `npm run eval` once per store. Compare case by case.

RULES
- Both settings keep their defaults. Production behaviour must not change, and
  you do not touch the Render service's environment.
- No change to prompts, checks, verdict logic or voter-facing copy.
- The tool never embeds or re-analyses a bill at query time. That stays true.
- Sheets, Pinecone, schema `mirror`, schema `app` data and every n8n workflow
  are read-only.
- Each eval run costs about $2 to $6. Two runs are budgeted. Ask before a third.
- Run npm test and npm run typecheck before opening the pull request.
- Ask before anything destructive or anything not listed here.

DONE WHEN
One pull request holds the setting, the views, the new store and the comparison
tool; and you have reported the G2 result per eval case and the G3 result per
case for both stores, with every difference explained.
```
