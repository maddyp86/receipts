# Phase 3 kickoff prompt

Use this after Phase 1. It can run alongside Phase 2. Before pasting, check it against what Phase 1 actually built.

The build is one sitting. Gate G4 needs three daily runs, so the comparison is checked on the following days, in the same session or a new one pointed at the same instructions.

The cutover at the end of this phase is not in the prompt on purpose. It changes what voters see, so it is done with Matt present, following the six steps in `plan.md`.

```
You are doing Phase 3 of "Receipts v2": building the new daily pipeline in n8n
that fills Supabase schema `core`, and running it beside the old pipeline until
it is proven. Do the build and the parallel run only. Do NOT cut over.

READ FIRST
1. docs/v2/plan.md, especially "Pipeline", "Phase 3" and "Proof before switching"
2. docs/v2/reference/sources.md and docs/v2/reference/vote-slot-rules.md
3. The Phase 1 pull request: the `core` schema and the import tooling
4. In n8n (read-only), the workflows listed in sources.md. The logic to carry
   over lives in: Senate Sponsorship Data (member endpoints, paging guard),
   Bill Progress and Effort (progress rules, cosponsor dates), Bill Impact
   Statement (prompt, bill-context builder, version path), Bill Embeddings
   (the text that gets embedded), and Mirror Sync, one table (chunked upserts).

BUILD
A new n8n folder "v2", five workflows and one daily orchestrator that runs an
hour after the old one (old: 06:00 Pacific). Every workflow upserts into `core`
and writes one core.ingest_runs row: what it read, what it wrote, errors, model
tokens used. None of them reads a whole table to find out what is new.
1. Members, weekly. Never touches in_scope, live or the congresses collected.
2. Roll calls. List the storage bucket for vote files changed since the last
   run. Keep today's filter (passage and cloture votes on a bill). Load each
   one whole, every member's position.
3. Sponsorships and bills. For each in_scope member: sponsored and cosponsored
   bills from the congress.gov member endpoints, stopping once the list passes
   that member's congresses and failing loudly if it is cut off. New bills get
   detail from the bucket. Port the progress rules. Take true cosponsor dates
   and withdrawals from the bill file.
4. Impact statements. Bills linked to an in_scope member with no statement.
   Same prompt and bill-context builder, cap of 60 a run, a monthly budget
   stop. Mark a statement written from the title alone and redo it when the
   text is published. One statement per text version when the text changes.
   SHIP THIS ONE IN DRY-RUN.
5. Embeddings. Statements with no embedding or changed text. Same recipe.
Add an error workflow that emails Matt when any of them fails.

PARALLEL RUN
- The old pipeline stays the source for the live tool.
- Statements are generated once, by the old pipeline, and copied into `core`
  each day with the Phase 1 import. Your statement workflow runs in dry-run on
  the same bills so the outputs can be compared without being used.
- Each day, report `core` against the Sheets for Schumer and Thune: bills,
  sponsorships, roll calls, derived votes.
- Gate G4: three consecutive days of clean runs with no differences.

RULES
- Every existing n8n workflow, the Sheets, Pinecone and schemas `mirror` and
  `app` are read-only. Do not edit, unschedule or delete anything that exists.
- n8n: update_workflow only writes a draft. Publish, then confirm versionId
  equals activeVersionId. Write to n8n only after Matt confirms the editor is
  closed. Creating a workflow needs his approval in the moment.
- Dry run before any write to `core`. Show the counts, then write.
- OpenAI spend: $5 for the build, and nothing recurring until cutover, because
  the statement workflow is in dry-run. Ask before exceeding it.
- No new member is set in_scope in this phase.
- Ask before anything destructive or anything not listed here.

DONE WHEN
The five workflows and the orchestrator are published in folder "v2"; G4 has
passed; and you have reported the three daily comparisons and the dry-run
statement samples side by side with the old pipeline's. Then stop. The cutover
is done separately with Matt.
```
