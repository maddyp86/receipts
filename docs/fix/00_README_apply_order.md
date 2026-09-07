# Alignment fix set — apply order

Everything here is paste-ready. Nothing is pushed via API. Close the editor before any API write; hard-refresh before reopening; `versionId == activeVersionId` is the only proof a change is live.

Shared principle across all files: **the same three components run in both products.**
`Statement Scope Classifier` → `Pre-Evaluator Gates` → `Evaluator v7`. Batch (WF7/WF10a) reads the statement from the Evaluable Statements tab; the query tool reads it from the user. Same code, same prompt, same gates.

| # | File | Target | What it does | Rows closed |
|---|------|--------|--------------|-------------|
| 1 | `01_statement_scope_classifier.md` | New backfill workflow on `Evaluable Statements - {pol}` **and** the query tool | Adds `Speech Act`, `Scope`, `Valid Until`, `Anchor Entity`, `Role Condition` to every statement | 35 (via gate) |
| 2 | `02_wf7b_temporal_reference.md` | WF7b `Build Eval Request`, `Parse LLM Response`, `Derive Partial Subtype`, Promise Matches sheet | Persists the STANDING/RECURRING/DATED call the model already makes; DATED → subtype `DATED_VEHICLE` | defense in depth |
| 3 | `03_wf10a_pre_evaluator_gates.js` | WF10a — new Code node between `Enrich With Statement Type` and `Scorable?` | G1 scope/admin/role, G2 vote pairing, G3 leader switch, G4 broad vehicle. Sets `Scorable`, `Gate Verdict`, `Gate Reason` | 35 + 15 + ~10 |
| 4 | `04_wf10a_format_gated_alignments_patch.md` | WF10a `Format Gated Alignments` | One-line change so gated rows carry the gate's verdict, not always NOT_APPLICABLE | — |
| 5 | `05_wf10a_compute_party_vote_alignment.js` | WF10a `Compute Party Vote Alignment` (full replacement) | Emits `LEADER_SWITCH` instead of `CROSS_PARTY` for the Rule XIII case | — |
| 6 | `06_wf10a_derive_alignment.js` | WF10a `Parse LLM Response` — replace the `deriveAlignment` function only | Symmetric split-vote rule; removes "ANY NAY GOVERNS"; adds `Vote Flags` | 14 |
| 7 | `07_wf10a_evaluator_prompt_v7.md` | WF10a `Promise Alignment Evaluator` system + user prompt (full replacement) | Removes anti-NEUTRAL rules, 0.6 floor, prior-reasoning anchoring; adds `same_object`, `CONTESTED`, impact-conflict rule; new payload fields | remaining |
| 8 | `08_query_tool_pipeline.md` | Receipts backend | How the three components compose per query; what the evidence layer must expose | — |

Order matters: 1 before 3 (the gate reads Scope columns; fails open without them). 5 before 3 is not required but keeps the `Party Alignment` vocabulary consistent. 6 and 7 together — the prompt says cloture governs on 60-vote splits and the code must agree.

After applying: bump `promptCacheKey` to `promise-alignment-v7`, requeue the 79 gold rows, run WF10a, grade with `fix/11_wf13_deterministic_gates.js`.

Reference data you must fill in before Step 3 works fully:
- `Politicians` tab: add column `Role` with values like `MAJORITY_LEADER:119`, `MINORITY_LEADER:119;MAJORITY_LEADER:118`. The gate has a hardcoded fallback for Schumer/Thune.
- `Roll Call Votes` tab: confirm a `Result` column exists (values containing "Agreed"/"Rejected"/"Passed"/"Failed"). If absent the leader gate fires on whip mismatch alone and says so in `Gate Reason`.
