# The 120th Congress: roster transition plan

Written 2026-11-04, the day after the midterms. Status: **proposal, nothing changed yet.**
Decisions marked **DECIDE** are Matt's; **DECIDED** ones are settled.

## Why now

The 120th Congress convenes **3 January 2027**. Between now and then the 119th sits
in its lame-duck second session, and every outgoing senator keeps voting, so the
daily pipeline must keep collecting for them until the day they leave. On 3 January
three things happen at once: departed senators stop having a record, freshmen start
one from zero, and every per-congress table in the code and the data needs a 120 row.

### What the election did to our roster

Live senators today (all `in_scope`, `live`, `congresses {118,119}`):

| Member | Class | 2026 | Status on 3 Jan 2027 |
|---|---|---|---|
| Schumer S000148 | 3 | not up | continues (likely Majority Leader again) |
| Thune T000250 | 3 | not up | continues (likely Minority Leader) |
| Ossoff O000174 | 2 | re-elected | continues |
| Collins C001035 | 2 | **lost** to Troy Jackson (D) | leaves; record closes |
| Sullivan S001198 | 2 | **uncalled**, Peltola (D) narrowly ahead | may leave |

Queued, not yet loaded (no money spent): Marshall **lost** to Adam Hamilton (D) and
drops off the queue. Warner and Luján were not reported as flips; confirm before loading.
Democrats took the chamber with seven flips (TX, KS, IA, SC, NC, OH, ME) and two races
still open (AK, MS) as of this morning. Leadership is not elected yet: do **not** write
120th leader or whip roles until the caucuses vote (mid/late November).

Sources: NBC, CNBC, Newsweek and the Washington Post results pages, 4 Nov 2026.

## What exists today (verified in code and the live database)

- **One row per member, no tenure.** `core.members` has `term_start`/`term_end`
  (last term only, refreshed weekly from legislators-current), `left_at` (set from
  legislators-historical once it lists the member, usually within a day), and
  `congresses smallint[]`, which means *congresses we collected*, not *served*. There
  is no `member_terms` table. Collins shows `term_start 2021-01-03` though she has
  served since 1997; a freshman will show `2027-01-03`, which is right.
- **Nothing in the pipeline hardcodes 119.** Roll calls and sponsorships take the
  union of in-scope members' `congresses`. The members workflow (`Ruy16Yem9fYBSnMt`)
  never writes `in_scope`, `live`, `congresses` or `roles`; those are set by hand.
  The only date constant is `RECORD_START = '2023-01-03'` in `docs/v2/pipeline/js/members.js`.
- **Two hard failures block adding 120 early.** `rollcalls_list.js:25` and
  `sb_list.js:20` fail the whole run when a listed congress has no files in the bucket.
  So 120 cannot be put into any member's `congresses` until the scraper fork
  (`maddyp86/congress`) has written the first 120 vote and bill files. Until it is
  added, `sb_parse.js:34` silently drops every 120th bill a continuing senator sponsors
  (counted as `otherCongress`).
- **`currentCongress` flips by date** (`sb_build.js:99-102`) on 3 Jan 2027: 119th bills
  get `DIED_AT_<stage>` when their file is next re-read, and committee membership for
  them becomes `NA_PRIOR_CONGRESS`. Expected, not a bug, but it is a visible change.
- **The picker ignores `left_at`.** `SenatorCache.PICKER_SQL` reads
  `compat.mirror_politicians`, which does not expose `left_at`. A departed senator who
  is `live` stays listed, titled "U.S. Senator for Maine", with no former state in
  `MemberCard`, `SelectedMember` or `memberTitle`. Only `/api/members` (the directory)
  and funding (`funding.ts:106`, "is no longer in office.") look at `left_at`.
- **No tenure-aware answers.** `describeCoverage` lists the member's `congresses` as
  "searched". `NO_RECORDED_ACTION_FOUND` / `NO_MATCHES` copy ("We didn't find any bills
  or votes in this senator's analyzed record…") does not know whether the member was in
  the Senate at the time. A freshman today is simply *uncached*: "We haven't analyzed
  {name} yet", which wrongly implies there is something to analyze.
- **Per-congress lookup tables stop at 119:** `FLOOR_LEADERS_FALLBACK` and
  `PRESIDENT_BY_CONGRESS` in `packages/server/src/evaluation/preEvaluatorGates.ts`,
  `FLOOR_LEADERS` and `PRESIDENT_BY_CONGRESS` in `packages/server/src/judge/judgeGates.ts`.
  `CONGRESS_START` already has 120. `core.members.roles` (leaders and whips by congress)
  is hand-loaded and has no 120 entries. `COVERAGE_CONGRESSES` on Render is `118,119`.
- **Hardcoded reader copy:** `web/src/data/glossary.ts:77` and `Waiting.tsx:41` say
  "The 119th is 2025–26." `roster.ts` `MIDTERM_ROSTER` carries `on_ballot_2026` (never
  rendered) and lists Collins, Sullivan, Marshall as wave 1.
- **Lame-duck collection is automatic.** Roll calls and sponsorships for Collins and
  Sullivan continue until the 119th adjourns; nothing to do.
- **Evals:** `docs/eval/cases.json` has 3 Collins cases (52–54). They keep passing as
  long as her record stays queryable.
- **House:** 439 serving House rows exist with `in_scope=false`; the members workflow
  already tracks House arrivals and departures. The query tool and pipeline are
  Senate-only until Phase 5, so the House side of this transition is roster upkeep only.

## Decisions

**DECIDED 1 (Matt, 2026-11-04) — Outgoing senators: keep their record checkable as a
former member.** The product is receipts; a record does not stop being true when the
member loses, and it costs nothing (no new bills arrive after `left_at`). Show them
under a "Former members" group with a closing date, and say so in every answer. The
alternative (hide on `left_at`) is one SQL filter but throws away the two most
expensive records we have.

**DECIDE 2 — Incoming senators and order.** Nothing can be collected for a freshman
until the 120th records votes and bills, so their records are thin for months and the
cost is near zero at first (~$0.04 per new bill). Suggested order once results are final:
1. **Sherrod Brown (OH)** — already a `core.members` row (former senator, `left_at
   2025-01-03`) with 118th votes in `member_votes`. Set `congresses {118,120}` and
   he is useful on day one. Backfill estimate: $5–15 (many 118th bills already have
   statements from Schumer/Thune/Collins).
2. Troy Jackson (ME) — replaces Collins, the most-asked-about departing record.
3. Peltola (AK) if she wins — House 118th record is outside the pipeline until Phase 5;
   Senate record starts at zero.
4. Talarico (TX), Cooper (NC), Hamilton (KS), Turek (IA), Andrews (SC), El-Sayed (MI).
Warner and Luján stay on the old queue if confirmed re-elected.

**DECIDED 3 (Matt, 2026-11-04) — Tenure model: add `core.member_terms`** (migration
026): `member_id, chamber, state, party, senate_class, term_start, term_end`, one row
per term, written by the members workflow from the `terms[]` array both legislators
files already carry. From it derive, per member: first Senate day, last Senate day,
congresses *served*. Keep `congresses` meaning *collected*. This is the one schema
change in the plan and it unblocks every honest sentence below. The lighter
alternative (expose `left_at` and `term_start` in the compat view) covers departures
and pure freshmen but cannot describe Brown's 119th gap or Collins's pre-2023 service.

**DECIDE 4 — Freshman empty state.** When a covered member's first Senate day is
after our record start, and the retrieved record is empty, say: "{Name} took office on
January 3, 2027. The Senate has recorded {N} roll-call votes since then, and none of
them, or any bill {surname} has sponsored, relates to this." Never the generic
"no bills or votes in this senator's analyzed record" for a member with under a
congress of service. This is the false-absence risk at its sharpest.

## Phases

### Phase 0 — now to results final (Nov 4 → ~Nov 20). No data changes.
- Decide 1–4 above.
- Confirm AK and MS; confirm Warner and Luján; note leadership elections.
- Check the scraper fork `maddyp86/congress` will create `data/120/` paths on its own
  (bucket `congress-vote-data`, `congress-bill-data`); if not, schedule that change.
- Hazard: the members workflow has an unpublished draft right now (`versionId
  0f226045…` ≠ `activeVersionId 003ae1a8…`). Another session edits these workflows.
  Check `get_workflow_history` before any publish and say so in the version description.

### Phase 1 — code and schema prep (Nov, one PR per task, all target `main`)
1. **Migration 026 `core.member_terms`** + members workflow writes it (dry-run first,
   one-off write run per the usual TEMP-draft procedure, with Matt's yes). Grant
   `receipts_app` SELECT per the 014 pattern. Add `Left At`, `First Term Start` and
   `Served Congresses` to `compat.mirror_politicians` (migration 015 shape).
   *Status (2026-11-04, PR #114):* written. Migration 026 adds
   the table, `core.congress_of(date)`, the `core.member_tenure` view and four keys
   on the compat view (`Left At`, `First Term Start`, `Last Term End`, `Served
   Congresses`). `members.js` upserts every term of every member in `core.members`
   (local dry run: 2,922 terms for 566 members, 0 problems). **Migration 026 APPLIED
   to production 2026-11-06** (Matt's yes; catalog `20261106164838 026_member_terms`;
   verify queries clean; every member has 0 terms until the first write run). **Workflow
   not published.** Remaining operator steps: rebuild and publish the members workflow, which also ships the congress.gov cross-check from #88 that was never
   published (the live workflow is still the 15 Oct version, called on Mondays only);
   one dry run by hand; then one write run.
2. **Pipeline tolerance for a brand-new congress.** In `rollcalls_list.js` and
   `sb_list.js`, a listed congress with no files is a quiet `not_yet_published` skip for
   45 days after its `CONGRESS_START`, and a failure after that (mirrors the 3-day 404
   grace from 17 Oct). In `sb_parse.js`, count bills from a congress *newer* than the
   member's array as `future_congress` and put it in the run's `counts` so the alert
   can flag it rather than drop it silently. This lets us add 120 to arrays before
   3 January so day one is automatic.

   **Shipped (4 Nov 2026, PR #113, not yet published to n8n).** Both list
   nodes skip a congress with no files while today is within `grace_days` (new Config
   field on the roll-calls and sponsorships workflows, default 45, passed by the
   orchestrator only if set) either side of its first day, 3 January of 1789 + 2(N−1),
   and report it as `not_yet_published` in the run's counts; outside that window they
   fail as before. For the 120th the window is 19 Nov 2026 to 17 Feb 2027. `Parse Member
   Bills` counts `future_congress` (and `future_congress_by_member`) in the summary and
   still loads nothing from it. The live sponsorships `Result` node (the 17 Oct 3-day
   404 grace) was never in the repo; it is now `js/sb_result.js`, so a rebuild keeps it.
   **The operator still has to:** (a) rebuild and publish the roll-calls and
   sponsorships workflows (steps in the PR), checking `get_workflow_history` first,
   since the sponsorships workflow has an unpublished draft; (b) do a manual dry run of
   each and confirm `not_yet_published: []` and `future_congress: 0` in the Result today;
   (c) from 19 Nov, add 120 to the continuing members' arrays whenever convenient
   (Phase 2 step 2); (d) still confirm the scraper will write `data/120/` paths (Phase
   0), because once 120 is in an array its first bills 404 until the files exist, and
   the 3-day grace covers a per-bill lag, not a missing congress folder.
3. **Picker and cards.** `SenatorCache`/`Senator` carry `left_at`, `first_term_start`,
   `served_congresses`. `MemberDirectory` lists former *covered* members too (they are
   checkable). `memberTitle`: "Former U.S. Senator for Maine (2023–2027)" when
   `left_at` is set. `MemberPicker` groups "Former members" last. `MemberCard` gets a
   "Served until January 3, 2027" line. Funding stays refused (already is).
4. **Tenure-aware copy** (`packages/shared/src/index.ts`): `coverageSentence`,
   `searchSummarySentence`, `recordBoundarySentence` and `ND_REASON_COPY.NO_MATCHES`
   take the member's served window. Three cases: *closed* ("…record through January 3,
   2027"), *freshman* (Decide 4), *gap* ("not in the Senate during the 119th Congress").
   Record-question mode reuses the same sentences.
5. **Per-congress tables.** Add `'120': 'TRUMP'` to both `PRESIDENT_BY_CONGRESS` now.
   Add 120 floor leaders to both tables and to `core.members.roles` (leaders, whips)
   only after the caucus elections, in one PR, with the source cited. Add the 120th line
   to `glossary.ts` and `Waiting.tsx`.
6. **Web roster.** Replace `MIDTERM_ROSTER`'s wave lists with the post-election plan
   (Decide 2) and drop `on_ballot_2026`; fix `roster.test.ts` counts.
7. **Tests and evals.** Unit tests for the three tenure cases; keep Collins cases
   52–54; add one Brown gap case and one freshman case once they have records.

### Phase 2 — the switch (Jan 3–10, 2027)
1. Members workflow (automatic, daily): arrivals appear with `in_scope=false`;
   departures get `left_at` once legislators-historical catches up (~1 day). The alert
   emails because in-scope members (Collins, maybe Sullivan) are touched. Verify.
2. Add 120 to continuing live members' `congresses` (Schumer, Thune, Ossoff, Sullivan
   if re-elected): one UPDATE, with Matt's yes. With Phase 1.2 in place this can be
   done on Jan 3 even before files exist.
3. `COVERAGE_CONGRESSES=118,119,120` on Render.
4. Confirm first 120 vote and bill files land; watch `ingest_runs.counts` for
   `not_yet_published` and `future_congress` going to zero.
5. Expect the `DIED_AT_*` wave on 119th bills as files are re-read; no action.
6. Write 120 roles if not done in Phase 1.5.

### Phase 3 — onboarding (Jan–Feb 2027), Phase 4 checklist per member (`docs/v2/plan.md:172-183`)
`in_scope` + `congresses` → sponsorship pull → show count and cost → statements and
embeddings → hand-check 5 bills, 3 test queries → `live`. Brown first (`{118,120}`),
then Jackson, then the rest in Decide 2 order. Freshmen go live with the Decide 4
state as soon as they have any 120th action; cost shown before every spend.

## What this plan does not do
- No House query support (Phase 5). The 120th House roster is maintained by the
  members workflow regardless.
- No deletion. Departed members' rows, votes, sponsorships and statements all stay.
- No 117th backfill (still the open coverage item from RECONCILIATION.md).

## Verification
- Phase 1: `npm test`; `coverage.test.ts` cases for closed/freshman/gap; picker shows
  Collins under Former after a local `left_at` fixture; funding refusal unchanged;
  eval cases 52–54 still pass.
- Phase 2: `select member_id, left_at, congresses from core.members where in_scope`;
  `ingest_runs` for the first week clean; a Collins query returns her record with the
  closed-record sentence; a Jackson query before any 120th vote returns the freshman
  sentence, never "no record on this".
