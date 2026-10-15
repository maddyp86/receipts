# Members: daily run, congress.gov cross-check, membership alert

15 Oct 2026. Nothing here is published to n8n or written to the database yet.

## What changes

- **Source of record is unchanged.** core.members is still refreshed from
  unitedstates/congress-legislators (current and historical). congress.gov is
  read only to compare; nothing from it is written to core.members.
- **Daily.** The orchestrator (7QF697TzBBToCLMg) calls the members workflow on
  every run, not only on Mondays. The `Monday?` node and the `members_day`
  Config field are gone. The members workflow is renamed
  `v2 Pipeline: members (daily)`.
- **Cross-check.** The members workflow (Ruy16Yem9fYBSnMt) gets three new
  nodes before Build Members: `Read Members` (core.members), `Read Last Report`
  (the last membership report in core.ingest_runs) and
  `Fetch congress.gov Members` (`GET /v3/member?currentMember=true`, 250 a page,
  following `pagination.next`, with the `US Gov` credential the sponsorships
  workflow already uses). The two sources are compared on bioguide id,
  chamber, state, district and party, after evening out their formats: state
  name to its USPS code, Democratic to Democrat, and an at-large seat (0 or
  blank) to 0.
- **Report.** Every run's ingest_runs counts gain `arrived`, `left`,
  `disagreements` (the counts) and `membership`:
  - `arrived`: serving in legislators-current, not serving in core.members
    (new, or `returning`)
  - `left`: serving in core.members, gone from legislators-current
  - `disagreements`: `{member_id, name, field, legislators, congress_gov,
    first_seen, days, in_scope, alerted_at}`. `field` is chamber, state,
    district, party or `serving` (in one list only). `first_seen` carries over
    from the last ok members run while the values stay the same.
- **Alert.** A write run emails Matt through the alert workflow
  (mRReCVsl8NW9mWCU), which gains a second entry point, `When Called with a
  Notice` → `Email Notice`. It emails when
  - an arrival or departure touches an in_scope member, or
  - a disagreement touches an in_scope member, or
  - a disagreement has lasted `disagree_days` days (Config, default **3**).

  Each item alerts once. `alerted_at` is recorded in the counts, so the next
  run does not repeat it. A dry run sends nothing.
- **If congress.gov fails** (error, or fewer than 500 members), the refresh is
  still written. Nothing is compared, the run records the error and then fails
  as it does today, so the usual failure email goes out.
- in_scope, live and the congresses collected are never touched. The former
  member rows are unchanged from #86. No lookups happen at query time.

## Proposed N: 3 days

Both sources normally catch up within a day of a swearing-in, resignation or
party switch. congress-legislators is edited by volunteers and is sometimes
a day or two behind; congress.gov updates daily. With N = 1 or 2, ordinary lag
would send an email that clears itself the next day. With 3, a stale source is
still caught the same week. A change to an in_scope member skips the wait and
alerts on the first run that sees it. To change N, set `disagree_days` in the
members Config, or pass it from the orchestrator.

## Dry-run preview, 15 Oct 2026

`node docs/v2/pipeline/oneoff/members_crosscheck_dryrun.cjs` runs the real
`js/helpers.js` + `js/members.js` against today's sources and core.members.
It reads only (DEMO_KEY for congress.gov, a READ ONLY transaction for the
database):

```
legislators_current 539   congress_gov 539   core_members 566 (539 serving)
arrived 0   left 0   disagreements 0   alert none   errors none
```

The two sources agree today on every current member's id, chamber, state,
district and party. The newest member, Aisha Wahab (W000832, CA-14, sworn in
2026), is in both lists and is already in core.members.

Also checked with altered copies of the data (in a scratch copy, not committed):
Schumer's party changed on congress.gov, one member dropped from congress.gov,
Wahab's district changed, and an in-scope row in core missing from
legislators-current.
- Day 0: alerts on the in-scope departure and the Schumer party disagreement.
  The other two are recorded but do not alert.
- Day 1: no alert.
- Day 3: alerts on the two disagreements that are now 3 days old.
- Day 4: no alert. `first_seen` stays 2026-10-15 throughout.

## Rollout (needs Matt's yes for each step that publishes or writes)

1. Merge this PR.
2. `python3 docs/v2/pipeline/build.py alert` and update + publish
   **v2 Pipeline: failure alert** (mRReCVsl8NW9mWCU). Check its settings let
   it be called by workflows in the same project ("This workflow can be
   called by").
3. `python3 docs/v2/pipeline/build.py members` and update + publish
   **v2 Pipeline: members** (Ruy16Yem9fYBSnMt). Confirm `Fetch congress.gov
   Members` picked up the `US Gov` credential and the error workflow is still
   the alert workflow.
4. Run the members workflow by hand (dry_run defaults to true) and check that
   the Result's `membership` matches the preview above.
5. `python3 docs/v2/pipeline/build.py orchestrator` and update + publish the
   **orchestrator** (7QF697TzBBToCLMg). The next 07:00 Pacific run writes the
   first membership report (no alert is expected today).
6. Optional, one time: test the email path by running the alert workflow's
   notice entry point with a test subject.

Rollback: restore the previous versions of the three workflows in n8n. There
is no schema change, and the new counts keys are additive.
