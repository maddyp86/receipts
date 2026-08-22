# Receipts — Product Case Study

**Matt Hall · AI Product Manager**
*An AI accountability tool that checks whether a U.S. senator kept a campaign promise — matched, in real time, against their actual legislative record.*

---

**Role.** Sole product lead and builder — problem framing, product strategy, system architecture, and hands-on build (LLM orchestration, retrieval pipeline, scoring logic, front end).

**Context.** Part of a larger civic-tech platform that scores political trustworthiness by comparing what politicians *say* against how they *vote*. I own the product end to end, from data pipeline to user-facing experience.

## Problem

Voters have no fast, personal way to check whether a specific politician followed through on a specific promise. Existing fact-checkers are editorially curated, slow, and not queryable in a voter's own words. Our own comprehensive "scorecard" answered this well but was expensive to produce — it required gathering each politician's full promise history up front — and answered questions the user never asked. The highest-intent moment ("did *my* senator actually do this?") went unserved.

## Approach

I inverted the model. Instead of building politician profiles top-down, I let the **user supply the promise** in plain language and matched it against legislative behavior we'd already analyzed — removing the corpus-gathering bottleneck entirely and turning the casual lookup into the consumer front door that funnels into the deeper analyst view.

Under the hood it's a retrieval-and-reasoning system: the user's promise is embedded and semantically matched against a vector index of the senator's bills; matched actions feed a scoring step that returns a verdict, a confidence signal, and the underlying evidence with source links. An LLM interprets the input and explains the result in plain language; the reasoning streams to the user as it works, which doubles as the product's traceability.

## Key product decisions

- **I drew a hard line on where the model is allowed to decide.** The LLM interprets and explains, but it never computes the verdict — a deterministic rule engine owns the score and label. This "narration ≠ computation" boundary is what makes the output auditable rather than a black box, which is the entire value proposition of an accountability tool.

- **I right-sized the architecture instead of chasing the buzzword.** I evaluated the agentic SDK the market keeps asking for, recognized my use case is a *workflow* (a fixed, single-turn tool-use loop over existing data) rather than an autonomous *agent* that needs a live environment, and built on the lighter primitive. Same experience, far simpler to deploy, no complexity I couldn't justify.

- **I turned a cost constraint into a product mechanic.** Rather than pre-analyze every politician, I cache a few and queue the rest on demand — so an unanswered query becomes a demand signal that tells us exactly where to spend analysis budget next.

- **I designed for honesty over false precision.** When the evidence is thin, the tool says so ("not determinable") instead of forcing a verdict; when a record is genuinely mixed, it surfaces *ranked* verdicts showing both sides rather than hiding the conflict. Confidence is shown to voters in plain language, with the statistics available on drill-down for analysts.

- **I built for evolution.** The live tool reuses the existing batch pipeline rather than duplicating it, so the query result can never contradict the deeper profile; data access sits behind a seam so the storage layer can migrate without a rewrite.

## Outcome & status

A working research prototype that validates the core hypothesis: a voter can express a promise in natural language and get a traceable, evidence-backed answer in seconds. The framework holds end-to-end — interpretation, retrieval, deterministic scoring, and plain-language explanation — against a live senator's record, and the demand-driven model gives a clear, low-cost path to scale coverage based on real user interest.

## What it demonstrates

Product judgment about AI systems specifically: knowing where to apply model autonomy and where to withhold it, right-sizing agentic complexity to the problem, and treating trust and explainability as first-class product requirements rather than afterthoughts.

---

*Prototype and full product/architecture documentation available on request.*
