# Phase 5 kickoff prompt: House members

Written 11 October 2026 for a separate session that builds House support while the main session adds the six senators (Phase 4). The target is the first House member live by 16–18 October and all six before the 3 November midterms.

Before pasting, check the state at the top of the prompt is still true: the cutover happens on 12 October if G4 day 2 is clean.

```
You are doing Phase 5 of "Receipts v2": adding House members, so voters can
check midterm House candidates' records before 3 November 2026. Another
session is adding senators (Phase 4) at the same time, in the same n8n folder
and the same Supabase project. Work only in your own lane (below).

STATE WHEN YOU START
- Phases 1-3 are done. The v2 pipeline (n8n folder "v2") runs daily at 07:00
  Pacific and fills Supabase schema `core`. From the 12 October cutover, the
  live tool reads `core` (RECORD_SCHEMA=compat, ACTION_STORE=supabase). Check
  with Matt whether the cutover has happened.
- Only senators are collected. core.members holds all 438 House members with
  in_scope = false.

READ FIRST
1. docs/v2/plan.md: "Phase 5: House members" and "Design rules"
2. docs/v2/phase-3-report.md: what the pipeline does and the bugs already found
3. docs/v2/reference/sources.md (bucket paths, the scraper fork) and
   docs/v2/reference/vote-slot-rules.md (how a member's votes are derived)
4. docs/v2/pipeline/: build.py generates every v2 workflow from js/ and sql/.
   Change the source, rebuild, then push to n8n. Never edit n8n by hand only.
5. RECONCILIATION.md: the durable record of decisions
6. The definition of the view core.member_bill_actions (pg_get_viewdef)

WHAT IS SENATE-ONLY TODAY (the work)
1. Scraper. The bucket is filled by GitHub Actions in the fork
   maddyp86/congress. Bills cover s sres sjres sconres hr hjres hconres. Add
   House simple resolutions (hres) to the bill upload.
2. Roll calls. The v2 roll-calls workflow lists only Senate vote files
   (glob **/s*/data.json) and keeps chamber 's', categories passage and
   cloture. House vote files are .../votes/{year}/h{number}/data.json and name
   members by bioguide id, not LIS id. Decide which House categories count as
   a vote on a bill (passage and passage-suspension at least; there is no
   cloture), and test the choice on one member against congress.gov.
3. Derived votes. core.member_bill_actions keeps only chamber 's', joins
   member_votes to members on lis_id, and has cloture and passage slots. Make
   it chamber-aware: House voters join on member_id (bioguide), and House bill
   votes fill the passage slot. Senate output must not change by one row
   (check against docs/v2/g1-check.sql). This is a migration: write it, show
   the before/after counts, and apply it only with Matt's yes.
4. Party-line check. The tool's check (G3) compares a member with their own
   party whip's vote (fixed in PR #67). The whip position is derived from
   member_votes and members.roles. Add the House whips and check the House
   rows on one member.
5. Wording. The voter-facing copy says "senator" in about 46 places. Make it
   follow the member's chamber ("representative", "Rep."). Show Matt the
   strings before and after. He signs off on the copy.
6. Picker. List members by chamber, state and district. The web roster
   (PR #49) already carries chamber and district.
7. Members. One at a time, Phase 4's checklist: set in_scope and the
   congresses to collect (119th first); run the sponsorship pull; show the
   new-bill count and estimated statement cost (about $0.04 a statement)
   BEFORE spending; run statements and embeddings; review five bills by hand
   (sponsorship, vote, statement) and three test queries; set live only with
   Matt's yes. Order: Lawler, Valadao, Perry, Gluesenkamp Perez, Kaptur,
   Gonzalez. Add one eval case per member (docs/eval/cases.json).

YOUR LANE, AND THE OTHER SESSION'S
- Yours: the scraper fork, the House parts of the roll-calls workflow and of
  core.member_bill_actions, the House whip check, chamber-aware copy, the
  picker, and House members.
- Theirs: senators, the Phase 3 PR, the statements and embeddings workflows.
- Shared, so coordinate through Matt before each edit: the v2 roll-calls
  workflow and the orchestrator. Prefer adding House handling behind a
  setting (e.g. a `chambers` config defaulting to the Senate) so the daily
  Senate run is unchanged until you switch it on. Before publishing a change
  to a shared workflow, dry-run it and show that the Senate output is
  identical (zero changes in its preview).

RULES
- Everything in mirror, app, the Sheets, Pinecone and every non-v2 n8n
  workflow is read-only. Do not edit, unschedule or delete anything that exists
  outside your lane.
- n8n: update_workflow writes a draft only. Publish, then confirm versionId
  equals activeVersionId. Write to n8n only after Matt confirms the editor is
  closed. Creating a workflow needs his approval at the time.
- Never run several heavy n8n workflows at once: the Cloud instance runs out
  of memory. In a Code node, executeOnce hands the node only its first input
  item; don't set it on a node that reads $input. Write partial rows with
  UPDATE, not a partial INSERT ... ON CONFLICT (NOT NULL fails first).
- Dry run before any write to core. Show the counts, then write.
- No fabricated data about any real member of Congress, in fixtures, tests or
  copy. Use real records or clearly fictional ones.
- One PR per task, each targeting main. Never merge; Matt merges. Pull main
  before each new branch: the senators session is merging too.
- Keys and passwords never go in chat. Your local DATABASE_URL is a read-only
  role on production; treat production as production.
- Model spend: show the estimate before each member and wait for his yes.
- Ask before anything destructive or anything not listed here.

DONE WHEN
- Lawler is live. His five hand-checked bills and three test queries are in
  his PR. The House rows of member_bill_actions match congress.gov for him.
  The Senate output of every shared piece is unchanged.
- Then each of the other five, one PR per member, as fast as review allows.
- Report: what changed per piece, the House vote categories chosen and why,
  and each member's bill count, cost and review notes.
```
