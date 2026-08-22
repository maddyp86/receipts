# Architecture Decision Records — reconstructed index

## Status of this file: RECONSTRUCTED, not recovered

The original ADR documents **do not exist in this repository and were never
committed to it**. Six ADRs are cited by code comments, by `README.md` and by
`docs/RECONCILIATION.md`; a search of the full tree and of git history finds no
`adr/` directory and no ADR file of any name.

What follows is reconstructed on 2026-08-19 **from the citation sites
themselves** — that is, from what the code asserts the decision was. Each entry
records the decision as the code states it and names every place that cites it.

**This is not the original rationale.** The alternatives that were weighed, the
evidence behind each choice, and any consequences the author recorded are lost.
Where a citation promised detail the code does not restate, that is marked
**LOST** rather than guessed at. Do not cite these entries as though they were
the originals; treat them as a map of which decisions are load-bearing and where
they are relied on.

If the original documents exist outside the repo, replacing this file with them
is strictly better than extending it.

---

## ADR-004 — Two-speed coverage, with demand capture

**Decision.** A small, known set of senators is pre-analysed and answers
instantly; every other senator is reported as honestly uncached, and the
unanswered query is recorded as a demand signal rather than discarded.

The cache is deliberately a hardcoded map rather than a lookup against a roster
API: the point of MVP coverage is that it is small, known, and truthfully
labelled in the UI. Demand capture is deliberately a local append-only log — no
queue infrastructure, no email capture, no orchestrator trigger — with the same
interface intended to point at Supabase and the n8n per-senator orchestrator run
when it graduates.

**Cited by:** `packages/server/src/data/SenatorCache.ts:4`,
`packages/server/src/data/QueueStore.ts:5`

**LOST:** the coverage threshold rationale — why *these* senators, and what
volume of demand signal would justify analysing another.

---

## ADR-005 — Query time never re-embeds or re-analyses a bill

**Decision.** Receipts searches vectors the batch pipeline already produced. It
never re-embeds or re-analyses a bill at query time. This is what keeps a query
result from contradicting the senator profile built by the pipeline.

Corollary, stated at the citation site: retrieved metadata is read defensively —
a field that should be present and isn't is recorded in `missing_fields` and
surfaced, never quietly defaulted into a value that looks like evidence.

**Cited by:** `packages/server/src/data/PineconeActionStore.ts:11`

---

## ADR-008 — A workflow, not an autonomous agent

**Decision.** The orchestration is a fixed sequence over data already held, so a
Messages API tool-use loop is the right-sized primitive and deploys anywhere. It
is hand-rolled rather than built on the Agent SDK's tool runner, because the
project owns the wire format to the browser and wants no beta dependency on what
will be an ordinary stateless function.

Load-bearing corollary: **what the model streams is narration.** The verdict the
user sees is read from the deterministic service's output regardless of what the
model says.

**Cited by:** `packages/server/src/orchestrator/loop.ts:12`, `README.md:139`

---

## ADR-009 — One data seam for every record read

**Decision.** Every read of a senator's legislative record goes through the
`ActionStore` interface, so today's Pinecone implementation (and the fixture
stand-in) can be replaced by Supabase later without touching a single call site.

**Cited by:** `packages/server/src/data/ActionStore.ts:8`

---

## ADR-010 — Scoring modules are transcriptions, not implementations

**Decision.** The modules under `packages/server/src/scoring/` and
`embeddings/` are transcriptions of live n8n nodes, not independent
implementations. They must be re-read whenever the pipeline moves. Where a spec
and a live node disagree, **the node wins** and the disagreement is logged in
`docs/RECONCILIATION.md`.

The stated basis: the written spec and the running system disagreed repeatedly,
and the spec was wrong each time. Two copies of the scorer would let the query
tool and the trust report print different numbers for the same senator on the
same bill.

**Cited by:** `packages/server/src/scoring/deriveAlignment.ts:13`,
`docs/RECONCILIATION.md:4`, `README.md:89`

**This is the one ADR whose practice is fully documented elsewhere** — the
reconciliation log is its living record.

---

## ADR-011 — Scored as behaviour, described as behaviour

**Decision.** A recorded "Not Voting" is an abstention and outranks sponsorship
in the action-tier ordering: showing up to sponsor a bill and then not casting
the recorded vote on it is not evidence of effort.

**Cited by:** `packages/server/src/scoring/votePattern.ts:107`

Verified 2026-08-19: this ordering matches the live WF11 node.

---

## SCORING_REFERENCE.md — partially superseded, partially LOST

No such file exists. Two sections are cited:

| Citation | Subject | Resolution |
|---|---|---|
| §3, from `deriveAlignment.ts:12` | the alignment table | **Superseded.** The same table is in `docs/specs/wf10a-wf11-method-spec.md` **§6 — STEP 3 Verdict**, including the no-double-stance rule. Citation updated to point there. |
| §5, from `scoring/config.ts:12` | confidence bands | **LOST.** The method spec does not mention confidence bands anywhere — they are a Receipts presentation-layer invention with no pipeline equivalent. The substance survives only as the inline documentation in `scoring/config.ts` and the `bandFor()` docblock in `scoring/score.ts`. `HIGH_AVG_STRENGTH` remains uncalibrated. |
