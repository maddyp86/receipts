# Receipts — combined thread handoff

Written 2026-09-07, merging both lanes. Supersedes the two lane context docs
for the purpose of *starting*; they remain the detail behind it.

- `docs/specs/v7-port-thread-context.md` — application logic lane
- `docs/specs/schema-diagnostics-thread-context.md` — schema/diagnostics lane
- `docs/RECONCILIATION.md` — **the durable record.** Read before trusting either.

---

## Three corrections to carry into the merge

The v7 lane's handoff draft contains three claims that were true when written
and are not now. They are listed first because two of them would send a new
thread somewhere pointless on its first move.

### 1. Retrieval was never broken — do not make it the top priority

The draft says: *"If retrieval is still unfixed — that outranks everything. The
full evaluation chain is in place and correct but adjudicates an empty evidence
set: 10 candidates, best 0.494 against a 0.50 floor."*

**There is no retrieval bug.** The query that produced those numbers was
reaching for the Inflation Reduction Act (`hr5376`), which is **117th Congress**.
Collection starts at the **118th**. The corpus does not contain the bill, so
`NOT_DETERMINABLE / NO_MATCHES` was the correct answer and the low scores were
ten unrelated healthcare bills, correctly ranked and correctly rejected.

The disconfirming evidence existed before that guidance was written: a Medicare
query on the same namespace, embedder and run returned `KEPT` with an admitted
match. A systematic vector-space offset cannot depress one query and spare
another. I read that as a success rather than as a test result, and sent the
other lane after the vector space on the strength of it — that misdirection is
mine, and the draft is repeating it in good faith.

Also: the draft points at a memory file for *"the one candidate I ruled out and
the discriminating test."* **That memory file has been deleted** — it asserted
retrieval as the live blocker and prescribed a re-embed test for a defect that
does not exist. It is replaced by `receipts-corpus-starts-at-118th-congress`.

**What is real, and is the same evidence seen correctly:** the corpus boundary
is a product problem, not a retrieval one. See "Coverage" below.

### 2. `14_claude_code_handoff_v2.md` is not missing

The draft asks you to bring it. It was on the Desktop; it is now checked in at
[`docs/fix/14_claude_code_handoff_v2.md`](../fix/14_claude_code_handoff_v2.md),
291 lines, alongside `fix/00`–`fix/12`. Nothing to carry.

### 3. `mirror_roll_call_votes` does have a natural key

The draft says it has none and asks for `UNIQUE (vote_id)`. It has carried
`UNIQUE (vote_id, politician_id)` since the base schema
(`supabase-schema.sql:242`). The reload symptom is real; the cause is that a
composite UNIQUE does not dedupe when a member is NULL — two rows with the same
`vote_id` and NULL `politician_id` do not conflict, so the constraint silently
never fires.

`UNIQUE (vote_id)` is still the right fix, and 220 rows / 220 distinct vote_ids
says the grain is one row per roll call. Migration
[008](../supabase-migration-008-roll-call-vote-key.sql) is written with a
diagnostic STEP 1 to confirm the nulls first — this lane has no local database
credential and could not check.

**The constraint alone changes nothing.** The n8n node must target it. If it
still plain-inserts, 008 converts a silent reload into a loud duplicate-key
failure every run.

---

## Where the build actually stands

**The evaluation chain is complete and correct.** Scope classifier, pre-evaluator
gates, evaluator v7, deterministic judge gates, the LLM judge, withholding,
persistence, and the audit log all exist, are ported from live nodes, and are
tested. This is not a half-built system.

**The gap is that a user cannot see most of it.** Gated rows, their reasons, the
judge disposition, split-vote disclosure and the coverage boundary are all
computed, persisted, and reported to the model — and invisible on screen. That
makes the web layer the highest-value work, and it is the v7 lane's.

**Migrations 002–007 are applied.** 008 is written and not run.

---

## Coverage — the sharpest live risk

> "We didn't find any bills or votes in this senator's analyzed record."

True, and a reader hears *"he has no record on drug pricing"* — about a senator
who passed the IRA.

This is the mirror of the false-accusation class and **the less protected of the
two**. An accusation must clear a 0.7 confidence floor, carry a counterargument,
and survive an adversarial judge. An absence gets a clean sentence and no
scrutiny at all.

`scoring/coverage.ts` derives the observed window from the retrieved candidates
and writes a sentence that describes the *search*, never the senator, and
actively denies the inference. **It does not render yet.** `ND_REASON_COPY.NO_MATCHES`
is a one-line change and it is the highest-leverage line in the UI.

The durable fix is data, not copy: **add the 117th Congress.** It holds the IRA
and the 2022 campaign cycle. WF6 already accepts `target_congress`; the cost is
bill data plus impact statements, not a rebuild. Deciding whether to go further
back is one query — `min(Promise Date)` on Evaluable Statements.

---

## Open items

Ordered as I would take them. Lane in brackets.

| | Item |
|---|---|
| 1 | **[web]** Render what the evaluation layer computes — gated rows and reasons, judge disposition, `vote_governing` / `vote_flags`. `fix/08` calls gated items "the thing that makes the tool look honest" |
| 2 | **[web]** `ND_REASON_COPY.NO_MATCHES` — render the coverage sentence. One line, highest leverage |
| 3 | **[pipeline]** Remove the two corpus verdict tables from the n8n sync set — 007 is applied but is undone by the next run |
| 4 | **[pipeline]** Activate the mirror sync (`tGcHOxabA29Tjob2`, 8 tables, ~7,900 rows, Tue/Fri 06:00). **Check the schedule trigger is enabled** — it has come back disabled twice, and a disabled trigger silently never fires |
| 5 | **[pipeline]** Add the 117th Congress to collection |
| 6 | **[pipeline]** `min(Promise Date)` on Evaluable Statements — a number, not a judgement call |
| 7 | **[schema]** Run migration 008 STEP 1, then STEP 2, then change the n8n node in the same sitting |
| 8 | **[web]** Exercise the halt UI in a browser — never done. Demo mode skips scope classification, so it needs an `ANTHROPIC_API_KEY` to trigger |
| 9 | **[app]** `decisionScore.ts` is **stale and dormant** — `Compute Decision Score` is 25,077 chars against a port reconciled at 20,803. Called only by its own test. **Re-reconcile before anything wires it in** |
| 10 | **[app]** Rate limiting — spec written, not wired. Wanted before the frontend is public |
| 11 | **[app]** `match_direction` is hardcoded `'promise_to_bill'` — make it a named constant so the trace is honest about the tool being one-directional by design |
| 12 | **[product]** PostHog wiring, and the privacy-policy line before the first public query |

**Warm-ups, both verified safe:**

- Delete `packages/server/src/evaluation/gates.ts` — confirmed zero call sites. It carries a spec correction (WF10A applies **two** gates, not three), but that finding is already preserved at `RECONCILIATION.md:132`, so nothing is lost.
- Scrub the three Sheets document IDs from `docs/fix/09`. For accuracy: **the repo is private**, so this is consistency with `data/sheets.ts` (which scrubs its own on the grounds that a doc id is an access identifier), not an exposure incident.

**Not in scope, decided:** WF8 / bill→promise. The query tool answers "does this
senator's record bear on this statement", which is inherently promise→bill.

---

## Decisions made — please don't re-litigate

Reasoning is in the two context docs.

- `JUDGE_ERROR` withholds rather than publishes; no judge credential also withholds
- One judge pass, retry invariant live behind a disabled flag
- Prompts are generated `.ts` with asserted lengths, not `prompts/*.txt`
- Known-bad impacts are flagged, not suppressed
- G3 was ported verbatim rather than relaxed
- `alignment_confidence` stays numeric; the `NOT_EVALUATED` marker gets its own
  column. A marker replaced by a value from the column's own vocabulary is a
  fabricated finding
- The audit log is append-only **by privilege**, not by convention. A correction
  is a new event with a later `seq`
- Contract 3 uses the **best** breaking action, not the average; null confidence
  fails closed; evidence still renders when the conclusion is withheld

---

## Working practices that earned their place

**The live node wins — and the node includes its prompts.** Six of seven
corrections in `RECONCILIATION.md` came from reading node code. The seventh — a
−0.1 confidence penalty that two people independently "verified absent" — was
invisible to that method, because the node is an `openAi` node whose logic is
prose in `parameters.responses.values[0]`. I removed a *true* claim from the
codebase on the strength of the wrong check. For an LLM node, the prompt **is**
the implementation. Dump the whole node JSON, not the code field.

**Assert lengths, don't eyeball them.** Relevance 13,740; fulfillment v6 32,507;
evaluator v7 9,343.

**Verify the change fired.** A DEMO-mode confidence fix typechecked clean, read
as complete, and did nothing — `dispatch` dropped the value downstream. Caught
only by running a query and reading `conf=None`.

**A schema change is inert until the pipeline moves with it.** 007 and 008 both
have this shape. Land both halves in one sitting or neither.

**Log disagreements, don't fix them silently** — into `RECONCILIATION.md`,
appended, never edited away, so a wrong finding stays visible beside its
correction.

---

## Paste-ready opener

```
Continuing the Receipts build — new phase, single thread now (the two lanes
have merged).

Read first, in order:
  docs/specs/START_HERE_next_thread.md    — combined handoff; start here
  docs/RECONCILIATION.md                  — the durable record
  docs/fix/08_query_tool_pipeline.md      — the response shape the UI owes
  docs/fix/14_claude_code_handoff_v2.md   — the authoritative spec for this work

Two lane context docs sit behind those and hold the detail:
docs/specs/v7-port-thread-context.md and
docs/specs/schema-diagnostics-thread-context.md.

Standing rules: n8n is read-only — report and propose, I apply. Never fork
WF10A/WF11 scoring; port-reconcile only. The live node always wins over the
specs, and "the live node" includes its prompts, not just its jsCode. Log every
node-vs-spec disagreement in RECONCILIATION.md rather than fixing it silently.
Commit per completed task. Flag the moment you need a credential — do not stub
something that pretends to be live.

Note before you plan: retrieval is NOT broken. An earlier handoff says it is —
that was a previous thread's misdiagnosis, corrected at the top of START_HERE.
Don't spend the first hour there.

This phase: <SCOPE>

Give me a plan before writing code.
```

**Suggested `<SCOPE>`** — items 1 and 2 above, together:

```
Render what the evaluation layer already computes. Gated rows, their reasons,
and the judge disposition are persisted and reported to the model but invisible
to a user; fix/08 calls gated items "the thing that makes the tool look honest",
and §4's disclosure fields (vote_governing, vote_flags) exist precisely so a
split vote is shown rather than hidden. Include ND_REASON_COPY.NO_MATCHES so the
coverage sentence renders — a false absence is currently the least protected
output the tool has. The halt UI has never been exercised in a browser; demo
mode skips scope classification, so triggering it needs an ANTHROPIC_API_KEY.
```
