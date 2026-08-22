# Query Tool — Evaluation Workflow Build Spec

For the on-demand promise query tool. A user supplies arbitrary promise or
policy text plus a target senator; the tool retrieves that senator's bill
actions, evaluates the pairing, and returns a verdict with a breakdown.

This is the **P2B path run once, synchronously, for a promise that is not in
the corpus.** It reads nothing from `Promise Alignment - Matches` and writes
nothing to the trust index.

Companion documents: `wf10a-wf11-method-spec.md` (how a verdict and score are
produced) and `app-query-tool-context.md` (what the output may claim).

---

## 1. Two findings that shape everything

### 1.1 The query embedding must be built exactly like a corpus promise embedding

`Promise Embeddings` (`ibhoY5j8ooe26a7r`) constructs a structured document, not
raw text:

```
Statement: {text}

Statement Type: {Campaign Promise | Policy Position}

Stance: {In Favor | Opposed | Neutral/Unclear}

Promise Type: {policy | process | rhetorical | non_legislative}

Primary Issue: {taxonomy}

Sub-Issue: {taxonomy}

Key Policy Terms: {comma list}

Taxonomy Keywords: {from Approved Taxonomy}

Reasoning: {classifier reasoning}
```

`text-embedding-3-small`, **1024 dimensions**.

⚠ Embedding raw user text instead would put the query vector off-distribution
relative to every bill vector it is compared against. Similarity scores would
not be comparable to the 0.575 / 0.60 thresholds the pipeline is calibrated on,
and the STRONG/WEAK bands would mean nothing.

**Therefore classification must run BEFORE embedding**, because five of the nine
lines come from the classifier.

### 1.2 The classifier does not emit `Statement Type`

`Promise Statement Evaluation & Classification` (`IVUmoD8pG4E5M8D0`, Claude
Haiku 4.5) returns:

```json
{ "primary_issue", "sub_issue", "stance", "promise_type",
  "is_evaluable", "key_policy_terms", "reasoning" }
```

`Statement Type` (Campaign Promise vs Policy Position) comes from source
provenance in the corpus — a campaign speech versus a press release. **User text
has no provenance.**

It matters: it selects the verdict vocabulary (`KEPT`/`BROKE` vs
`CONSISTENT`/`INCONSISTENT`) and carries a −0.1 confidence penalty.

**Recommendation: default to `Policy Position`.** It is the weaker commitment
standard, it yields the more defensible vocabulary for arbitrary user text, and
it applies the confidence penalty. Optionally let the user assert "this is
something they promised" and switch to `Campaign Promise` — but never infer it
from the text.

---

## 2. Flow

```
Webhook (promise_text, politician_id)
  │
  ├─ 1  Load Taxonomy                 Approved Taxonomy → formatted string
  ├─ 2  Classify Statement            Claude Haiku 4.5, WF3 prompt
  ├─ 3  Evaluability Gate             is_evaluable false → early return
  ├─ 4  Build Embedding Text          exact Promise Embeddings v6 format
  ├─ 5  Embed                         text-embedding-3-small, 1024 dims
  ├─ 6  Query Pinecone                {politician_id}_bills, topK 10
  ├─ 7  Assert Candidates             zero → "no legislative activity found"
  ├─ 8  Enrich Candidates             impact statements, actions, votes, donors
  ├─ 9  Relevance Eval                W7b prompt, per candidate
  ├─ 10 Evidence Gate                 TRUE_POSITIVE + PARTIAL/SPECIFICITY
  ├─ 11 Fulfillment Eval              WF10A prompt, per accepted candidate
  ├─ 12 Derive Verdict                deriveAlignment — CODE
  ├─ 13 Compute Score                 Compute Decision Score — CODE
  └─ 14 Assemble Response             effort signals, bill status, caveats
```

Steps 12 and 13 are **pure functions with no I/O**. Port them to app code rather
than forking the n8n nodes — see §6.

---

## 3. Step detail

### 1 · Load Taxonomy
Read `Approved Taxonomy` (`<TAXONOMY_SHEET_ID>`, gid
`1287072268`) and format as the classifier expects. Cache it — it changes rarely
and re-reading per query is wasted latency.

### 2 · Classify Statement
Reuse the WF3 Claude prompt verbatim. Inputs: the user's text plus the formatted
taxonomy. Set `PSU_ID` to a generated query ID.

### 3 · Evaluability Gate
`is_evaluable: false` → return immediately with the classifier's `reasoning`:

> *"This statement cannot be evaluated against legislative activity because it
> does not name a policy mechanism, bill, agency action, or measurable
> commitment."*

Also stop on `promise_type` of `rhetorical` or `non_legislative`, and on
`stance` of `Neutral/Unclear` — the same three gates WF10A applies. **Catching
these before retrieval saves ~20 LLM calls on input that can never produce a
verdict.**

### 4 · Build Embedding Text
Byte-identical to `Build Promise Embedding Text` in `ibhoY5j8ooe26a7r`. Same
field order, same blank-line separators, same omission of empty lines.
`Taxonomy Keywords` comes from the Approved Taxonomy row matching
`primary_issue` + `sub_issue`.

### 5 · Embed
`POST https://api.openai.com/v1/embeddings`

```json
{ "model": "text-embedding-3-small", "input": "<pageContent>", "dimensions": 1024 }
```

### 6 · Query Pinecone
Index `your-index.svc.your-region.pinecone.io  # scrubbed — real host lives in PINECONE_HOST`, namespace
`{politician_id}_bills`, `topK: 10`, `includeMetadata: true`.

⚠ **The `embedding_version` filter.** W7a filters
`embedding_version = {run_id}` and a user query has no run_id. Pass the current
embedding run as a constant (`run-2026-08-08-10650` at time of writing) or drop
the filter. Dropping it returns duplicates if a namespace ever holds two
generations; hard-coding it silently returns **zero** results after the next
re-embed. Prefer a config value with an assertion on the result count.

### 7 · Assert Candidates
Zero candidates → return *"no matching legislative activity found for this
senator."* Never return an empty verdict. This is the failure that looks like
success.

### 8 · Enrich Candidates
Impact statement (including `Target Name` / `Target Source` / `Target Effect`),
bill action (`Vote`, `Cloture Vote`, `Passage Vote`, `Is Sponsor`,
`Is Co-Sponsor`), party alignment, donor alignment, stakeholder impacts.

⚠ **WF10A does roughly ten sheet reads per row.** Doing that per query, against
Sheets, with concurrent users, contends with pipeline drains on the same
~300 requests/minute project quota. **Use a read replica** — Postgres or a
nightly-materialised cache. The LLM steps stay in n8n; enrichment becomes one
query.

### 9 · Relevance Eval
W7b's v3 system prompt (13,740 chars, `promptCacheKey: match-eval-v3`) per
candidate. Threshold: STRONG at ≥ 0.575.

### 10 · Evidence Gate
Admit `TRUE_POSITIVE` and `PARTIAL` where the subtype is `SPECIFICITY`. Exclude
`DIRECTIONAL`. Route `AMBIGUOUS` and `UNCLASSIFIED` out. Same rules as WF10A's
`Dedupe Accepted Matches`.

### 11 · Fulfillment Eval
WF10A's system prompt (~30k chars, `promise-alignment-v5`). The model returns
`bill_effect` and reasoning only.

### 12–13 · Derive and Score — CODE, NOT LLM
`deriveAlignment` then `Compute Decision Score`. The LLM's own verdict is kept
as a drift signal and never applied. Measured basis: 18% error on a six-row
lookup at temperature 0.

### 14 · Assemble Response
Group by effort signal, join `Bills Master` for current status, attach
`Status Checked At`, state the denominator. See
`app-query-tool-context.md` §5–8.

---

## 4. Latency

Per query at topK 10:

```
classify        1 call    ~2s
embed           1 call    ~0.5s
relevance      10 calls   ~4s each  sequential = 40s
fulfillment    ≤10 calls  ~4s each  sequential = 40s
                                    ────────────
                                    ~80s worst case
```

**Not viable synchronously.** Options, in order of preference:

1. **Parallelise both loops.** They are independent per candidate. Cuts to
   ~10–15s.
2. **Batch relevance.** One call judging all 10 candidates. Untested against the
   v3 prompt, which is written for one pairing — would need re-validation.
3. **topK 5.** Halves cost; loses recall on a leg already measured at ~50%.
4. **Async with polling.** Webhook returns a job ID, client polls.

Recommend 1 plus 4 as a fallback for slow cases.

---

## 5. Assertions

Each of these has a real precedent in the pipeline.

| Point | Assert | Precedent |
|---|---|---|
| After classify | all six fields present | classifier returning partial JSON |
| After embed | vector length 1024 | dimension mismatch fails at query, not embed |
| After Pinecone | candidates > 0, else explicit message | empty read → silent success |
| After enrichment | every candidate has an impact statement | `keepMatches` merge drops rows |
| After relevance | admitted ≤ candidates | dedup errors |
| After derive | verdict in the known vocabulary | new labels leaking through |
| Before response | `decision_score` null ⇒ `scorable` false | frozen rows scored as 0.0 |

---

## 6. Reuse vs rebuild

| Component | Approach | Why |
|---|---|---|
| Classifier prompt | **share the string** | 18k chars; two copies will drift |
| Relevance prompt | share | already cost a session when duplicated |
| Fulfillment prompt | share | 30k chars |
| Embedding text builder | **port** | ~40 lines, must stay byte-identical |
| `deriveAlignment` | **port to app** | pure function, no I/O |
| `Compute Decision Score` | **port to app** | pure function, ~20k chars |
| Effort signal | app code | already the plan |
| Retrieval + enrichment + 3 LLM calls | new workflow | the only part needing n8n |

⚠ **Do not fork WF10A or WF11.** Two copies of the scorer means the app and the
trust report can give different numbers for the same senator — the one
inconsistency a fact-checking product cannot survive. The two scorers are pure
JavaScript; porting them gives one canonical definition with a shared test
suite.

The prompts are the live drift risk. Whatever the mechanism — shared file,
config record, fetch at runtime — **one source**.

---

## 7. What this tool must not do

- **Write to any pipeline sheet.** No `Promise Alignment - Matches`, no
  `Decision Scores`, no `Promise Matches`. Read-only against the corpus.
- **Contribute to the trust index.** A user query is not evidence about a
  senator; it is a lookup.
- **Reuse a corpus `run_id`** for anything that writes.
- **Present a verdict without its reasoning string.** Traceability is the
  product.
- **Claim intent.** Every verdict is about recorded behaviour.

---

## 8. Known limits to surface in the UI

- **Retrieval coverage ~48–52%.** Absence of matched evidence is not evidence of
  inaction. Say so explicitly on low-result queries.
- **`NOT_DETERMINABLE` runs 4–17%.** Render as "no clear signal", never as
  neutral and never as a broken promise.
- **Sponsorship-tier scores rest on six unvalidated base numbers**, and
  sponsorship is ~82% of the corpus.
- **Reversal bills with vacuous `Target Effect` are ~50% reliable.** The column
  shows what the reasoning was based on — surface it.
- **Bill status is refreshed weekly**, and 118th-congress bills are not
  re-scraped upstream at all. Always show `Status Checked At`.
- **The user's text is classified, not verified.** A misclassified stance
  inverts the verdict. Show the classifier's `stance`, `promise_type` and
  `reasoning` so the user can see what was assumed, and let them correct it.

That last point is the biggest difference from the pipeline. Corpus promises
were classified once and reviewed. A user query is classified on the fly with no
review step, and **the classification is load-bearing** — `stance` is baked into
`Bill Effect` at STEP 1, so getting it wrong inverts the answer. Make it visible
and correctable rather than silent.
