# The query trace — a log sheet for every gate

**What it is.** Every run of `/api/query` writes one trace: one row per gate the
context passed through, in order, each with what it was given, what it
produced, and the one-line decision it took. Model calls carry the full user
message in, the raw text out, the parse beside it, the model, the prompt
version, the prompt's sha256 and the token usage.

**What it is for.** Repair. The UI shows the end of the pipeline; the stored
tables hold the parsed outcome of each leg; the verdict audit log (migration
004) holds every decision that changed a verdict. None of them shows what went
INTO a model and what came OUT, in sequence — so when a result looks wrong there
was no way to say which gate bent it. This does.

**What it is not.** Not evidence about a senator, and never read on the request
path. Reads are by run id only — no list, no search — the same posture as
share links. It complements the audit log rather than replacing it: 004 is the
journalist's artefact, this is the mechanic's.

---

## Getting a trace

Every stream starts with a `trace` event carrying the run id, and the id is
printed under the reasoning panel ("Trace `<uuid>`", linked). Then:

| Where | How |
|---|---|
| Raw JSON | `GET /api/trace/<run_id>` — Supabase first, then the server's own files |
| Log sheet (markdown) | `npm run trace -- <run_id>` from the repo root (reads `.data/traces`) |
| Log sheet from a running server | `npm run trace -- <run_id> --api http://localhost:8787` |
| Log sheet from production | `npm run trace -- <run_id> --api https://receipts-65yk.onrender.com` |
| Full payloads, untruncated | add `--full`; write to a file with `--out sheet.md` |
| SQL | `select * from app.v_query_trace_sheet where run_id = '<run_id>'` |

`npm run trace` needs no dependencies and no credentials. With `--api` it
works from any machine that can reach the server.

## Where it is stored

Two sinks, both best effort, both optional:

- **File** — `TRACE_DIR` (default `.data/traces`, gitignored), one JSONL file
  per run named `<start-time>_<run_id>.jsonl`, pruned to `TRACE_MAX_FILES`
  (default 200). **This is the sink that works with `DATABASE_URL` blank**,
  which is the normal local setup because a local `DATABASE_URL` writes to
  production. `TRACE_DIR=off` disables it.
- **Supabase** — `app.app_query_trace_runs` + `app.app_query_trace_steps`,
  written in one transaction at the end of the run. Requires
  [migration 009](supabase-migration-009-query-trace-log.sql), run as
  `postgres` in the SQL editor. Until it is run, the server logs once that the
  tables are missing and carries on writing files. `receipts_app` gets SELECT
  and INSERT only — a trace that can be edited is not a trace.

A failure in either sink is logged and never touches the answer.

The trace is keyed by its **own run id, not by `query_id`**. A run that halts
on scope, stops on an uncached senator, or errors before interpretation never
writes an `app_queries` row — and those are exactly the runs most worth
tracing. `query_id` is a nullable pointer filled in when persistence produced
a row; the `PERSIST` step says why when it did not.

## The gates, in order

Stages are named after the gate, not the tool, so a trace reads as the flow
diagram. `kind` says what kind of thing decided: `model`, `deterministic`,
`io`, or `control`. `status` is `ok`, `error`, `skipped` (a leg that did not
run, with the reason in the label), or `rejected` (a model output the code
refused and sent back — an explanation draft that failed the wording checks,
an evaluator response that did not parse).

| # | Stage | Kind | What it records |
|---|---|---|---|
| 1 | `REQUEST` | control | Senator, statement, corrections, statement date, mode flags, models configured |
| 2 | `SCOPE_MODEL` | model | The scope classifier's raw exchange (haiku) — user message, text back, usage |
| 3 | `SCOPE_CLASSIFY` | deterministic | The post-checked classification; `rejected` if the model JSON did not parse; cache hit or miss |
| 4 | `HALT` | control | When scope stops the query (non-testable speech act, or a bounded window with no date) |
| 5 | `ORCHESTRATOR_TURN` | model | Every turn of the Sonnet tool-use loop: stop reason, every content block (text, tool calls), usage. **This is the AI output that previously vanished entirely.** |
| 6 | `CLASSIFY_MODEL` | model | The dedicated classifier's raw exchange (haiku, forced tool) |
| 7 | `CLASSIFY` | deterministic | Orchestrator's classification vs the classifier's vs the user's corrections, the disagreements, the resolution, taxonomy keyword lookup, **and the exact text that was embedded** |
| 8 | `INTERPRET` | deterministic | The `interpret_promise` tool boundary: the model's input, the envelope returned |
| 9 | `RESOLVE_SENATOR` | deterministic | Cached or not |
| 10 | `UNCACHED` / `QUEUE_SENATOR` | control | The demand-signal path, when it fires |
| 11 | `EMBED` | io | Dimensions, model, the embedded text echoed |
| 12 | `RETRIEVE` | io | Store, namespace, topK, version pin; returned / above floor / below floor / top score; every candidate with its score and votes; the near misses |
| 13 | `RELEVANCE` × N | model | One per candidate: full user message, raw text, parsed verdict and the four axes, tokens, ms. Subject = action_uid |
| 14 | `EVIDENCE_GATE` | deterministic | Admitted vs dropped by reason, tiers, dedupe. `skipped` when no OpenAI key (raw matches passed through UNCHECKED — said so) |
| 15 | `SEARCH` | deterministic | The `search_actions` tool boundary |
| 16 | `ENRICHMENT` | io | Mirror or null; how many actions had enrichment. `skipped` = scope and leader gates failed open |
| 17 | `PRE_EVALUATOR_GATE` × N | deterministic | One per candidate: the row and statement meta the gates tested, every hit, the context, scorable or gated-with-reason |
| 18 | `FULFILLMENT` × N | model | One per scorable candidate: full v7 user message, raw text, parsed bill_effect / alignment / confidence / flags. `skipped` when no OpenAI key (orchestrator's advisory effects used) |
| 19 | `SCORE` | deterministic | Every scorable row as the scorer saw it (effect, its source, orchestrator disagreement, confidence, votes, flags) → verdict, band, mode, nd_reason, evidence rows. Contract 3 shows up here as `nd_reason` |
| 20 | `JUDGE_GATES` | deterministic | G0–G4 on the lead breaking action |
| 21 | `JUDGE_MODEL` | model | The judge's raw exchange (sonnet): user message, content blocks, parsed grade |
| 22 | `JUDGE` | deterministic | Grade → disposition → verdict before/after. `skipped` when the verdict was not an accusation (**not a pass**); `error` when there was no credential and the accusation was withheld unreviewed |
| 23 | `EVALUATE_EFFECTS` | deterministic | The tool boundary: the orchestrator's effects in, the frozen result out |
| 24 | `EXPLAIN_CHECK` | deterministic | `rejected` with the wording problems for every draft sent back; `ok` with the accepted explanation |
| 25 | `EXPLAIN` | deterministic | The tool boundary |
| 26 | `RESULT` | control | The frozen `QueryResult` exactly as emitted |
| 27 | `ERROR` | control | Any stream error, with its code and cause |
| 28 | `PERSIST` | io | `app_queries` id, candidate/alignment counts, audit events written; or `skipped` with the reason; or `error` |
| 29 | `DONE` | control | How the run concluded, event count, cached or not |
| — | `CACHE_REPLAY` | control | A replay is its own run with this single step, pointing at the original run id. The browser is sent the **original** id — that run produced the answer |

In DEMO mode the model stages are absent (no model is called) and the
deterministic stages run on the stubs. A live query produces roughly 25–60
rows.

## Reading a sheet

`npm run trace -- <run_id>` renders three parts:

1. **Header** — when, how it concluded, the final verdict line, the
   `app_queries` id, mode, model-call count and token totals.
2. **Steps that did not simply pass** — every `error`, `skipped` and
   `rejected` step, first. This is usually where the answer is.
3. **Log sheet** — one line per step: seq, status mark, stage, kind, subject,
   decision, ms, model, tokens. Scan this to find the gate that bent the
   answer.
4. **Steps** — one section per step with its input and output. Long strings
   (prompts, raw model text) are shown as text blocks, not JSON escapes.
   Truncated at 1,200 chars unless `--full`.

Typical questions and where to look:

- *"Why did it find nothing?"* — `RETRIEVE` (was the namespace thin, or was
  nothing similar?), then `CLASSIFY` (what text was embedded — a wrong
  sub-issue moves the vector), then `EVIDENCE_GATE` (did the gate drop
  everything, and by what reason?).
- *"Why is this bill BROKE?"* — `FULFILLMENT` for that action_uid (raw
  reasoning vs parse), then `SCORE` (what effect the scorer used, whether the
  orchestrator disagreed), then `JUDGE`.
- *"The explanation contradicts the verdict"* — `EXPLAIN_CHECK` rejections
  show every draft that was bounced and why; `ORCHESTRATOR_TURN` shows the
  narration the model wrote around each tool call.
- *"Nothing was stored"* — `PERSIST`.

## Bounds and what is deliberately not stored

- Strings are truncated at 32,000 characters with a marker that says how much
  was dropped. A truncated field is never mistaken for a short one.
- **System prompts are not stored.** Each model step carries the prompt's
  version tag and sha256; the text is in the repo at that version
  (`relevancePrompt.ts`, `evaluatorPromptV7.ts`, `judgePrompt.ts`,
  `scopeClassifierPrompt.ts`, `orchestrator/prompts.ts`). Storing 32 KB per
  row per call would bloat every trace for no information.
- Thinking blocks are noted by length, not dumped.
- Credentials never appear: request bodies do not carry the key, and nothing
  reads `process.env` outside `config.ts`.

## Design notes

- **Ambient, not threaded.** The trace is opened per run and exposed through
  `AsyncLocalStorage`, so a model-call site three modules down records with
  `traceStep(...)` and no signature change. Outside a run every helper is a
  no-op — which is what keeps every pre-existing unit test unchanged.
- **Recording is synchronous into memory; flushing is at the end.** Nothing
  in the request path awaits a sink. The file sink writes after `done`; the
  Supabase sink writes one transaction after persistence, so it has the
  `query_id`.
- **The two OpenAI legs got an `observe` option** rather than an ambient
  call: `evaluateRelevance` and `evaluateFulfillment` are ports of live n8n
  nodes and run their candidates in parallel, so the hook is the only place
  where one candidate's request, raw response and parse exist together.
- **Tests:** `trace/trace.test.ts` (recorder, bounds, sinks),
  `evaluation/observe.test.ts` (the hooks), and
  `orchestrator/traceRun.test.ts`, which runs the real loop in DEMO mode and
  asserts the gate sequence — the one test that would catch a gate going dark.
