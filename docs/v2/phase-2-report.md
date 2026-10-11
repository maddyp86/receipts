# Phase 2 report: the query tool, built but not switched

Run on 11 October 2026. Both new settings keep their defaults, so **production behaviour is unchanged**: the live tool still searches Pinecone and reads `mirror`.

## What exists

| Setting | Default | Other value | What it does |
|---|---|---|---|
| `RECORD_SCHEMA` | `mirror` | `compat` | The schema every record read uses: the picker, roles, actions, roll calls, whip votes, bill progress, statements and text versions. Table names, columns and row keys are identical in both. |
| `ACTION_STORE` | `pinecone` | `supabase` | The bill search. `SupabaseActionStore` ranks one member's bills with `core.match_member_bills`. |
| `PERSIST_QUERIES` | `true` | `false` | `false` reads the record but writes nothing to `app`. Used for both eval runs below. |

An unknown value for any of the three stops the server at startup, so a typo can't silently switch the record reads off.

- **Migration 015** (`docs/supabase-migration-015-compat-views.sql`) is applied.
  - It creates schema `compat`: seven views over `core` in the mirror's exact shape. `receipts_app` and `receipts_trust` can only read them.
  - It also makes `core.match_member_bills` inlinable. A search took 460 ms because the function's own `search_path` blocked inlining; it now takes 20 to 45 ms.
- **`SupabaseActionStore`** turns each `core` row into the record WF6 writes as Pinecone metadata, then calls the Pinecone store's own converter and result builder.
  - The similarity floor, counts, near misses, vote casing, missing-field rules and score precision are therefore shared code.
  - Today's Action UIDs are kept.
- **The picker:**
  - Where the record carries `Live` (in `compat`), a member is listed only when `Live` is true.
  - `Coverage Congresses` feeds the coverage sentence.
  - With `mirror`, which has neither key, the rule is unchanged. This is folded in from `feat/live-flag-and-member-coverage`, with its tests.
- **Tools:**
  - `tools/rank-check.mts --compare` runs gate G2.
  - `tools/eval-compare.mts` compares two eval runs case by case.

## Data changes made in this phase

- **LIS IDs:** 90 blank Senate LIS IDs in `core.members` were filled from legislators-current, with your approval. Blanks were filled only; nothing was overwritten. It's recorded as `ingest_runs` #9.
  - Graham and Mullin are not in that file and stay blank.
  - Without this, `compat` had the whip's vote for only 83 of 228 roll calls. Now it matches the mirror for all 228.

## `compat` against `mirror`, key by key

For every key the tool reads, across all seven tables, `compat` holds the mirror's value except for:

| What | Cells | Why |
|---|---|---|
| The five vote corrections (Phase 1) | 2 new rows; 4 changed passage votes | Intended |
| `Progress Checked At` | 1,164 | The mirror is stale: it holds 2026-10-08, while `core` holds the sheet's current 2026-10-10 |
| `Cosponsor Total` on s1383-119 | 2 | Vote-only rows take the bill's count (2); the action rows say 8 |
| Date format only | 50 | Those few cells are ISO in the sheet; `compat` writes M/D/YYYY like the rest. Same calendar date |
| Whip vote | 0 of 228 | Same whips, same vote read, including today's last-row-wins order (see "Found on the way") |

## Gate G2: search

Run A's 49 saved query vectors against both stores, at the query path's own top 10. Each bill is compared at its best rank.

| | Result |
|---|---|
| Same bills | 48 of 49 cases |
| Same order | 32 of 49 |
| Scores equal to 3 decimals | 1 of 49 |

**Every difference is explained by one cause: Pinecone's scores are approximate.** I recomputed two scores by hand, in float64, from the identical stored vector. For example, sjres37-119 for case 4: float64 and pgvector both give 0.548790, while Pinecone reported 0.5497.

- **Size of the error:** across all 128 differing score pairs, the most Pinecone is off by is 0.0011, and the mean is 0.0004.
- **Reordering:** all 17 swapped pairs are bills whose exact scores differ by at most 0.00062, inside that error. That includes the one bill swapped at the rank-10 cutoff (case 13: s2515-118 and s587-119, both 0.481).
- **Consequence for the gate:** the "equal to three decimals" test can't be met against an approximate reference. I propose G2 be read as "same bills; any order or score difference within Pinecone's measured error". On that reading G2 passes for all 49.

**Fields that differ for the same bill, which matter for G3:**

| Bill | Cases | Field | Why |
|---|---|---|---|
| s870-118 (Schumer) | 17 | passage vote NA → YEA | One of the five Phase 1 corrections |
| s4668-119 (Thune) | 14 | passage vote NA → YEA | Pinecone's metadata predates the 29 September passage vote; `core` reads it from the roll call |
| sres732-119, sjres104-119, s5022-119, s3697-119 | 3, 11, 16, 20, 21, 22, 28, 29, 30 | stakeholders | Pinecone's metadata merges the regenerated statement's stakeholders with the superseded statement's (for example G7Q6PI with 6T2SQH). `core` holds only the current statement's |

The full per-case G2 table is at the end.

## Gate G3: end to end

`npm run eval` was run once per store, with `PERSIST_QUERIES=false`; `app` gained no rows from either run.

| Run | Settings | Pass | Cost |
|---|---|---|---|
| A | `ACTION_STORE=pinecone RECORD_SCHEMA=mirror` | 40 / 49 | $4.71 |
| B | `ACTION_STORE=supabase RECORD_SCHEMA=compat` | 40 / 49 | $4.75 |

**Same pass rate. Pass/fail matches on 47 of 49 cases**, and 28 of 49 are identical in verdict, band, count and bill readings.

**Baseline, same store twice.** The two 18-case runs on 10 October had identical pass/fail on 18 of 18 but differed in detail on 7 of 18. So detail-level differences between two runs are normal.

**How each difference was attributed:** for every case that differs, I compared the two runs' traces stage by stage, checking each step's inputs and outputs.

- **The deterministic pre-evaluator gates never produced a different output in any case.**
- Every difference first appears in a model stage: classification, relevance or the per-bill evaluator.

| Case | A → B | First difference | Cause |
|---|---|---|---|
| 11-schumer-iraq-aumf | pass → FAIL | Classification stance In Favor → Opposed | Model; runs before any store is read. The 10 October baseline shows the same flip on case 12 |
| 34-thune-border | FAIL → pass | A's explanation used a forbidden phrase | Model wording |
| 9, 12, 23 | same pass/fail | Classification differs, so the query text differs | Model |
| 13, 24, 27, 29, 30, 32, 33, 35, 36, 37, 40, 44, 45, 47 | same pass/fail | The per-bill evaluator got identical inputs and answered differently. The relevance step's inputs also differed: the classifier's key terms, and the score digits (now fixed) | Model |
| 19 | same pass/fail | Relevance differs; gate inputs differ only in classifier fields and one date format | Model; the gate output was identical |
| 3, 28 | same pass/fail | Evaluator input differs for sres732-119 only: the stale stakeholder groups | Data correction; other bills' evaluator outputs also differed on identical inputs |

**The relevance prompt prints the similarity score.** Run B printed it at full double precision (`0.559694834028099` against Pinecone's `0.559665859`). The store now rounds to Pinecone's nine significant digits, so the prompt's text keeps its shape. This change was made after run B.

On the 49 cases, **G3 passes: same pass rate, and no difference traceable to the new store** beyond the intended corrections.

## Found on the way

- **The whip-vote lookup ignores the senator's party.** The enrichment reader looks up the whip's vote by roll call alone, and there are two whips per roll call, so the last row wins. Today that's Thune in the 118th and Durbin in the 119th, whatever the senator's party. `compat` reproduces this exactly. Fixing it changes verdict inputs, so it's flagged as a separate task.
- **WF6 folds superseded stakeholders into the vector metadata.** Its de-duplication step merges stakeholder rows by bill, including rows left over from regenerated statements. This affects up to 44 bills. `core` and the Supabase store don't carry these rows.
- **Pinecone metadata goes stale on votes cast after embedding,** for example s4668-119. With `ACTION_STORE=supabase`, votes come from the roll calls every time.

## Not done in this phase

- Neither setting is changed in production. The Render environment is untouched.
- No change to prompts, checks, verdict logic or copy. The score rounding keeps a prompt line in its existing shape.

## G2 per case

| case | senator | bills | same bills | same order | scores equal (3 dp) | differences |
|---|---|---|---|---|---|---|
| 1-schumer-clean-air | S000148 | 10/10 | yes | yes | NO | scores: sjres31-119 0.5997→0.5995; hjres61-119 0.5770→0.5764; hjres35-119 0.5458→0.5454; s3738-118 0.5321→0.5315; s3833-119 0.5267→0.5261 |
| 2-schumer-student-debt | S000148 | 10/10 | yes | yes | yes | — |
| 3-schumer-abortion | S000148 | 10/10 | yes | yes | NO | scores: s4554-118 0.6499→0.6495; sres732-119 0.6157→0.6155 · fields: sres732-119: affected_stakeholders |
| 4-schumer-tariffs | S000148 | 10/10 | yes | yes | NO | scores: sjres37-119 0.5497→0.5488; sjres81-119 0.5339→0.5334; hjres39-118 0.5173→0.5175; s1741-119 0.5072→0.5076; s5390-119 0.4978→0.4972 |
| 5-thune-tariffs | T000250 | 10/10 | yes | yes | NO | scores: sjres37-119 0.5497→0.5488; sjres81-119 0.5339→0.5334; hjres39-118 0.5173→0.5175; s3543-119 0.5039→0.5033 |
| 6-schumer-wep-gpo | S000148 | 10/10 | yes | NO | NO | order: P hr82-118 s597-118 s1950-119 s3078-119 s2763-119 s4886-119 s2439-119 s4363-118 s1302-118 s1352-119 / S s597-118 hr82-118 s1950-119 s3078-119 s2763-119 s4886-119 s2439-119 s4363-118 s1302-118 s1352-119 · scores: hr82-118 0.5064→0.5066; s597-118 0.5064→0.5066; s1950-119 0.4963→0.4966; s2763-119 0.4738→0.4734 |
| 7-thune-wep-gpo | T000250 | 10/10 | yes | NO | NO | order: P hr82-118 s1569-118 s3503-118 s4258-118 sres413-119 s809-118 s2888-118 s893-118 s1942-118 s3386-119 / S hr82-118 s1569-118 s3503-118 s4258-118 sres413-119 s809-118 s2888-118 s1942-118 s893-118 s3386-119 · scores: hr82-118 0.5064→0.5066; sres413-119 0.4448→0.4441; s809-118 0.4398→0.4394; s893-118 0.4367→0.4361; s1942-118 0.4367→0.4362 |
| 8-thune-border | T000250 | 10/10 | yes | NO | NO | order: P s2824-118 s2-119 s4361-118 s3933-118 s156-118 s5-119 s1733-118 hr1-119 s160-118 s5183-118 / S s2824-118 s2-119 s4361-118 s3933-118 s156-118 s1733-118 s5-119 hr1-119 s160-118 s5183-118 · scores: s156-118 0.4648→0.4645; s5183-118 0.4385→0.4386 |
| 9-thune-stablecoins | T000250 | 10/10 | yes | yes | NO | scores: s1582-119 0.6317→0.6315; s483-118 0.5565→0.5566 |
| 10-schumer-drug-prices | S000148 | 10/10 | yes | NO | NO | order: P s4886-119 sres510-118 s3386-119 sres732-119 s3368-119 sjres197-119 sjres84-119 s1064-118 s331-119 s1302-118 / S s4886-119 sres510-118 sres732-119 s3386-119 s3368-119 sjres197-119 sjres84-119 s1064-118 s331-119 s1302-118 · scores: s3368-119 0.4861→0.4866; s1064-118 0.4620→0.4628 |
| 11-schumer-iraq-aumf | S000148 | 10/10 | yes | NO | NO | order: P s316-118 sjres200-119 sjres172-119 sjres211-119 sjres104-119 sjres191-119 sjres180-119 sjres118-119 hconres86-119 sjres114-119 / S s316-118 sjres200-119 sjres172-119 sjres211-119 sjres104-119 sjres180-119 sjres191-119 sjres118-119 hconres86-119 sjres114-119 · scores: s316-118 0.6554→0.6556; sjres200-119 0.6135→0.6135; sjres104-119 0.5896→0.5894 · fields: sjres104-119: affected_stakeholders |
| 12-thune-iraq-aumf | T000250 | 10/10 | yes | yes | NO | scores: s316-118 0.6554→0.6556; s1583-118 0.5165→0.5176 |
| 13-thune-tcja-permanent | T000250 | 10/10 | NO | NO | NO | only Pinecone: s2515-118 (0.481) · only Supabase: s587-119 (0.481) · scores: s1117-118 0.5876→0.5872; s213-119 0.5506→0.5504 |
| 14-thune-womens-sports | T000250 | 10/10 | yes | NO | NO | order: P s9-119 sres21-119 sres669-118 s4668-119 s1454-118 s4381-118 s186-118 s537-119 s1185-118 s13-118 / S s9-119 sres21-119 sres669-118 s4668-119 s4381-118 s1454-118 s186-118 s537-119 s1185-118 s13-118 · scores: sres21-119 0.5524→0.5526; s4668-119 0.5335→0.5335; s186-118 0.4757→0.4754 · fields: s4668-119: passage_vote NA→YEA |
| 15-thune-voter-id | T000250 | 10/10 | yes | yes | NO | scores: s4292-118 0.5899→0.5907; s3752-119 0.5882→0.5887 |
| 16-schumer-fentanyl-schedule-i | S000148 | 10/10 | yes | yes | NO | scores: s4361-118 0.5472→0.5480; s4226-118 0.5142→0.5147; sres165-118 0.4653→0.4657; sres21-118 0.4594→0.4603 · fields: s5022-119: affected_stakeholders |
| 17-schumer-reca-radiation | S000148 | 10/10 | yes | NO | NO | order: P s3853-118 s2439-119 s1302-118 sres93-119 sres467-119 s3386-119 s2534-119 s870-118 s1664-118 s3869-119 / S s3853-118 s2439-119 s1302-118 sres93-119 sres467-119 s3386-119 s2534-119 s870-118 s3869-119 s1664-118 · scores: s1664-118 0.5279→0.5274; s3869-119 0.5275→0.5275 · fields: s870-118: passage_vote NA→YEA |
| 18-schumer-veterans-vague | S000148 | 10/10 | yes | NO | NO | order: P s1441-119 s3174-119 s1383-119 s326-118 s2534-119 sjres103-119 sres42-119 s3131-119 sres20-119 s1515-118 / S s1441-119 s3174-119 s1383-119 s326-118 s2534-119 sjres103-119 sres42-119 s3131-119 s1515-118 sres20-119 · scores: sres42-119 0.4714→0.4718 |
| 19-thune-photo-id-example | T000250 | 10/10 | yes | NO | NO | order: P s5271-119 s128-119 s3752-119 s4292-118 s3470-118 s1398-118 s3659-118 sconres2-119 s156-118 s909-118 / S s5271-119 s128-119 s4292-118 s3752-119 s3470-118 s1398-118 s3659-118 sconres2-119 s156-118 s909-118 · scores: s1398-118 0.4849→0.4843; s3659-118 0.4594→0.4598; s156-118 0.4439→0.4435 |
| 20-schumer-fentanyl-example | S000148 | 10/10 | yes | yes | NO | scores: s331-119 0.6990→0.6996; s4361-118 0.5374→0.5379 · fields: s5022-119: affected_stakeholders |
| 21-schumer-abortion-access-question | S000148 | 10/10 | yes | NO | NO | order: P s701-118 s1999-118 sres732-119 s2150-119 s4554-118 sres828-118 sres510-118 s4381-118 s5108-119 s6-119 / S s701-118 s1999-118 sres732-119 s2150-119 sres828-118 s4554-118 sres510-118 s4381-118 s5108-119 s6-119 · scores: s1999-118 0.6187→0.6185 · fields: sres732-119: affected_stakeholders |
| 22-thune-15-weeks-question | T000250 | 10/10 | yes | yes | NO | scores: s186-119 0.6082→0.6086 · fields: s3697-119: affected_stakeholders |
| 23-schumer-va-health-care-question | S000148 | 10/10 | yes | yes | NO | scores: s3174-119 0.5562→0.5566; s1515-118 0.5404→0.5408; hr3944-119 0.5344→0.5346; hr4366-118 0.5253→0.5256 |
| 24-schumer-veterans-disability-pay-question | S000148 | 10/10 | yes | NO | NO | order: P s1515-118 s344-118 s1032-119 s2534-119 s3174-119 s1441-119 hr3944-119 s2757-118 hr5009-118 s2226-118 / S s1515-118 s344-118 s1032-119 s3174-119 s2534-119 s1441-119 hr3944-119 s2757-118 hr5009-118 s2226-118 · scores: s2757-118 0.5547→0.5543; s2226-118 0.5405→0.5404 |
| 25-thune-tcja-question | T000250 | 10/10 | yes | yes | NO | scores: hr1-119 0.5374→0.5376; s772-119 0.5144→0.5148 |
| 26-schumer-topic-aca-tax-credits | S000148 | 10/10 | yes | NO | NO | order: P s3385-119 s3368-119 s5619-119 s3386-119 s46-119 s2556-119 s2882-119 sjres197-119 s5194-118 hr1-119 / S s3368-119 s3385-119 s5619-119 s3386-119 s46-119 s2556-119 s2882-119 s5194-118 sjres197-119 hr1-119 · scores: s5619-119 0.5718→0.5714 |
| 27-schumer-topic-medicaid-cuts | S000148 | 10/10 | yes | yes | NO | scores: s3386-119 0.5886→0.5882 |
| 28-schumer-topic-protect-access-to-abortion | S000148 | 10/10 | yes | NO | NO | order: P s701-118 s1999-118 sres732-119 s2150-119 s4554-118 sres828-118 sres510-118 s4381-118 s5108-119 s6-119 / S s701-118 s1999-118 sres732-119 s2150-119 sres828-118 s4554-118 sres510-118 s4381-118 s5108-119 s6-119 · scores: s4554-118 0.6157→0.6153; sres828-118 0.6154→0.6159; sres510-118 0.6105→0.6105; s4381-118 0.6047→0.6044 · fields: sres732-119: affected_stakeholders |
| 29-thune-topic-restricting-abortion | T000250 | 10/10 | yes | yes | NO | scores: s13-118 0.6334→0.6335; s3624-118 0.6214→0.6217 · fields: s3697-119: affected_stakeholders |
| 30-thune-topic-oppose-federal-funding-for-abortion | T000250 | 10/10 | yes | yes | NO | scores: s3624-118 0.6322→0.6326 · fields: s3697-119: affected_stakeholders |
| 31-schumer-topic-expand-background-checks-for-gun-sales | S000148 | 10/10 | yes | yes | NO | scores: s3214-119 0.6575→0.6573; s494-118 0.6515→0.6514; s1955-119 0.5697→0.5691; s173-118 0.5527→0.5521; s2514-119 0.5526→0.5521 |
| 32-thune-topic-the-right-to-carry-a-concealed-firearm-a | T000250 | 10/10 | yes | yes | NO | scores: s65-119 0.6307→0.6305; s4652-118 0.5561→0.5566; s1569-118 0.5087→0.5082 |
| 33-schumer-topic-ban-assault-weapons | S000148 | 10/10 | yes | NO | NO | order: P s25-118 s1531-119 s3214-119 s494-118 s2048-118 hjres44-118 s726-119 s1955-119 s173-118 s1026-118 / S s25-118 s1531-119 s3214-119 s494-118 hjres44-118 s2048-118 s726-119 s1955-119 s173-118 s1026-118 · scores: s25-118 0.6389→0.6395; s1531-119 0.6283→0.6290; s3214-119 0.5755→0.5758; hjres44-118 0.5583→0.5590 |
| 34-thune-topic-secure-the-border-and-stop-illegal-immig | T000250 | 10/10 | yes | NO | NO | order: P s2824-118 s2-119 hr1-119 s4361-118 s156-118 s5183-118 hr1968-119 s1733-118 s348-118 s160-118 / S s2824-118 s2-119 hr1-119 s4361-118 s156-118 s5183-118 hr1968-119 s1733-118 s160-118 s348-118 · scores: s2824-118 0.5646→0.5643; s156-118 0.4740→0.4734; hr1968-119 0.4358→0.4352; s1733-118 0.4334→0.4338 |
| 35-thune-topic-laken-riley-act | T000250 | 10/10 | yes | yes | NO | scores: s156-118 0.5579→0.5571 |
| 36-thune-topic-extend-the-2017-tax-cuts | T000250 | 10/10 | yes | yes | NO | scores: hr7024-118 0.5957→0.5953; s772-119 0.5232→0.5238 |
| 37-schumer-topic-making-large-corporations-pay-more-in-ta | S000148 | 10/10 | yes | yes | NO | scores: s4796-119 0.5502→0.5508; s234-118 0.4933→0.4936; s4298-119 0.4889→0.4881; hr1-119 0.4794→0.4795 |
| 38-schumer-topic-expand-the-child-tax-credit | S000148 | 10/10 | yes | yes | NO | scores: hr7024-118 0.6218→0.6214; s1421-119 0.6188→0.6196; s1992-118 0.6146→0.6145; s3716-118 0.5814→0.5816 |
| 39-schumer-topic-debt-limit | S000148 | 10/10 | yes | yes | NO | scores: hr1968-119 0.5277→0.5274 |
| 40-schumer-topic-ending-tariffs-on-imported-goods | S000148 | 10/10 | yes | yes | NO | scores: s2383-119 0.5636→0.5627 |
| 41-thune-topic-clear-rules-for-stablecoins-and-crypto | T000250 | 10/10 | yes | NO | NO | order: P s1582-119 hr3633-119 s483-118 s2201-118 s3312-118 hjres109-118 sjres28-119 s3758-118 s734-118 hjres25-119 / S s1582-119 hr3633-119 s483-118 s2201-118 s3312-118 hjres109-118 sjres28-119 s3758-118 hjres25-119 s734-118 · scores: s2201-118 0.4913→0.4918; s734-118 0.4725→0.4723 |
| 42-schumer-topic-protect-clean-air-standards-from-rollbac | S000148 | 10/10 | yes | yes | NO | scores: hjres61-119 0.5828→0.5824; hjres89-119 0.5517→0.5515 |
| 44-schumer-topic-expand-clean-energy-tax-credits | S000148 | 10/10 | yes | yes | NO | scores: s234-118 0.4952→0.4956; hr9340-119 0.4934→0.4937; hr1-119 0.4754→0.4755 |
| 45-schumer-topic-canceling-student-debt | S000148 | 10/10 | yes | yes | NO | scores: s441-118 0.4905→0.4909; s3753-119 0.4685→0.4688 |
| 46-schumer-topic-expand-pell-grants | S000148 | 10/10 | yes | yes | NO | scores: hjres45-118 0.5335→0.5335; sjres43-118 0.5226→0.5222; s2344-118 0.5188→0.5180; s1024-118 0.5034→0.5036; s441-118 0.5014→0.5017 |
| 47-schumer-topic-protect-social-security-benefits-from-cu | S000148 | 10/10 | yes | yes | NO | scores: s1950-119 0.5232→0.5236; s597-118 0.5159→0.5169; s2344-118 0.4815→0.4812 |
| 48-schumer-topic-end-the-penalties-that-cut-social-securi | S000148 | 10/10 | yes | yes | NO | scores: s2763-119 0.4976→0.4973; s2344-118 0.4818→0.4811 |
| 49-thune-topic-requiring-photo-id-to-vote | T000250 | 10/10 | yes | yes | NO | scores: s4292-118 0.5754→0.5763; s3752-119 0.5675→0.5680; s3659-118 0.4542→0.4552; s156-118 0.4524→0.4529; sres471-118 0.4392→0.4397 |
| 50-schumer-topic-making-election-day-a-federal-holiday | S000148 | 10/10 | yes | yes | NO | scores: sres744-118 0.5195→0.5193 |

## G3 per case

A: `.data/eval/2026-10-11T01-34-39-621Z.json` · B: `.data/eval/2026-10-11T02-11-38-708Z.json`. Classification wording is shortened.

| case | A | B | verdict A | verdict B | band A → B | what differed |
|---|---|---|---|---|---|---|
| 1-schumer-clean-air | FAIL | FAIL | KEPT | KEPT | Low → Low | — |
| 2-schumer-student-debt | pass | pass | KEPT | KEPT | Medium → Medium | — |
| 3-schumer-abortion | FAIL | FAIL | KEPT | KEPT | High → High | count: "We found 5 actions by Schumer related to this statement. 2 are consistent with it and 3 don't count either way." → "We found 7 actions by Schumer related to this statement. 2 are consistent with it and 5 don't count either way." |
| 4-schumer-tariffs | pass | pass | KEPT | KEPT | Low → Low | — |
| 5-thune-tariffs | pass | pass | NOT_DETERMINABLE · WITHHELD_PENDING_REVIEW · judge REVIEW_REQUIRED_JUDGE_CORRECTED | NOT_DETERMINABLE · WITHHELD_PENDING_REVIEW · judge REVIEW_REQUIRED_JUDGE_CORRECTED | — → — | — |
| 6-schumer-wep-gpo | pass | pass | KEPT | KEPT | Medium → Medium | — |
| 7-thune-wep-gpo | pass | pass | BROKE · judge PASS | BROKE · judge PASS | Low → Low | — |
| 8-thune-border | FAIL | FAIL | KEPT | KEPT | Medium → Medium | — |
| 9-thune-stablecoins | pass | pass | KEPT | KEPT | Medium → Medium | classification: Technology / Data Privacy & Cybersecurity · In Favor → Technology / Technology & Communication · In Favor) · count: "We found 3 actions by Thune related to this statement. 2 are consistent with it and 1 doesn't count either way." → "We found 2 actions by Thune related to this statement. Both are consistent with it." |
| 10-schumer-drug-prices | pass | pass | NOT_DETERMINABLE · NO_MATCHES | NOT_DETERMINABLE · NO_MATCHES | — → — | — |
| 11-schumer-iraq-aumf | pass | FAIL | KEPT | NOT_DETERMINABLE · WITHHELD_TEXT_UNAVAILABLE | Low → — | classification: Foreign Policy & Defense / War & Peace / Military Action · In Favor → Foreign Policy & Defense / War & Peace / Military Action · Opposed) · count: "We found 1 action by Schumer related to this statement. That action is consistent with it." → "—" · s316-118: consistent (CONSISTENT) → runs_counter (INCONSISTENT) |
| 12-thune-iraq-aumf | FAIL | FAIL | NOT_DETERMINABLE · WITHHELD_TEXT_UNAVAILABLE | KEPT | — → Low | classification: Foreign Policy & Defense / War & Peace / Military Action · In Favor → Foreign Policy & Defense / War & Peace / Military Action · Opposed) · count: "—" → "We found 2 actions by Thune related to this statement. 1 is consistent with it and 1 doesn't count either way." · s316-118: runs_counter (INCONSISTENT) → consistent (CONSISTENT) |
| 13-thune-tcja-permanent | pass | pass | KEPT | KEPT | Medium → Low | count: "We found 4 actions by Thune related to this statement. 2 are consistent with it and 2 don't count either way." → "We found 3 actions by Thune related to this statement. 1 is consistent with it and 2 don't count either way." |
| 14-thune-womens-sports | pass | pass | KEPT | KEPT | Low → Low | — |
| 15-thune-voter-id | FAIL | FAIL | KEPT | KEPT | Medium → Medium | — |
| 16-schumer-fentanyl-schedule-i | pass | pass | KEPT | KEPT | Medium → Medium | — |
| 17-schumer-reca-radiation | pass | pass | KEPT | KEPT | Low → Low | — |
| 18-schumer-veterans-vague | pass | pass | NOT_DETERMINABLE · NOT_EVALUABLE | NOT_DETERMINABLE · NOT_EVALUABLE | — → — | — |
| 19-thune-photo-id-example | pass | pass | KEPT | KEPT | Medium → Medium | count: "We found 2 actions by Thune related to this statement. 1 is consistent with it and 1 doesn't count either way." → "We found 1 action by Thune related to this statement. That action is consistent with it." |
| 20-schumer-fentanyl-example | pass | pass | KEPT | KEPT | Medium → Medium | — |
| 21-schumer-abortion-access-question | pass | pass | KEPT | KEPT | Medium → Medium | — |
| 22-thune-15-weeks-question | FAIL | FAIL | NOT_DETERMINABLE · NO_MATCHES | NOT_DETERMINABLE · NO_MATCHES | — → — | — |
| 23-schumer-va-health-care-question | FAIL | FAIL | NOT_DETERMINABLE · ALL_NEUTRAL | NOT_DETERMINABLE · ALL_NEUTRAL | — → — | classification: Foreign Policy & Defense / Military Personnel / Veterans · In Favor → Health Care / Health Workforce & Provider Capacity · In Favor) |
| 24-schumer-veterans-disability-pay-question | pass | pass | KEPT | KEPT | Medium → Medium | count: "We found 4 actions by Schumer related to this statement. 2 are consistent with it and 2 don't count either way." → "We found 3 actions by Schumer related to this statement. All 3 are consistent with it." |
| 25-thune-tcja-question | pass | pass | KEPT | KEPT | Low → Low | — |
| 26-schumer-topic-aca-tax-credits | pass | pass | KEPT (mixed) | KEPT (mixed) | Medium → Medium | — |
| 27-schumer-topic-medicaid-cuts | pass | pass | KEPT | KEPT | Low → Low | count: "We found 2 actions by Schumer related to this statement. 1 is consistent with it and 1 doesn't count either way. 1 more was found but set aside — see “Found, but not evaluated”." → "We found 1 action by Schumer related to this statement. That action is consistent with it. 1 more was found but set aside — see “Found, but not evaluated”." |
| 28-schumer-topic-protect-access-to-abortion | pass | pass | KEPT | KEPT | Medium → Medium | classification: Abortion / Abortion · In Favor → Abortion / Abortion · In Favor) · count: "We found 8 actions by Schumer related to this statement. 5 are consistent with it and 3 don't count either way." → "We found 7 actions by Schumer related to this statement. 5 are consistent with it and 2 don't count either way." |
| 29-thune-topic-restricting-abortion | FAIL | FAIL | NOT_DETERMINABLE · WITHHELD_PENDING_REVIEW · judge REVIEW_REQUIRED_JUDGE_CORRECTED | NOT_DETERMINABLE · NOT_EVALUABLE | — → — | classification: Abortion / Abortion · Opposed) → Abortion / Abortion · Opposed) |
| 30-thune-topic-oppose-federal-funding-for-abortion | pass | pass | KEPT | KEPT | Medium → High | count: "We found 7 actions by Thune related to this statement. 5 are consistent with it and 2 don't count either way." → "We found 8 actions by Thune related to this statement. All 8 are consistent with it." |
| 31-schumer-topic-expand-background-checks-for-gun-sales | pass | pass | KEPT | KEPT | High → High | — |
| 32-thune-topic-the-right-to-carry-a-concealed-firearm-a | pass | pass | KEPT | KEPT | Medium → Medium | classification: Crime & Public Safety / Guns / Gun Control · In Favor) → Crime & Public Safety / Guns / Gun Control · In Favor · count: "We found 3 actions by Thune related to this statement. 2 are consistent with it and 1 doesn't count either way." → "We found 2 actions by Thune related to this statement. Both are consistent with it." |
| 33-schumer-topic-ban-assault-weapons | pass | pass | KEPT | KEPT | Medium → Medium | count: "We found 3 actions by Schumer related to this statement. 2 are consistent with it and 1 doesn't count either way." → "We found 2 actions by Schumer related to this statement. Both are consistent with it." |
| 34-thune-topic-secure-the-border-and-stop-illegal-immig | FAIL | pass | KEPT | KEPT | Medium → Medium | — |
| 35-thune-topic-laken-riley-act | pass | pass | KEPT | KEPT | Medium → Medium | classification: Immigration / Immigration Enforcement & Removal · In Favor) → Immigration / Immigration Enforcement & Removal · In Favor · count: "We found 4 actions by Thune related to this statement. 3 are consistent with it and 1 doesn't count either way." → "We found 7 actions by Thune related to this statement. 4 are consistent with it and 3 don't count either way." |
| 36-thune-topic-extend-the-2017-tax-cuts | pass | pass | KEPT | KEPT | Low → Medium | count: "We found 2 actions by Thune related to this statement. 1 is consistent with it and 1 doesn't count either way." → "We found 2 actions by Thune related to this statement. Both are consistent with it." |
| 37-schumer-topic-making-large-corporations-pay-more-in-ta | pass | pass | KEPT | KEPT | Medium → Low | count: "We found 2 actions by Schumer related to this statement. Both are consistent with it." → "We found 2 actions by Schumer related to this statement. 1 is consistent with it and 1 doesn't count either way." |
| 38-schumer-topic-expand-the-child-tax-credit | pass | pass | KEPT (mixed) | KEPT (mixed) | Medium → Medium | — |
| 39-schumer-topic-debt-limit | pass | pass | KEPT | KEPT | Medium → Medium | — |
| 40-schumer-topic-ending-tariffs-on-imported-goods | pass | pass | KEPT | KEPT | Low → Low | count: "We found 8 actions by Schumer related to this statement. 6 are consistent with it and 2 don't count either way." → "We found 8 actions by Schumer related to this statement. 4 are consistent with it and 4 don't count either way." |
| 41-thune-topic-clear-rules-for-stablecoins-and-crypto | pass | pass | KEPT | KEPT | Medium → Medium | — |
| 42-schumer-topic-protect-clean-air-standards-from-rollbac | pass | pass | KEPT | KEPT | Low → Low | — |
| 44-schumer-topic-expand-clean-energy-tax-credits | pass | pass | KEPT | KEPT | Medium → Low | count: "We found 2 actions by Schumer related to this statement. Both are consistent with it." → "We found 2 actions by Schumer related to this statement. 1 is consistent with it and 1 doesn't count either way." |
| 45-schumer-topic-canceling-student-debt | pass | pass | KEPT | KEPT | Low → Low | count: "We found 2 actions by Schumer related to this statement. 1 is consistent with it and 1 doesn't count either way." → "We found 1 action by Schumer related to this statement. That action is consistent with it." |
| 46-schumer-topic-expand-pell-grants | pass | pass | KEPT | KEPT | Low → Low | — |
| 47-schumer-topic-protect-social-security-benefits-from-cu | pass | pass | KEPT | KEPT | Medium → Medium | classification: Social Security & Entitlements / Senior Citizens · In Favor → Social Security & Entitlements / Senior Citizens · In Favor) |
| 48-schumer-topic-end-the-penalties-that-cut-social-securi | pass | pass | KEPT | KEPT | Medium → Medium | — |
| 49-thune-topic-requiring-photo-id-to-vote | pass | pass | KEPT | KEPT | Low → Low | — |
| 50-schumer-topic-making-election-day-a-federal-holiday | pass | pass | KEPT | KEPT | Medium → Medium | — |
