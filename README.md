# Receipts

The consumer front door to the AI political accountability platform. A voter types a campaign
promise in plain language, picks a senator, and gets a traceable verdict matched against bills and
votes we've already analyzed — with the reasoning streaming as it works and every claim linking back
to a real bill.

**Live:** https://receipts-eight-tau.vercel.app — the frontend on Vercel, proxying to the backend on
Render. Real models, real corpus. Every query spends money at three vendors, and the URL is public;
see "Deploying" for what bounds that.

---

## Run it

```bash
npm install && npm run dev
```

- Front end → http://localhost:5173
- API → http://localhost:8787 (proxied at `/api`, so no CORS and no keys in the browser)

**It runs with no credentials at all.** With no `.env` you get demo + fixture mode: the whole slice
is clickable, every state is reachable, and the UI says plainly that the data is sample data and the
wording is canned. That is deliberate — a stub presented as a real finding would be exactly the
fabricated answer this product exists to avoid.

```bash
npm test          # 20 files: scoring port, gates, judge, coverage, disclosure copy, limiter, cache
npm run typecheck
```

The suite is pinned **credential-free** in `vitest.config.ts` — it runs with every key blanked no
matter what `.env` holds, so it can never make a live model call. A test that needs a model goes
behind an explicit fetcher stub; every call site takes one.

---

## Switching fixture → live

Modes are inferred from which keys are present, one layer at a time. Put an untracked `.env` at the
**repo root** — not in `packages/server/` — and fill in as much as you have:

| You add | What goes live |
|---|---|
| `ANTHROPIC_API_KEY` | Scope classification, interpretation, explanation, and the adversarial judge. Matches still come from fixtures. **The judge still cannot run** — see the note below. |
| `+ OPENAI_API_KEY` | Relevance and the fulfillment evaluator, which is what produces a per-action confidence. This is what lets the judge run. |
| `+ PINECONE_API_KEY` + `PINECONE_HOST` | Real retrieval against the senator's embedded record. |
| `+ DATABASE_URL` | The enrichment mirror (whip votes, roll-call results, senator roles — the gates run at full strength) and query persistence. ⚠️ **Points at production.** Local queries write real rows. Blank it for verification runs. |
| `COVERAGE_CONGRESSES` | Not a key — a disclosure. Which congresses were collected (`118,119`). Unset, the tool tells users it cannot establish what it searched. |

`FIXTURE_MODE` / `DEMO_MODE` override the inference. `GET /api/health` reports which mode is
actually running, and the startup banner prints credential *presence* (never values).

**Why an Anthropic-only configuration cannot exercise the judge:** contract 3 runs *inside* the
scorer and withholds any accusation whose confidence is below 0.7. Without the fulfillment evaluator
every confidence is `null`, contract 3 fails closed as designed, and the verdict is already
`NOT_DETERMINABLE` by the time the judge is consulted. The two layers are in series, cheapest first.

---

## Where things live

| What | Where |
|---|---|
| **Statement scope** — what kind of thing was said, and can a vote test it at all. Runs first, can halt the query. | `packages/server/src/scope/` |
| **Evaluation** | `packages/server/src/evaluation/` |
| ↳ relevance (WF7b port) + the evidence gate | `evaluation/relevance.ts`, `evidenceGate.ts` |
| ↳ pre-evaluator gates (fix/03, verbatim) — scope, split vote, leader switch, vehicle | `evaluation/preEvaluatorGates.ts` |
| ↳ fulfillment evaluator v7 — decides `bill_effect` | `evaluation/fulfillment.ts`, `evaluatorPromptV7.ts` |
| ↳ enrichment mirror — whip votes, roll-call results, roles | `evaluation/enrichment.ts` |
| ↳ **generated prompts — never hand-edit** | `relevancePrompt.ts`, `evaluatorPromptV7.ts`; generators in `tools/` |
| **Deterministic scoring** | `packages/server/src/scoring/` |
| ↳ the verdict table (WF10A port) | `scoring/deriveAlignment.ts` |
| ↳ gates → dials → bands → ranked | `scoring/score.ts` |
| ↳ contract 3 — withhold an accusation below the floor | `scoring/withholding.ts` |
| ↳ coverage — what record was actually searched | `scoring/coverage.ts` |
| ↳ vote patterns (WF11 port) | `scoring/votePattern.ts` |
| ↳ every tunable number | `scoring/config.ts` |
| ↳ the WF11 scorer — **stale and dormant**, called only by its own test; re-reconcile before wiring | `scoring/decisionScore.ts` |
| **The adversarial judge (WF13 port)** | `packages/server/src/judge/` |
| ↳ deterministic gates, the Sonnet judge, dispositions + the retry invariant | `judgeGates.ts`, `judge.ts`, `dispositions.ts` |
| **Tool-use loop** — the fixed sequence, and the per-session replay cache | `orchestrator/loop.ts`, `dispatch.ts` |
| **Rate limiting** | `packages/server/src/rateLimit.ts` |
| **Data seam** — action store, query store, result cache | `packages/server/src/data/` |
| **Embedding parity** | `packages/server/src/embeddings/promiseEmbeddingText.ts` |
| **Shared wire contract + every line of voter-facing copy** | `packages/shared/src/index.ts` |
| **The receipt** — verdict, evidence cards, gated rows, honest states | `packages/web/src/components/` |
| **Reconciliation log** — the durable record | `docs/RECONCILIATION.md` |
| **Deploy topology** | `DEPLOY.md`, `vercel.json` |

---

## The architecture

The model interprets and explains. It never computes. That boundary is the product, and it now has
several layers on each side of it. In the order a query runs:

1. **Scope classification** (Haiku) — *what kind of statement is this?* A scheduling remark, a
   credit claim or rhetoric cannot be kept or broken, and the query **halts** with an explanation
   before any money is spent. A bounded pledge with no date halts and asks for one.
2. **Interpretation** (Haiku) — the taxonomy pair and stance that build the query vector.
3. **Retrieval** — embed with WF7a's template, query Pinecone, top 10.
4. **Relevance** (gpt-5.4-mini) and the evidence gate — drop `DIRECTIONAL`, `DATED_VEHICLE`,
   `AMBIGUOUS` partials before anything is judged.
5. **Pre-evaluator gates** — deterministic, verbatim from fix/03. A row whose statement window had
   closed, whose precondition no longer held, or whose vehicle is too broad is **gated: kept and
   displayed with its reason, never dropped.**
6. **Fulfillment evaluator v7** (gpt-5.4-mini) — decides `bill_effect` and a per-action confidence.
   The orchestrating model's own effect judgement is collected as a **cross-check**, and a
   disagreement is surfaced rather than resolved silently.
7. **The verdict table** — `deriveAlignment`, two-factor: bill effect × support. Decides the outcome
   per action and states which vote governed.
8. **Scoring** — pure. Gates, dials, bands, ranked mode. **Contract 3** lives inside it: an
   accusation below 0.7 with no counterargument is withheld, and the copy says "we could not
   defensibly call this", never "he kept it".
9. **The adversarial judge** (Sonnet) — only on an accusation that survived step 8. Seven tests; a
   PASS is invalid without the senator's counterargument; an infrastructure failure is never a
   content verdict.
10. **Explanation** (Sonnet) — narration of a **frozen** result. It can describe the verdict; it
    cannot change it.

### The six behavioural contracts

From handoff v2 §10. Each is enforced in code and tested; do not weaken any of them.

1. The model's `promise_alignment` is **never** the verdict. `deriveAlignment` decides.
2. Split vote → confidence ≤ 0.75, both votes named, the governing vote stated.
3. BROKE/INCONSISTENT below 0.7 → the counterargument is present or the reading is withheld.
4. A retry may only move a verdict *away* from an accusation, or lower confidence.
5. A judge infrastructure failure is never a content verdict.
6. `NOT_EVALUATED` is never replaced with a value from the column's own vocabulary — `0` is a value.

### Ported, not designed

`scoring/`, `judge/` and the gates are **transcriptions** of the live n8n workflows (WF10A, WF11,
WF13, fix/03), not implementations of a written spec. Where a spec and a live node have disagreed
the node has been right every time — and "the live node" includes its *prompts*, because an LLM
node's logic is prose, not `jsCode`. See ADR-010 (`docs/adr/README.md`) and the reconciliation log.

**The verdict table is two-factor: bill effect × support. There is no stance term.** Stance is
already baked into ADVANCE/HINDER by the evaluator; multiplying by it again inverts the verdict for
every "Opposed" promise. `score.test.ts` guards it — and `stanceInversion.test.ts` records why the
absence of that term also means the table *cannot catch* an evaluator that gets the direction wrong.

### Embedding parity

Parity is not just "same model, same dimensions". The stored bill vectors are searched by a query
vector built from a **structured template**, and a bare user sentence lands elsewhere in the space —
degrading matches silently, with no error. `promiseEmbeddingText.ts` ports WF7a's template verbatim.

There are **two** promise templates live: the one that builds the `_statements` vectors and the one
WF7a uses to query `_bills`. They differ. Receipts searches bills, so it uses WF7a's. Don't unify
them. Taxonomy keywords are a **sheet lookup**, never model output.

---

## Honest states

Every one of these is an answer, not an error screen. The word they have in common is *why*: a thin
result is designed with the same care as a strong one, and each cause gets its own sentence.

| State | When |
|---|---|
| **Halt** · not testable | A scheduling remark, credit claim or rhetoric — nothing a vote can keep or break. Stops before retrieval. |
| **Halt** · date required | A bounded pledge with no date. Asks for one and re-runs with it. |
| `NOT_DETERMINABLE` · not evaluable | Too vague to name a checkable commitment |
| `NOT_DETERMINABLE` · no matches | Nothing in the analyzed record relates to it |
| `NOT_DETERMINABLE` · below floor | Related legislation exists, none close enough to count |
| `NOT_DETERMINABLE` · all neutral | The bills found don't move the goal either way |
| `NOT_DETERMINABLE` · **gated** | We found related bills and *deliberately declined to read them* — the window had closed, or the vehicle was too broad. Each is shown with the gate's reason. |
| `NOT_DETERMINABLE` · procedural switch | Sponsored the bill, then voted against it (Senate Rule XIII) |
| `NOT_DETERMINABLE` · **withheld, low confidence** | Contract 3. The record points against the promise, but not clearly enough to say so publicly. The evidence stays on screen. |
| `NOT_DETERMINABLE` · **withheld, review** | The judge failed the reading — or **could not run**, and the copy says which. Nobody looked is not the same as a reviewer disagreed. |
| Ranked verdicts | Evidence genuinely conflicts — both sides shown, High capped to Medium |
| Uncached senator | Not analyzed yet; the request is logged as a demand signal |
| Rate limited | Too many checks in the window. Retryable, and says nothing is broken. |
| Error | Structured, with retry; nothing partial is rendered |

**On every result, not only the empty ones:** the coverage sentence — which congresses were searched,
and that an empty result is not a finding that the senator has no record. This is the mirror of the
false-accusation class and the less protected of the two: an accusation must clear a floor, carry a
counterargument and survive a judge; an absence used to get a clean sentence and no scrutiny.

**On every published accusation:** that it was reviewed, and the senator's strongest counterargument
beside it. **On every evidence card:** which vote governed, in plain language, plus disclosure flags
— split vote, floor leadership at the time, a proxied action date.

Three vocabulary rules are enforced in code and tested: **no statistics at Level 1** (which is why
`vote_governing`'s raw value, containing "threshold", never reaches a voter), **no motive language**
anywhere, and **nothing exculpatory in a withholding** — declining to accuse is not a finding of
innocence.

---

## Deploying

Two targets, and the split is the point: the backend holds every secret; the frontend holds none.

| | Where | Notes |
|---|---|---|
| `packages/web` | **Vercel** — https://receipts-eight-tau.vercel.app | Static Vite bundle. **No environment variables** — anything set there ships to the browser. Build settings and the `/api` rewrite are committed in `vercel.json`, because auto-detect gets this monorepo wrong. |
| `packages/server` | **Render** — `receipts-65yk.onrender.com` | Persistent Node container. All keys live in its environment. |

The browser only ever talks to the Vercel origin; Vercel proxies `/api/*` to Render server-side.
There is no cross-origin request, so `CORS_ORIGIN` is never consulted for normal traffic. **Leave
`VITE_API_BASE` unset** — setting it makes the bundle call Render directly and turns every request
cross-origin, where it is judged against a `CORS_ORIGIN` that currently points nowhere.

What bounds spend on a public URL: per-IP rate limiting (15 queries / 15 min, 60 / day; `/api/health`
exempt so the platform's own probe cannot take the service down) and a per-session replay cache that
absorbs EventSource reconnects, refreshes and double-submits. Neither is protection against a
determined abuser — see `docs/rate-limiting-spec.md` for what they deliberately do not solve.

Full detail, the env table, and the verification banner are in [DEPLOY.md](DEPLOY.md).

---

## Pipeline reconciliation log

The ported modules are transcriptions of live n8n nodes and need re-reading whenever the pipeline
moves. The log lives in **[docs/RECONCILIATION.md](docs/RECONCILIATION.md)** — the durable record,
appended never edited, so a wrong finding stays visible beside its correction. Read it before
trusting any spec; the source specs in [docs/specs/](docs/specs/) have been wrong repeatedly.

## Where this repo is AHEAD of the pipeline

Two behaviours here are deliberately **not** transcriptions, and the divergence is the correct one.
The n8n side should adopt them rather than this side reverting.

1. **`JUDGE_ERROR` withholds instead of publishing.** `judge/dispositions.ts` treats a judge
   infrastructure failure as "nobody reviewed this", so an accusation is withheld rather than left
   standing. WF13's `Set Disposition` still leaves the verdict in place — on 2026-09-08 that would
   have published `CONSISTENT @ 0.7` on a row the judge had explicitly failed as out-of-scope
   (`ALIGN-P2BM-T000250-7Z0J7FUX-S186-118`). Handoff v2 §5 states the principle — an infrastructure
   failure is never a content verdict — and it does not say the unreviewed content ships meanwhile.
2. **The orchestrator-vs-evaluator `bill_effect` cross-check** (`orchestrator/dispatch.ts`) records
   and surfaces a disagreement rather than resolving it silently in the evaluator's favour. The
   pipeline has no equivalent, so drift on the axis that decides direction is invisible there.

## Known gaps

Open, in rough order of consequence. The first three are the remaining tasks from the 2026-09-09
review brief.

1. **The judge never sees a positive verdict.** The trigger is `scored.verdict === 'BROKE'`. WF13's
   dry run found sampled `KEPT`/`CONSISTENT` rows overturned at ~27% — the same failure classes as
   accusations. A "he kept this" currently gets no second opinion. Fixing the trigger alone is not
   enough: `applyDispositionToResult` only ever downgrades `BROKE`, so a failed positive would run
   the judge and still render `KEPT`.
2. **The judge retry does not exist.** `config.judge.retryEnabled` is read by nothing, and there is
   no re-evaluate-with-critique call. The *invariant* (contract 4) and the `PASS_ON_RETRY` disposition
   are built and tested; the half that produces a retry is not. In WF13's run the retry moved 12 of
   52 rows and turned two accusations into correct `CONSISTENT` readings.
3. **A judge-corrected accusation cannot reach the screen.** The `REVIEW_REQUIRED_JUDGE_CORRECTED`
   branch sets `withheld: isAccusation` while its comment says "it shows, but flagged for review".
   The only accusation that survived WF13's review arrived through this path and would render here
   as "not determinable". A product decision, to be made explicitly — not by a flag whose comment
   describes the opposite.
4. **Evaluator v7 inverts oppose-framed statements.** Measured: an Opposed statement whose goal is
   the *absence* of something, matched to a bill that restricts it, comes back `HINDER` where
   `ADVANCE` is correct — three cases at 0.88–0.90, all above contract 3's floor. Held as data in
   `evaluation/stanceInversion.test.ts`. The fix is in the prompt, which is **generated** from
   `docs/fix/07`; it lands beside the matching n8n edit, because `bill_effect` is the axis where
   divergence does the most damage.
5. **`decisionScore.ts` is stale and dormant** — called only by its own test. Re-reconcile against
   the live WF11 node before anything wires it in.
6. **The client has no stream-closed handling.** A dropped SSE connection leaves every step ticked
   and no verdict, with no error. Seen once in dev when the server restarted mid-query.
7. **`embedding_version`** — WF7a scopes bill vectors to one batch `run_id`. A live query has no run
   to scope to, so the filter is opt-in via `PINECONE_EMBEDDING_VERSION`. Unset searches all
   versions. Leave it unset unless you mean it: a stale pin returns zero vectors from a full
   namespace, and the store fails loudly rather than rendering that as "no relevant bills".
8. **`cloture_vote` / `passage_vote` may be `'NA'`** in some bill vectors. Real passage votes have
   been observed in live results; cloture has not been confirmed. Verify against real data.
9. **`HIGH_AVG_STRENGTH` (0.65)** is a presentation-layer default with no pipeline equivalent.
10. **Term separator** in the embedding text (`", "`) is an assumption about the upstream sheet.

**Closed since this list was written** (kept visible so nobody re-reports them): the relevance and
evidence gates are wired; `taxonomy.json` is the complete 121-row export; the coverage sentence
renders; gated rows render; the halt UI works in a browser; rate limiting is live; `.env` loads from
the repo root; `PINECONE_INDEX` was a documented knob with no consumer and is gone.
