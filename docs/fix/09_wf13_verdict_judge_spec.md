# 09 — WF13 Verdict Judge (post-write drain)

Standalone workflow. Runs after WF10a, never inside it. Reads `Grade = PENDING` rows from `Promise Alignment - Matches`, runs the deterministic gates, judges with a different model family, retries once with the critique, logs every call, and updates the row. No accusation reaches WF11/WF12 without passing through here.

## Invariants (these are the whole point)

1. A retry may only move a verdict **away from** BROKE/INCONSISTENT or lower confidence. It may never create or strengthen an accusation.
2. Two FAILs → verdict forced to `NOT_DETERMINABLE`, `Grade = REVIEW_REQUIRED`. The judge's `corrected_verdict` is logged, never written as the verdict.
3. Every judge call writes one log row before the alignment row is updated. If the log write fails, the row stays `PENDING` (fail closed on the audit trail, fail open on nothing else).
4. Judge model ≠ evaluator model family. Evaluator is GPT-5.4-mini; judge is Claude Sonnet 5.

## Sheets

| Purpose | Workbook | Tab | gid |
|---|---|---|---|
| Read/update alignment rows | Evaluation Matches `1R8BAa8Btm38RwxhLhzNgokwWZbd8yofHaK60ZcCWeN4` | `Promise Alignment - Matches` | `362442456` |
| Gold set (optional join) | Evaluation Matches | `Alignment Gold Set` (new; paste `wf10a_broke_gold_set.csv`) | — |
| Roll call result | Master Data `1AJK0A8rJ5oY4kUwnYR7Z_g_W2tGnwCNlfMsGwbGaTj0` | `Roll Call Votes` (`Results` column) | `1053048935` |
| Politician role | Master Data | `Politicians` (`Role` column) | `gid=0` |
| Audit log (new) | Evaluation Matches | `Verdict Audit Log` | — |
| Run metrics | Manifest Tracker `1fx_1JSvJNhkeC9DUd7xoIy8_42XLupcyByZEbtz7XuA` | `Pipeline Run Log` | `2076469739` |

## Nodes

```
1  Manual Trigger (run_id, politician_id, limit=50, judge_kept_sample=true)
2  Get Pending Alignments      Sheets read, filter Politician ID; Code filter Grade == 'PENDING' (sheet filter on one column only — the tab is large)
3  Limit                       {limit}
4  Get Gold Set                Sheets read (whole tab, small)
5  Get Roll Call Votes         Sheets read
6  Get Politician              Sheets read, filter Politician ID
7  Join Reference + Gold       Code: attach Cloture Result (Results by Cloture Vote ID), Senator Role, gold_* fields by Promise Alignment UID
8  Deterministic Gates         Code: fix/11_wf13_deterministic_gates.js minus the metrics tail; emits gate_results, deterministic_grade
9  Gate Fired?                 If gate_results.length > 0
      true  → 10a Build Log Row (disposition GATED, pass 0) → 11 Append Audit Log → 12 Update Alignment Row
                  (Promise Alignment := gate verdict; Grade := GATED_<class>; Alignment Reasoning += gate detail)
      false → 13 Loop (batch 10)
14 Build Judge Request         Code: system = fix/12_wf13_judge_system_prompt.md (v1); user = full row + gate_results + gold (if any); pass_number = 1
15 Judge (HTTP, Anthropic)     claude-sonnet-5, temperature 0, max_tokens 1200
16 Parse Judge                 Code: strict JSON; missing senator_counterargument on PASS → treat as FAIL class UNDISCLOSED_CAVEAT
17 Append Audit Log            (pass 1)
18 Judge Passed?               If grade == PASS
      true  → 19 Update Alignment Row (Grade := PASS; Judge Counterargument := …)
      false → 20 Build Re-eval Request   Code: evaluator v7 SYSTEM (byte-identical to WF10a) + user payload + CRITIQUE block (below); prompt_cache_key promise-alignment-v7
              21 Re-evaluate (HTTP, OpenAI /v1/responses, gpt-5.4-mini)
              22 Parse Re-eval            Code: deriveAlignment (file 06) recomputes verdict from bill_effect + votes;
                                          ENFORCE INVARIANT 1: if new verdict is BROKE/INCONSISTENT and old was not, or confidence rose → discard, keep old
              23 Build Judge Request      pass_number = 2, includes pass-1 critique
              24 Judge (HTTP)             same as 15
              25 Parse Judge              same as 16
              26 Append Audit Log         (pass 2)
              27 Retry Passed?            If grade == PASS
                    true  → 28 Update Alignment Row (verdict := re-eval verdict; Grade := PASS_ON_RETRY; Alignment Confidence := min(conf, 0.75))
                    false → 29 Update Alignment Row (Promise Alignment := NOT_DETERMINABLE; Grade := REVIEW_REQUIRED;
                                                     Alignment Reasoning := original + ' | REVIEW: ' + judge critique;
                                                     Model Verdict := original verdict preserved for the record)
30 Loop done → Compute Metrics → Append Pipeline Run Log (Step = wf13)
```

Updates to `Promise Alignment - Matches` are `appendOrUpdate` on `Promise Alignment UID` with `matchingColumns` set; the key is never changed, so re-runs are idempotent. Rows already logged for this `run_id` are skipped in node 2.

## CRITIQUE block appended to the re-evaluation user prompt

```
## INDEPENDENT REVIEW OF YOUR PREVIOUS VERDICT
A second reviewer examined your verdict ({previous_verdict}, confidence {previous_confidence}) and FAILED it.
- Test failed: {failed_test} ({failure_class})
- Critique: {critique}
- The senator's office would say: {senator_counterargument}
- Reviewer's reading of the bill effect: {corrected_bill_effect}

Re-evaluate from the inputs, not from your previous answer. You may lower confidence, change bill_effect, or move to NOT_DETERMINABLE. You may not raise confidence and you may not move a verdict toward BROKE or INCONSISTENT. If you still believe the original verdict is right, state the counterargument in alignment_reasoning and cap confidence at 0.7.
```

## `Verdict Audit Log` columns (header row, exact)

```
Audit UID | Promise Alignment UID | Politician ID | Promise UID | Bill ID | Run ID | Pass Number |
Evaluator Verdict | Evaluator Bill Effect | Evaluator Confidence | Evaluator Model | Evaluator Prompt Version |
Gate Hits | Deterministic Grade |
Judge Grade | Failed Test | Failure Class | Judge Corrected Verdict | Judge Corrected Bill Effect | Judge Corrected Confidence |
Senator Counterargument | Judge Critique | Judge Model | Judge Prompt Version |
Gold Expected Verdict | Gold Agreement | Gate Agreement |
Final Disposition | Judged At
```
`Audit UID` = `AUDIT-{Promise Alignment UID}-{pass}`. `Final Disposition` ∈ GATED / PASS / PASS_ON_RETRY / REVIEW_REQUIRED; set on the last pass, blank on pass 1 of a retried row.

## Metrics row (Pipeline Run Log → Description field, JSON)

```
{ rows_judged, gated, pass_first, pass_retry, review_required,
  first_pass_fail_by_class: {...},
  broke_precision_proxy: (pass_first + pass_retry) / accusations_judged,
  gold_rows, gold_agreement_rate, gate_attribution_rate, gate_pass }
```
`gate_pass` = true when zero gold rows expected non-BROKE still carry BROKE after judging. That is the Step 8 criterion.

## Build notes

- The judge system prompt (v1) and the gate code both exceed the paste threshold; I scaffold nodes 1–30 with connections and placeholder bodies, you paste 8, 14 (system string), 20 (evaluator SYSTEM — copy from the WF10a node after you paste v7 there, so the two stay byte-identical).
- Anthropic HTTP node: `POST https://api.anthropic.com/v1/messages`, headers `x-api-key`, `anthropic-version: 2023-06-01`; needs a credential attached manually after creation.
- `retryOnFail` on 15/21/24 (maxTries 3, 5000ms) — set via `setNodeSettings`, not `addNode`.
- Cost at current volume: ~253 accusations + ~314 KEPT/CONSISTENT sample = ~570 Sonnet calls first pass, plus retries. Budget for ~700.
