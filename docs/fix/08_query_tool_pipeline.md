# 08 — Receipts query tool: same components, per request

The query tool does not look the statement up. It takes what the user typed and evaluates it. That means the statement side has no `Date`, no `Scope`, no `Role Condition` unless the pipeline produces them at request time. Everything else is identical to the batch path, and should literally be the same code.

## Per-request flow

```
user text (+ optional date, politician)
   │
   ▼
1. Statement Scope Classifier  (file 01: same Haiku prompt + same post-check)
   → speech_act, scope, valid_until, anchor_entity, role_condition
   │
   ├─ speech_act ∈ {OPERATIONAL, CREDIT_CLAIM, RHETORIC}
   │     → respond: "This is a [scheduling / credit-claiming / rhetorical] statement.
   │        No vote or sponsorship can fulfil or break it. The underlying position
   │        appears to be: <one-line restatement>. Evaluate that instead?"  STOP.
   ├─ scope = BOUNDED and valid_until = UNKNOWN
   │     → respond: ask for the date the statement was made.  STOP.
   ▼
2. Statement embedding (v6, same text template as WF7a Promise Embedding Text)
   → Pinecone query, namespace {politician}_bills, topK 10, no run_id filter
   │
   ▼
3. Relevance (WF7b prompt v4, same SYSTEM string, same thresholds)
   → keep TRUE_POSITIVE; keep PARTIAL only if subtype ∉ {DIRECTIONAL, DATED_VEHICLE, AMBIGUOUS}
   │
   ▼
4. Enrichment from the evidence layer (Supabase, mirrors WF10a's joins)
   → cloture/passage votes + dates, whip vote, party alignment, cloture result,
     senator role at action date, bill class, impact analysis, reversal target
   │
   ▼
5. Pre-Evaluator Gates  (file 03, verbatim — port the function, not the n8n plumbing)
   → gated rows are DISPLAYED with their gate reason, not hidden.
     "Not evaluated: leader procedural vote" is useful to the user.
   │
   ▼
6. Evaluator v7  (file 07, same system prompt, same payload shape)
   + deriveAlignment (file 06) for the verdict
   │
   ▼
7. Response assembly — evidence first, verdict second
```

## Response shape

```json
{
  "statement": { "text": "...", "speech_act": "COMMITMENT", "scope": "STANDING", "anchor_entity": "", "role_condition": "NONE" },
  "evidence": [
    {
      "bill_id": "sjres7-119", "title": "...", "congress": 119, "bill_class": "REVERSAL",
      "action": { "cloture": null, "passage": "YEA", "passage_date": "2025-05-08", "sponsor": false, "cosponsor": true },
      "party_context": { "whip_vote": "Yea", "alignment": "WITH_PARTY", "senator_role": "MAJORITY_LEADER" },
      "gate": null,
      "reading": { "bill_effect": "HINDER", "verdict": "BROKE", "confidence": 0.65, "governing_vote": "PASSAGE",
                   "reasoning": "...", "counterargument": "...", "flags": [] },
      "sources": { "roll_call": "s238-119.2025", "bill_url": "...", "impact_uid": "I11FY5" }
    },
    {
      "bill_id": "s4784-119", "title": "...", "bill_class": "BROAD_VEHICLE",
      "action": { "cloture": "NAY", "cloture_date": "2026-07-14", "passage": null },
      "party_context": { "whip_vote": "Yea", "alignment": "LEADER_SWITCH", "senator_role": "MAJORITY_LEADER" },
      "gate": { "verdict": "PROCEDURAL_SWITCH", "reason": "Majority leader voted NAY on cloture while the whip voted YEA ..." },
      "reading": null
    }
  ],
  "summary": {
    "evaluated": 1, "gated": 1,
    "reading": "1 related action appears to run against this statement (confidence 0.65). 1 action was procedural and not counted.",
    "disclosure": "Readings are generated from bill impact analyses and roll-call records; see each item's counterargument."
  }
}
```

Rules for the surface:
- Every `BROKE`/`INCONSISTENT` reading must have a non-empty `counterargument` before it renders. If the model didn't supply one, downgrade to NOT_DETERMINABLE and say the reading was withheld.
- Split votes always show both votes and `governing_vote`.
- Gated items are shown with their reason. They are the thing that makes the tool look honest.
- No aggregate score. `summary.reading` is one sentence of counts.

## What the evidence layer must expose (Supabase `app` schema)

Currently missing for the query path, all present in Sheets:
- `roll_call_votes.result` (Agreed/Rejected) — needed by G3
- `politicians.role_by_congress` — needed by G1c and G3
- `promise_matches.temporal_reference`, `.partial_subtype` (after file 02)
- `bill_impacts.bill_class` (derive at load with the regex in file 03)
- `bill_impacts.text_version_used` (after the regen in plan Step 6)

## Rate limiting and cost note

The per-query cost is: 1 Haiku (scope) + up to 10 GPT-5.4-mini relevance + up to ~5 evaluator calls. Cache the scope classification by normalized statement text; cache relevance by (statement hash, bill_id). Two repeat queries about the same statement should cost one evaluator pass, not three.
