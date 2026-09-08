# Thread context — schema, diagnostics, n8n reconciliation

Companion to `v7-port-thread-context.md`. That thread owned the application
logic; this one owned the database, the pipeline reconciliation, and the
diagnostics. Written 2026-09-07 for a successor thread.

**The durable record is `docs/RECONCILIATION.md`** — ~50 KB, chronological, and
the thing to read before trusting anything here. This file is an index and a
statement of what is open, not a replacement.

---

## What this lane owned

`*.sql` · `packages/server/src/data/**` · `docs/RECONCILIATION.md` · n8n reads
and diffs. Later also `embeddings/` and, by agreement on the day, two small
crossings into `scoring/` and `orchestrator/dispatch.ts`.

---

## Migrations — 002 through 007, all applied to the live database

| # | What |
|---|---|
| 002 | `app_query_matches`, `app_query_alignments` — the query trace, matches **and** non-matches |
| 003 | v7 field set: 8 scope columns on `app_queries`, 15 on `app_query_alignments` |
| 004 | `app_verdict_audit_log` + `v_verdict_trace` |
| 005 | Firewall restored structurally; `source` discriminator on the audit log |
| 006 | Judge-gate view aligned with WF11's `Drop Unjudged Rows`; `v_accusations_rendered` |
| 007 | Corpus verdict mirrors dropped |

### Load-bearing schema decisions

**`alignment_confidence` stays numeric; the `NOT_EVALUATED` marker has its own
column.** A marker replaced by a value from the column's own vocabulary is a
fabricated finding — `0` asserts "no confidence", which is a determination
nobody made. A `CHECK` enforces that only one is ever present. This was a live
breaking bug in 002: `gates.ts` emits the string into a numeric column, which
raises, and the transactional write would have rolled back the parent row too —
every gated query storing nothing.

**The audit log is append-only by privilege.** `receipts_app` holds `INSERT` and
`SELECT`; `UPDATE` and `DELETE` are revoked. A trace that can be edited is not a
trace. A correction is a new event with a later `seq`.

**`seq` is caller-supplied**, not generated — wall-clock ties on sub-millisecond
steps and the order is the point of an event log.

**Coverage columns are ahead of the code, deliberately.** `gate_hits`,
`senator_role`, `role_condition`, `cloture_result`, `bill_class` are correct
against WF10A's 74-column output; they stay null until the producing logic
lands. Not wrong — ahead.

---

## The corpus firewall — both directions, now structural

The original guarantee was one-way: the trust index must never read a user
query. 002 enforced it by revoking `receipts_trust` on `app`.

**The reverse was only ever code.** The query tool must never read a
pre-computed verdict and present it as its own reasoning, but `receipts_app`
held `SELECT` on all of `mirror`, and the sync had begun populating
`mirror_promise_alignment_matches` and `mirror_decision_scores`. 005 revoked
them; 007 dropped them.

⚠️ **The n8n sync must also stop writing those two tables.** Dropping them does
not change the sync set — if it still lists them it recreates them on the next
run and reopens what this closed.

---

## Pipeline reconciliation — verified against live nodes, not specs

All four source workflows moved between 2026-08-19 and 2026-09-07.

**Verified identical:** WF6 bill-side embedding is `text-embedding-3-small` @
`1024`, same as the query side — an unchecked gap that would have made every
similarity meaningless. The v7 evaluator prompt is byte-identical to WF10A's
live system message at 9,343 chars, so the `docs/fix/` spec it was generated
from had not drifted.

**Column drift:** W7B 54 → 57. WF10A 62 → 74. WF8 writes the *identical*
57-column `Promise Matches` schema as W7B — the two directions differ only by
`Match Direction`.

**WF11's judge gate** (`Drop Unjudged Rows`, added 17:43 that day) blocks
`PENDING` and `REVIEW_REQUIRED`; **a blank grade passes**, because the judge only
runs on accusations. Migration 004 had that backwards and would have put the
whole table in the review queue.

---

## Two corrections this thread made to its own work

Both are in `RECONCILIATION.md` in full. A successor should know they happened,
because the wrong versions were stated confidently.

**1. The retrieval "blocker" was never a bug.** Five turns chased a defect that
did not exist. `hr5376` (Inflation Reduction Act) is 117th Congress; collection
starts at the 118th. `NOT_DETERMINABLE / NO_MATCHES` was correct.

The disconfirming evidence was in hand two turns earlier: a Medicare query
returned `KEPT` with an admitted match, on the same namespace, embedder and run.
A systematic offset cannot depress one query and not the other. It was read as a
success rather than as a test result, and the other thread was sent to look at
the vector space on that basis.

**2. Migration 004's judge-gate view was inverted** — see WF11 above.

---

## What that investigation did produce: the coverage disclosure

> "We didn't find any bills or votes in this senator's analyzed record."

True, and a reader hears *"he has no record on drug pricing"* — about a senator
who passed the IRA. **This is the mirror of the false-positive class and the
less protected of the two.** An accusation must clear a 0.7 floor, carry a
counterargument and survive a judge. An absence gets a clean sentence and no
scrutiny.

`config.coverage.congresses`, `congress` threaded from Pinecone metadata onto
`MatchedAction`, `CoverageWindow` on `QueryResult`, and `scoring/coverage.ts`.

The window is **derived from the retrieved candidates**, not hardcoded —
specifically so extending collection cannot leave a sentence lying in the other
direction. The sentence describes the **search**, never the senator, and
actively denies the inference rather than merely avoiding it.

**Still owed:** `ND_REASON_COPY.NO_MATCHES` and the rendering. The field is
populated-ready; the copy change is one line. Until it renders, the boundary is
in the payload and not on screen.

---

## Contract 3 — the one verdict rule this thread wrote

`scoring/withholding.ts`. A `BROKE`/`INCONSISTENT` whose best breaking action is
below **0.7** with no counterargument becomes `NOT_DETERMINABLE /
WITHHELD_LOW_CONFIDENCE`.

- **Best breaking action, not the average** — one sound action at 0.85 survives
  weak corroboration; averaging would suppress defensible accusations.
- **Null confidence fails closed** — no confidence is *less* evidence than 0.65.
- **`counterargumentPresent` defaults false** — v7 puts it in prose, and prose
  cannot be verified by inspection.
- **Evidence still renders.** Only the conclusion is withheld, and the copy is
  deliberately non-exculpatory.

---

## Open items

| | Item | Owner |
|---|---|---|
| 1 | **Stop the n8n sync writing the two corpus verdict tables** — 007 drops them; the sync will recreate them | pipeline |
| 2 | `ND_REASON_COPY.NO_MATCHES` copy + render `coverage` | app |
| 3 | Add the **117th Congress** to collection — contains the IRA and the 2022 campaign cycle. WF6 already takes `target_congress`; cost is bill data + impact statements, not a rebuild | pipeline |
| 4 | `min(Promise Date)` on Evaluable Statements — decides whether coverage goes further back. A number, not a judgement call | pipeline |
| 5 | `decisionScore.ts` **stale and dormant** — `Compute Decision Score` is 25,077 chars against a port reconciled at 20,803. Called only by its own test. **Re-reconcile before anything wires it in** | app |
| 6 | `match_direction` is hardcoded `'promise_to_bill'` — make it a named constant so the trace is honest about the tool being one-directional by design | app |
| 7 | Rate limiting — [spec](../rate-limiting-spec.md) written, not wired. Wanted before the frontend is public | app |
| 8 | PostHog wiring, and the privacy-policy line before the first public query | product |

Not in scope, decided: **WF8 / bill→promise.** The query tool answers "does this
senator's record bear on this statement", which is inherently promise→bill.
Bill→promise searches `_statements` and is a different product question.

---

## Working practices worth carrying forward

**The live node wins — and the node includes its prompts.** Six of the seven
corrections in `RECONCILIATION.md` were found by reading node code. The seventh
— a −0.1 confidence penalty asserted by the spec and "verified absent" by two
people — was invisible to that method, because the node is an `openAi` node
whose logic is prose in `parameters.responses.values[0]`. For an LLM node the
prompt *is* the implementation.

**Verify the change fired.** The DEMO confidence fix typechecked clean, looked
complete, and did nothing — `dispatch` dropped the value before scoring. Caught
only by running a query and reading `conf=None`.

**Two agents, one working tree, is the hazard.** File-level lanes do not protect
against a branch switch, which moves everything at once. Use
`git worktree add ../receipts-<lane> <branch>`.
