# Promise Query Tool — Thread Context

Everything needed to continue building the query tool in a fresh thread.

**This document CORRECTS `query-tool-build-spec.md` §1.1, §3.4 and §3.5.** Where
they disagree, this one is right — see §2.

---

## 1. What the tool is

A user supplies arbitrary promise or policy text plus a target senator. The tool
retrieves that senator's bill actions, evaluates the pairing fresh, and returns
a verdict with a breakdown.

**Fresh evaluation, not resolution.** It embeds the user's text, queries
`{politician_id}_bills`, and runs relevance + fulfillment evaluation on the
retrieved bills. It does NOT look up a pre-computed verdict from
`Promise Alignment - Matches`.

Why: resolution can only answer about promises the senator actually made. Ask
about crypto when Schumer never said anything on crypto and you get "not
tracked." Fresh evaluation answers any policy query by measuring his legislative
record against the user's text.

**Consequence:** the relevance evaluation and the `DIRECTIONAL` evidence gate
both need building. There are no pre-computed alignment rows in this path.

**It is read-only against the corpus.** It writes to no pipeline sheet, and it
never contributes to the trust index.

---

## 2. ⚠ CORRECTION — the embedding template

`query-tool-build-spec.md` §1.1 and §3.4 name **`Build Promise Embedding Text`**
from `Promise Embeddings` (`ibhoY5j8ooe26a7r`). **That is wrong.**

That node upserts to `{pid}_statements`, which exists for the OPPOSITE
direction: B2P embeds a *bill* and queries the *promise* namespace.

The query tool queries `{pid}_bills`, which is what **W7a's
`Promise Embedding Text`** (`UOpu690tosAwbvMB`) does. Use that template:

```
Promise: {text}

Stance: {In Favor | Opposed | Neutral/Unclear}

Promise Type: {policy | process | rhetorical | non_legislative}

Primary Issue: {taxonomy}

Sub-Issue: {taxonomy}

Key Policy Terms: {comma list}         ← omitted if empty

Related Terms: {taxonomy keywords}     ← omitted if empty

Reasoning: {classifier reasoning}      ← omitted if empty
```

Joined with `\n\n`, empty lines filtered out. `text-embedding-3-small`,
**1024 dimensions**.

Differences from the v6 template the spec wrongly named: `Promise:` not
`Statement:`, **no `Statement Type:` line at all**, and `Related Terms:` not
`Taxonomy Keywords:`.

**This matters because `STRONG_THRESHOLD = 0.575` was calibrated in W7a's
`Parse and Store Matches` against queries built with W7a's builder.** Using a
different template would put the query vector off-distribution and the threshold
would mean nothing. Claude Code caught this and ported W7a's — correct.

---

## 3. Flow

```
Webhook (promise_text, politician_id)
  │
  ├─ 1  Load Taxonomy          Approved Taxonomy → formatted string (cache it)
  ├─ 2  Classify Statement     Claude Haiku 4.5, IVUmoD8pG4E5M8D0 prompt
  ├─ 3  Three gates            evaluability / promise_type / stance → early return
  ├─ 4  Build Embedding Text   W7a template — see §2
  ├─ 5  Embed                  text-embedding-3-small, 1024 dims
  ├─ 6  Query Pinecone         {politician_id}_bills, topK 10
  ├─ 7  Assert Candidates      zero → "no legislative activity found"
  ├─ 8  Enrich Candidates      impact statements, actions, votes, donors, party
  ├─ 9  Relevance Eval         W7b v3 prompt, per candidate
  ├─ 10 Evidence Gate          TRUE_POSITIVE + PARTIAL/SPECIFICITY only
  ├─ 11 Fulfillment Eval       WF10A prompt, per accepted candidate
  ├─ 12 Derive Verdict         deriveAlignment — CODE, ported
  ├─ 13 Compute Score          Compute Decision Score — CODE, ported
  └─ 14 Assemble Response      effort signals, bill status, caveats
```

### Pinecone

```
host       your-index.svc.your-region.pinecone.io  # scrubbed — real host lives in PINECONE_HOST
namespace  {politician_id}_bills
topK       10
filter     embedding_version == {run_id}
```

⚠ `embedding_version` is currently **`run-2026-08-08-10650`**. Make it a config
value with an assertion on result count, never a hard-code — after the next
re-embed a stale constant returns zero results and looks exactly like "this
senator has no relevant bills." W7a has a TOTAL MISS guard for precisely this;
it fired on execution 10597 when a leading space in the run_id wrote 27 false
"no matching bill" verdicts.

### Classification

`IVUmoD8pG4E5M8D0` → `Evaluate and Classify PSU Statement (Claude)`, Claude
Haiku 4.5, ~18k prompt. Returns:

```json
{ "primary_issue", "sub_issue", "stance", "promise_type",
  "is_evaluable", "key_policy_terms", "reasoning" }
```

⚠ **It does not return `Statement Type`.** See §4.

Three gates fire before retrieval, mirroring WF10A:
- `is_evaluable: false` → return with the classifier's reasoning
- `promise_type` in `rhetorical` / `non_legislative` → NOT_APPLICABLE
- `stance` = `Neutral/Unclear` → no direction to honour or contradict

Catching these pre-retrieval saves ~20 LLM calls on input that can never produce
a verdict.

---

## 4. Statement Type — resolved

The corpus gets it from source provenance (campaign speech vs press release).
User text has none.

**Default to `Policy Position`** — weaker commitment standard, more defensible
for arbitrary input, carries the −0.1 confidence penalty. Optional user
override. Never infer it from the text.

**Vocabulary reconciliation (Claude Code's proposal, confirmed):** keep the
internal vocabulary as the pipeline emits it (`CONSISTENT` / `INCONSISTENT`) and
render alignment language in the UI — *"His record is consistent with this
position"* rather than *"Kept."*

That also delivers the framing requirement structurally: the output stops
claiming promise-keeping on a promise he may never have made.

⚠ **This is the single biggest liability in the product.** Fresh evaluation will
produce a verdict on a policy the senator never promised anything about. If the
UI asks "Did he keep this promise?" that reads as a broken promise on a
commitment he never made — defamatory-adjacent. Frame every output as *"how his
legislative record aligns with this position."*

---

## 5. Already built (Claude Code, verified against live nodes)

- **`scoring/decisionScore.ts`** — WF11 port. Base rows by action tier × party ×
  donor, eight pattern multipliers, additive modifiers with thresholds (donor at
  ≥5 / ≥10), specificity ×0.85, low-confidence ×0.8, clamp [−2.0, 1.5]. Null
  contract implemented: frozen rows emit `decision_score: null` +
  `scorable: false`, never 0.0. `summariseScores()` means over scorable rows
  only, returns the denominator, with a test asserting the naive
  "count-frozen-as-zero" average differs.
- **`scoring/effortSignal.ts`** — seven additive signals. `BLOCKED_OPPOSITION`
  labelled by effect, raw NAY still in the detail. Procedural-switch note stops
  at "this pattern is typically a procedural maneuver" and never claims intent.
- **`scoring/billOutcome.ts`** — prefix-matched status vocabulary (unmodified
  scraper strings), vote-field fallback, `statusWithAsOf()` has no undated
  overload.
- **Embedding text builder** — ported from W7a. Correct per §2.

67 tests passing, both packages typechecking. The method spec's worked example
reproduces exactly (base 0.9 + 0.05 × 1.15 = 1.09).

---

## 6. Still to build

1. **Relevance eval + `DIRECTIONAL` evidence gate** — back on the list; there
   are no pre-computed alignment rows in this architecture
2. **The three pre-retrieval gates**
3. **Correctable-classification UI** — see §7
4. **Parallelise the two LLM loops** — sequential is ~80s per query, not viable
5. **Read layer** — see §8

---

## 7. The classification is load-bearing and unreviewed

Corpus promises were classified once and reviewed. A user query is classified on
the fly with no review step.

`stance` is baked into `Bill Effect` at STEP 1 of the fulfillment prompt. **A
misclassified stance inverts the verdict.**

Show the classifier's `stance`, `promise_type` and `reasoning` in the UI and let
the user correct them. Visible and correctable, not silent.

---

## 8. Read layer

The tool reads:

```
Bills Master              status, congress, bill type/base, Status Checked At
Impact Statements         summary, mechanisms, regulatory_action fields
Politician Bill Actions   votes, cloture, passage, sponsorship
Donor Alignments          donor context
Party Vote Positions      whip positions
Approved Taxonomy         classifier input
```

NOT `Promise Alignment - Matches`, NOT `Decision Scores`.

⚠ **Sheets is a poor query backend.** WF10A does ~10 sheet reads to assemble one
row; per query, with concurrent users, that contends with pipeline drains on the
same ~300 requests/minute project quota. Target a read replica (Postgres or a
nightly cache). Keep a store seam so live is a config swap.

**Bill status is a live join on `Bill ID`, never stored on a cached row** — the
alignment tabs are append-only, so a stored snapshot would freeze at evaluation
time and defeat the weekly WF2b refresh. Always render with `Status Checked At`.

---

## 9. n8n is read-only for the app builder

Claude Code reports and proposes; the pipeline owner applies. No
`update_workflow` calls against live production workflows.

The one edit `wf10a-wf11-method-spec.md` §12 names — adding bill status to
WF10A's writer — is **superseded**. Status is a live join, and this architecture
doesn't read alignment rows at all. No n8n edit needed.

---

## 10. Corpus facts

```
Schumer  S000148   ~1,862 evaluable statements
Thune    T000250   1,366 statements, 726 evaluated at last count
Bill vectors       ~1,100 action rows per senator in {pid}_bills
Retrieval coverage ~57% candidate, 48-52% effective
NOT_DETERMINABLE   4-17% depending on batch
```

---

## 11. Claims discipline

**Safe:** what the senator did (vote direction, cloture vs passage,
sponsorship); what the bill would do to the goal; why they combine to a verdict;
current bill status **with its as-of date**; the score **with its denominator**.

**Must be qualified:** `NOT_DETERMINABLE` → "no clear signal", never neutral and
never broken. Sponsorship-tier scores rest on six unvalidated base numbers, and
sponsorship is ~82% of the corpus. Reversal bills with vacuous `Target Effect`
are ~50% reliable. 118th-congress bills are not re-scraped upstream.

**Never:** claim intent; treat absence of matched evidence as inaction; render a
frozen or `PROCEDURAL_SWITCH` row as kept or broken; compare scores across
senators without stating both denominators; surface a verdict without its
reasoning string.
