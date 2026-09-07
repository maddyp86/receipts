# Claude Code handoff — port the WF10a fixes into Receipts

Context: the n8n pipeline (WF7a/WF7b/WF10a) evaluates senator statements against legislative actions. An audit found 78 of 79 BROKE verdicts were false positives. The fixes are now applied (partially) in n8n. The Receipts query tool (Express on Render, `https://receipts-65yk.onrender.com`, Supabase as `receipts_app`) runs the same evaluation on user-supplied statements and must carry the same logic. **Port, don't re-implement.** Every function below has a canonical source file; copy it and keep a comment pointing back to the file and date.

Source files are in `/mnt/user-data/outputs/` (and `fix/`).

## What to port, in order

### 1. Statement scope classification — `fix/01_statement_scope_classifier.md`
- System prompt → `prompts/scopeClassifier.v1.txt` (verbatim).
- Post-check function → `lib/scope/postCheck.ts` (verbatim JS, typed). Input: `{ text, date? }` + parsed LLM JSON. Output: `{ speechAct, scope, validUntil, anchorEntity, roleCondition, confidence, reasoning }`.
- Model: Claude Haiku 4.5, temperature 0. Cache by `sha256(normalizedText)`.
- Behaviour on the query path:
  - `speechAct ∈ {OPERATIONAL, CREDIT_CLAIM, RHETORIC}` → respond with the explanation in file 08 and stop. Do not retrieve.
  - `scope = BOUNDED` and `validUntil = UNKNOWN` → ask the user for the statement date and stop.

### 2. Pre-evaluator gates — `fix/03_wf10a_pre_evaluator_gates.js`
- Extract the per-row logic (everything inside the `for (const item of items)` loop plus the helpers and reference data) into `lib/gates/preEvaluatorGates.ts` as a pure function:
  `gate(row: EnrichedMatch, refs: { roleAt(pol, congress), rollCall(voteId) }) → { hits: GateHit[], context: EvaluatorContext }`.
- The n8n-specific `$('Get Statements')` / `$('Get Roll Call Votes')` / `$('Get Politician')` reads become Supabase lookups (see §6). Keep the fail-open behaviour and the reason strings exactly.
- Gated rows are **displayed** with `gate.verdict` and `gate.reason`, not dropped.

### 3. Party alignment — `fix/05_wf10a_compute_party_vote_alignment.js`
- `lib/votes/partyAlignment.ts`. Same vocabulary: `WITH_PARTY | CROSS_PARTY | LEADER_SWITCH | PROCEDURAL | NOT_VOTED | NA`.

### 4. Verdict derivation — `fix/06_wf10a_derive_alignment.js`
- `lib/verdict/deriveAlignment.ts` — the function body verbatim. Returns `{ verdict, governing, split }`.
- Confidence cap 0.75 on `split`. Never call the model's `promise_alignment` the verdict; it is `modelVerdict` for agreement tracking only.

### 5. Evaluator prompt v7 — `fix/07_wf10a_evaluator_prompt_v7.md`
- System prompt → `prompts/evaluator.v7.txt` (verbatim). User template → `prompts/evaluatorUser.v7.ts` rendering the same field order. Model gpt-5.4-mini via `/v1/responses`, `prompt_cache_key: 'promise-alignment-v7'`, reasoning enabled.
- Output parse must tolerate the `flags` array and `same_object` boolean.
- Do **not** pass the relevance step's reasoning into the evaluator payload.

### 6. Supabase — columns the gates read (add if missing; mirror Sheets)
```
roll_call_votes.results            text   -- 'Agreed to' / 'Rejected' / … (Sheets 'Results', column N)
politicians.role_by_congress       text   -- "MAJORITY_LEADER:119;MINORITY_LEADER:118"
promise_matches.temporal_reference text
promise_matches.anchor_vehicle     text
promise_matches.partial_subtype    text   -- now includes DATED_VEHICLE
bill_impacts.bill_class            text   -- derive at load: BROAD_VEHICLE | REVERSAL | TARGETED (regex in file 03)
bill_impacts.text_version_used     text   -- after impact regen
```
Evidence layer remains read-only to `receipts_app`; corpus firewall unchanged.

### 7. Response shape — `fix/08_query_tool_pipeline.md`
- Evidence first, reading second. A `BROKE`/`INCONSISTENT` reading renders only with a non-empty `counterargument`; otherwise downgrade to `NOT_DETERMINABLE` and say the reading was withheld.
- Split votes always show both votes and `governing_vote`.
- No aggregate score.

### 8. Per-query judge (optional for test env, required before public beta)
- Wire the deterministic gates (`fix/11_wf13_deterministic_gates.js`, per-row part) before render, and the LLM judge (`fix/12_wf13_judge_system_prompt.md`, Claude Sonnet 5) on any `BROKE`/`INCONSISTENT` reading. One retry with the critique block from `fix/09_wf13_verdict_judge_spec.md`; retries may only move away from an accusation. Log every judge call to a `verdict_audit_log` table with the columns in file 09.

## Acceptance
- Run the 79 rows from `wf10a_broke_gold_set.csv` through the query path (statement text + politician + date). Expected: 0 BROKE except row 2885 (SJRES7 / 7FBQ60I4), which must carry a counterargument and confidence ≤ 0.7.
- Run 30 voter-style claims (half easy, half contested) and record judge pass rate; target ≥ 90% first-pass.

## Do not
- Do not tune thresholds or prompt text in the port. If something reads wrong, flag it back; the n8n side and the query tool must stay byte-identical on the shared components.
- Do not reintroduce "any NAY governs", a confidence floor, or a rule that forbids NEUTRAL/NOT_DETERMINABLE. Those are the bugs.
