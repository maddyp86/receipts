# Receipts

The consumer front door to the AI political accountability platform. A voter types a campaign
promise in plain language, picks a senator, and gets a traceable verdict matched against bills and
votes we've already analyzed — with the reasoning streaming as it works and every claim linking back
to a real bill.

---

## Run it

```bash
npm install && npm run dev
```

- Front end → http://localhost:5173
- API → http://localhost:8787 (proxied at `/api`, so no CORS and no keys in the browser)

**It runs with no credentials at all.** With an empty `.env` you get demo + fixture mode: the whole
slice is clickable, every state is reachable, and the UI says plainly that the data is sample data
and the wording is canned. That is deliberate — a stub presented as a real finding would be exactly
the fabricated answer this product exists to avoid.

```bash
npm test        # scoring port + embedding parity
npm run typecheck
```

---

## Switching fixture → live

Modes are inferred from which keys are present, one layer at a time. Copy `.env.example` to `.env`
and fill in as much as you have:

| You add | What goes live |
|---|---|
| `ANTHROPIC_API_KEY` | Real interpretation and explanation. Matches still come from fixtures. |
| `OPENAI_API_KEY` + `PINECONE_API_KEY` + `PINECONE_HOST` | Real retrieval against the senator's embedded record. |

`FIXTURE_MODE` / `DEMO_MODE` override the inference if you want to force either way.
`GET /api/health` reports which mode is actually running.

**Before trusting live retrieval, export the full Approved Taxonomy sheet** into
`packages/server/src/embeddings/taxonomy.json`. The committed file is a partial snapshot covering the
demo paths; see "Embedding parity" below for why it matters. The server prints a warning while it is
incomplete.

---

## Where things live

| What | Where |
|---|---|
| **Deterministic scoring** | `packages/server/src/scoring/` |
| ↳ the verdict table (WF10A port) | `scoring/deriveAlignment.ts` |
| ↳ vote patterns (WF11 port) | `scoring/votePattern.ts` |
| ↳ gates → dials → bands → ranked | `scoring/score.ts` |
| ↳ the WF11 scorer + null contract | `scoring/decisionScore.ts` |
| ↳ effort signals (app layer, never the pipeline) | `scoring/effortSignal.ts` |
| ↳ bill outcome + as-of discipline | `scoring/billOutcome.ts` |
| ↳ every tunable number | `scoring/config.ts` |
| **Relevance eval + gates** | `packages/server/src/evaluation/` |
| ↳ generated prompt (do not hand-edit) | `evaluation/relevancePrompt.ts` |
| ↳ its generator | `tools/extract-relevance-prompt.mjs` |
| **Sheet coordinates** | `data/sheets.ts` |
| **Tests** | `scoring/*.test.ts`, `embeddings/promiseEmbeddingText.test.ts` |
| **Embedding parity** | `packages/server/src/embeddings/promiseEmbeddingText.ts` |
| **Tool-use loop** | `packages/server/src/orchestrator/loop.ts` |
| **Prompts** | `packages/server/src/orchestrator/prompts.ts` |
| **Data seam** | `packages/server/src/data/` |
| **Shared types + voter vocabulary** | `packages/shared/src/index.ts` |

---

## The architecture, in one paragraph

The model interprets and explains. It never computes. When a query runs, the model classifies the
promise, judges which way each matched bill cuts on that promise's goal, and writes the plain-English
explanation — three things models are genuinely good at. Everything else is code: the verdict, the
confidence band, the ranking, and the gates are computed by a pure function in `scoring/`, and the
result the user sees is read from that function's output regardless of anything the model says
afterwards. That boundary is the product.

### Ported, not designed

`scoring/` is a **transcription** of the live n8n workflows (WF10A `Parse LLM Response`, WF11
`Compute Decision Score`, WF7a retrieval), not an implementation of a written spec. Three times the
spec and the running system disagreed, and the spec was wrong each time — see ADR-010
(`docs/adr/README.md`). Most
importantly:

**The verdict table is two-factor: bill effect × support. There is no stance term.** Stance is
already baked into ADVANCE/HINDER by the interpreting model; multiplying by it again inverts the
verdict for every "Opposed" promise (measured: 0% error on ADVANCE, 25% on HINDER). There is also no
Congressional Review Act special-casing — CRA disapproval resolutions are handled by the
interpretation step's ordering rule, and adding a code-level inversion would double-invert.
`score.test.ts` guards both.

### Embedding parity

Parity is not just "same model, same dimensions". The stored bill vectors are searched by a query
vector built from a **structured template**, and a bare user sentence lands elsewhere in the space —
degrading matches silently, with no error. `promiseEmbeddingText.ts` ports WF7a's template verbatim.

Note there are **two** promise templates live: the one that builds the `_statements` vectors and the
one WF7a uses to query `_bills`. They differ (`Promise:` vs `Statement:`, no `Statement Type:` line,
`Related Terms:` vs `Taxonomy Keywords:`). Receipts searches bills, so it uses WF7a's. Don't unify
them.

Taxonomy keywords are a **sheet lookup**, never model output — that's why the snapshot matters.

---

## Honest states

Every one of these is an answer, not an error screen:

| State | When |
|---|---|
| `NOT_DETERMINABLE` · not evaluable | The promise is too vague to name a checkable commitment |
| `NOT_DETERMINABLE` · no matches | Nothing in the analyzed record relates to it |
| `NOT_DETERMINABLE` · below floor | Related legislation exists, none close enough to count |
| `NOT_DETERMINABLE` · all neutral | The bills found don't move the goal either way |
| `NOT_DETERMINABLE` · procedural switch | Sponsored the bill, then voted against it (Senate Rule XIII) |
| Ranked verdicts | Evidence genuinely conflicts — both sides shown, High capped to Medium |
| Uncached senator | Not analyzed yet; the request is logged as a demand signal |
| Error | Structured, with retry; nothing partial is rendered |

Two vocabulary rules are enforced in code and tested: **no statistics at Level 1**, and **no motive
language** anywhere. A senator who sponsored a bill and then didn't vote gets "did not cast a vote
when it came to the floor" — illness, a family emergency and strategy are indistinguishable in this
data, so we describe the behaviour and stop.

---

## Deploying

The backend is an ordinary stateless Node service — that was the point of choosing Messages API tool
use over the Agent SDK (ADR-008, `docs/adr/README.md`). Front end → Vercel. Backend → any small host, but **check the
function timeout against SSE duration**: a live query streams for as long as the loop runs, and a
short serverless timeout will cut it off mid-stream. Render/Railway/Fly are the safe fallback.

Keys stay server-side. The browser only ever talks to `/api`.

---

## Pipeline reconciliation log

The ported modules are transcriptions of live n8n nodes and need re-reading
whenever the pipeline moves. The log lives in **[docs/RECONCILIATION.md](docs/RECONCILIATION.md)**;
the source specs are in [docs/specs/](docs/specs/).

Where a spec and a live node disagree, the node wins — that has now happened
five times, and every one of them would have shipped a wrong number.

## Known gaps

1. **`embedding_version`** — WF7a scopes bill vectors to one batch `run_id`. A live query has no run
   to scope to, so the filter is opt-in via `PINECONE_EMBEDDING_VERSION`. Unset searches all
   versions and may match vectors from superseded runs.
2. **`cloture_vote` / `passage_vote` may be `'NA'`** in current bill vectors — the bill-embedding
   step wasn't writing them as of 2026-08-07. If so, vote-pattern detail degrades to `PASSAGE_ONLY`
   and the cloture/passage narrative goes quiet. Verify against real data.
3. **The relevance gate is present but not wired.** `evaluation/relevance.ts`,
   `evidenceGate.ts` and `gates.ts` are installed and typechecking, but the orchestrator loop does
   not call them yet, so nothing currently excludes a `DIRECTIONAL` match. Until it does, the tool
   can surface a pairing the pipeline would have rejected.
4. **`HIGH_AVG_STRENGTH` (0.65)** is a presentation-layer default with no pipeline equivalent, not a
   calibrated value. It moves the High/Medium boundary.
5. **Term separator** in the embedding text (`", "`) is an assumption about how the upstream sheet
   serialises keyword arrays. First thing to check if live matches come back thin.
6. **Taxonomy snapshot is partial** — six rows, not the full 23/121.
