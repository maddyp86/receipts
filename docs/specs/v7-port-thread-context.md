# v7 port thread — context

**2026-09-07.** Companion to `query-tool-thread-context.md`. That doc covers the
query tool's original build; this one covers porting the WF10a/WF13 fixes into
it after the audit found 78 of 79 BROKE verdicts were false positives.

Sources are checked into `docs/fix/` so every provenance comment resolves to a
real file. `14_claude_code_handoff_v2.md` is the authoritative spec and is **not**
checked in — its path was gone before it could be copied. Worth adding.

---

## What this thread was for

The n8n pipeline was fixed; the query tool ran the same evaluation on
user-typed statements and had none of the fixes. The job was to **port, not
re-implement** — every function has a canonical source file, and the six
behavioural contracts in handoff v2 §10 are correctness requirements rather
than style preferences, because each one exists because violating it produced a
false accusation about a real senator.

Two threads worked the repo concurrently. Lane split:

| | |
|---|---|
| This thread | `evaluation/`, `scope/`, `scoring/`, `orchestrator/`, `judge/`, `web/`, n8n workflows |
| Schema thread | `*.sql`, `data/**`, `docs/RECONCILIATION.md` |

`shared/src/index.ts` is the contract both lanes need and the likely collision
point. Convention settled on: whoever needs a type adds it and mentions it.

---

## What landed

Items 1–7 of the port checklist, plus the wiring that makes them run.

**1 — `deriveAlignment`.** The port on `main` was faithful to the node *before*
the fix and defended the old rule at length. "ANY NAY GOVERNS" collapsed every
split cloture/passage vote to opposition in both directions — not a rule about
which vote binds, a rule that a split is always a BROKE. 14 false accusations.
Replaced with the binding-threshold rule: cloture governs whenever taken.

**2 — Scope classifier v1.1.** New pre-retrieval leg. Two outcomes *stop* a
query, and both are terminal-but-not-errors: a non-testable speech act, and a
bounded statement whose window can't be resolved.

**3 — `loop.ts` mapping.** Two contract violations live on `main`, both
invisible in the UI — the screen showed the right thing while the database
stored the wrong one. `promise_alignment` held the model's answer instead of the
derived verdict; `alignment_confidence` bypassed the split-vote cap.

**4 — Two gate layers.** `preEvaluatorGates` (terminal verdicts, before the
evaluator) and `judgeGates` (assigns nothing, feeds the judge). Both are called
"gates" and both carry G1–G4 labels; the overlap is defence in depth, since the
pre-gates fail open on missing inputs.

**5 — The adversarial judge.** Parsed from the **live** WF13 nodes, not the
stale draft. One pass; the retry invariant is live tested code behind a disabled
flag so enabling it is a flag flip.

**6 — Migrations.** Schema thread: 002–005.

**7 — Enrichment.** Reads the mirror for vote dates, whip votes, cloture results
and roles. Prefers `row` jsonb over typed columns throughout.

---

## Decisions, and why

**Confidence marker gets its own column.** `alignment_confidence` stays numeric;
`confidence_marker` holds `NOT_EVALUATED`. A DB CHECK enforces one or the other.
`0` is a confidence; absence is not.

**Prompts are generated `.ts` with an asserted length**, not `prompts/*.txt` as
§10 suggests. The assertion is what makes "byte-identical to the pipeline"
checkable; a `.txt` file has no such guard. It caught a wrong length on the
first run. `tools/extract-fix-prompt.mjs` reads the fix-bundle markdown, with a
second mode for `fix/12` whose prompt is the document body rather than a fence.

**Known-bad impacts are flagged, not suppressed.** A suppressed bill is
invisible, which is the opposite of what makes a gated row useful.

**One judge pass, no retry.** A FAIL goes straight to the judge's correction or
NOT_DETERMINABLE. `PASS_ON_RETRY` never occurs today.

**G3 ported verbatim**, not relaxed. It was proposed that G3 fire on
`leader + cloture NAY + whip unknown`, since the audit found all 15 such rows
were false and the cost asymmetry favours over-firing. Rejected in favour of
porting faithfully and letting the mirror supply the whip vote instead. It now
has one.

### Deviations from the spec, deliberate

**`JUDGE_ERROR` withholds instead of publishing.** §5 says leave the verdict and
keep `PENDING` — safe *only* because WF11 refuses to score PENDING. There is no
WF11 here, so "untouched" would render an unjudged accusation. Contract 5 says
an infrastructure failure is never a *content* verdict; it does not say the
unreviewed content ships meanwhile. The schema thread reviewed and agreed.

**No judge credential also withholds**, for the same reason.

**The 10% KEPT sample is not inline.** It's a pipeline audit device; inline it
taxes 1 in 10 users with a round-trip that changes nothing they see.

---

## The mirror sync (n8n)

Two workflows in Politician Trustworthy → Fix Workflows:
`tGcHOxabA29Tjob2` (orchestrator) and `hHgKPuixmqESi1uX` (per-table child).
8 enrichment tables, ~7,900 rows, Tue/Fri 06:00. **Not activated yet.**

Four things cost real time and are worth not rediscovering:

**n8n sub-workflows do NOT isolate memory.** They run *integrated* in the
parent's process (`parentExecutionId` on any child run), and n8n retains every
node's output for the life of an execution. Fanning out per table did not fix
the OOM; it just got further. 13 tables crashes, 8 does not.

**The pg driver scans the whole query string for `$n` placeholders**, ignoring
dollar-quoting. A `$95 million` figure in an impact statement became bind
parameter 95. Data belongs in `queryReplacement`, never in the query text.

**The schema moved under the sync three times in one session** — dropped
column, removed constraint, then only a surrogate PK left. The child now reads
`information_schema` and `pg_constraint` before building SQL: declared spec is
intent, live table is authority, and every adaptation is reported as
`schema_drift`.

**The schedule trigger comes back disabled** after certain node edits. An
activated workflow with a disabled trigger silently never fires. Check before
activating.

The sync excludes five tables on the test *"if nothing reads it, syncing it adds
data the request path can reach and buys nothing"* — the two verdict tables
(also revoked in migration 005), `promise_matches` (unread, and exceeds the
memory ceiling alone), `platform_matches` (unread), and `approved_taxonomy`
(`taxonomy.json` is authoritative, so mirroring recreates the two-sources
hazard the exporter exists to prevent).

---

## Outstanding

**Retrieval is the live blocker and outranks everything here.** A query returns
10 candidates, all below the 0.50 floor, best 0.494. Until that's fixed the tool
answers NOT_DETERMINABLE/NO_MATCHES on nearly everything, and this whole chain
adjudicates an empty evidence set. Owned by the schema thread. One candidate
ruled out: `taxonomy.json` is `COMPLETE:2026-08-21`, so it is not a dropped
`Related Terms` line. A uniform ~0.08 shortfall across all candidates looks like
a vector-space difference rather than a semantic miss; the discriminating test
is to re-embed a promise that `Promise Matches` already scored and compare the
same (promise, bill) pair.

**The web layer renders none of the new work.** Gated rows, their reasons, and
the judge disposition are computed, persisted and reported to the model, but the
UI shows none of it. `fix/08` calls gated items "the thing that makes the tool
look honest", so this is a gap rather than polish.

**`appendAuditEvent` does not exist yet** (schema thread owns it), so judge
events sit on the session rather than reaching `app_verdict_audit_log`.
Migration 004's event shape already carries every judge field — `stage`,
`rule`, `disposition`, `marker`, `detail` — so no schema work is needed.

**The halt UI is untested in a browser.** Demo mode skips scope classification,
so a halt can't be triggered without an API key.

**`mirror_roll_call_votes` has no natural key.** It reloads every run, which
works. `UNIQUE (vote_id)` would restore upserting — 220 rows, 220 distinct Vote
IDs. Same standing suggestion for `affected_stakeholders` and `donors`.

**`docs/fix/09` contains three real Sheets document IDs** in plaintext, which
contradicts `data/sheets.ts` scrubbing its own on the grounds that a doc id is
an access identifier. Introduced by this thread; worth scrubbing.

---

## Traps

**Two things are called "gates".** `evaluation/gates.ts` (pre-*retrieval*,
promise_type/stance — and still dead code, zero call sites),
`evaluation/preEvaluatorGates.ts` (pre-*evaluator*, terminal verdicts), and
`judge/judgeGates.ts` (post-verdict, advisory). Three layers, overlapping
labels.

**`NOT_EVALUATED` is never replaced with a value from the column's own
vocabulary.** `NEUTRAL` in `bill_effect` asserts "the bill does not move this
goal" — a finding nobody made. This is why gated rows carry markers and scored
rows do not.

**Withholding copy must not read as exoneration.** `WITHHELD_LOW_CONFIDENCE`,
`WITHHELD_PENDING_REVIEW` and `GATED` all say we could not defensibly call it,
never that he kept it.

**The evaluator's `promise_alignment` is never the verdict.** `deriveAlignment`
decides. The model's answer is `model_verdict`, for agreement tracking only.
