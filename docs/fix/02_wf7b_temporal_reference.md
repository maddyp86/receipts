# 02 — WF7b: persist `temporal_reference`

WF7b's Step 3B already reasons STANDING / RECURRING / DATED per pairing and its comment says out-of-window promises are "handled upstream" — they weren't (until file 01). This makes the model's call a stored axis so the gate in 03 can use it as a second opinion, and so DATED pairings stop being admitted as evidence via the PARTIAL/SPECIFICITY path.

Four small edits. No prompt paragraphs removed or reworded, so the byte-compare discipline in `Build Eval Request` still holds — only the OUTPUT FORMAT block and one ALWAYS line change. Update the `SYSTEM.length` comment after pasting.

## 2a. `Build Eval Request` — SYSTEM string

**In `### ALWAYS`, append:**
```
- ALWAYS set temporal_reference to STANDING, RECURRING, or DATED per STEP 3B, 
  and when DATED, name the vehicle the promise pointed at in anchor_vehicle
```

**Replace the OUTPUT FORMAT block with:**
```
## OUTPUT FORMAT

{
  "action_type": "VOTE|SPONSORSHIP|NONE",
  "topic_relevant": "Yes|No|NA",
  "action_relevant": "Yes|No|NA",
  "effort_relevant": "Yes|No|NA",
  "specificity_match": "Yes|No|NA",
  "temporal_reference": "STANDING|RECURRING|DATED|NA",
  "anchor_vehicle": "name of the vehicle the promise points at, or NA",
  "no_vote_available": true|false,
  "verdict": "TRUE_POSITIVE|FALSE_POSITIVE|PARTIAL",
  "reasoning": "2-3 sentences explaining your verdict and which evaluation path was used",
  "confidence": 0.0-1.0
}
```

Also add to the NONE early-return object: `"temporal_reference": "NA", "anchor_vehicle": "NA",`.

Bump `prompt_cache_key` to `'match-eval-v4'`.

## 2b. `Parse LLM Response` — carry the two fields

In the SUCCESS ROW block, after `specificity_match: sanitize(parsed.specificity_match),` add:
```javascript
        temporal_reference: sanitize(parsed.temporal_reference),
        anchor_vehicle:     sanitize(parsed.anchor_vehicle),
```
In the NO RESPONSE and PARSE ERROR blocks add `temporal_reference: 'ERROR', anchor_vehicle: 'ERROR',` alongside the other ERROR fields.

Also carry the scope columns from the match row (they arrive from WF7a once file 01's wiring is done). In all three blocks, next to `promise_date:` add:
```javascript
        promise_scope:          sanitize(matchData.scope, 'NA'),
        promise_valid_until:    sanitize(matchData.valid_until, 'NA'),
        promise_role_condition: sanitize(matchData.role_condition, 'NA'),
        promise_speech_act:     sanitize(matchData.speech_act, 'NA'),
```

## 2c. `Derive Partial Subtype` — DATED becomes its own subtype

Replace the `subtype` function body:
```javascript
const subtype = (r) => {
  const v = String(r.current_verdict || '').toUpperCase();
  if (v !== 'PARTIAL') return 'NA';

  const conf = typeof r.confidence_score === 'number' ? r.confidence_score : 0;
  if (conf < AMBIGUOUS_CONFIDENCE_FLOOR) return 'AMBIGUOUS';

  const eff = String(r.effort_relevant || '');
  const act = String(r.action_relevant || '');
  if (eff === 'No' || act === 'No') return 'DIRECTIONAL';

  // DATED before SPECIFICITY: a promise that pointed at one closed vehicle is
  // not "the right subject at a wider scope" - it is a different object in
  // time. WF10a's Dedupe admits SPECIFICITY as evidence; it must not admit this.
  if (String(r.temporal_reference || '').toUpperCase() === 'DATED') return 'DATED_VEHICLE';

  if (String(r.specificity_match || '') === 'No') return 'SPECIFICITY';
  return 'UNCLASSIFIED';
};
```

## 2d. `Promise Matches` sheet node — new columns

Add to the column mapping (and the sheet header):
```
"Temporal Reference": "={{ $json.temporal_reference }}",
"Anchor Vehicle":     "={{ $json.anchor_vehicle }}",
"Promise Date":       "={{ $json.promise_date }}",
"Promise Scope":      "={{ $json.promise_scope }}",
"Promise Valid Until":"={{ $json.promise_valid_until }}",
"Promise Role Condition": "={{ $json.promise_role_condition }}",
"Promise Speech Act": "={{ $json.promise_speech_act }}"
```
`Promise Date` was never written to Promise Matches even though every match row has it. That is why WF10a couldn't pass it to the evaluator.

## 2e. WF10a `Dedupe Accepted Matches` — stop admitting DATED_VEHICLE

In the tier/gate logic, treat `Partial Subtype = DATED_VEHICLE` exactly like DIRECTIONAL: excluded from scoring, counted in the drop tally. (The gate in 03 also catches these from the Scope columns; this is the belt to that suspender.)
