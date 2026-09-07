# 04 — `Format Gated Alignments` patch

The gated path currently hard-codes `NOT_APPLICABLE`. The new gates emit `PROCEDURAL_SWITCH`, `NOT_DETERMINABLE`, and `NOT_APPLICABLE_EXPIRED` as well, and WF11 needs to distinguish them (expired and not-applicable are excluded from the denominator's "tested" count; procedural switch is disclosed; not-determinable counts as tested-but-inconclusive).

## Change

Find:
```javascript
    'Promise Alignment': 'NOT_APPLICABLE',
    'Alignment Reasoning': S(pick(j, 'Gate Reason')),
```

Replace with:
```javascript
    'Promise Alignment': S(pick(j, 'Gate Verdict')) || 'NOT_APPLICABLE',
    'Alignment Reasoning': S(pick(j, 'Gate Reason')),
    'Gate Hits': S(pick(j, 'Gate Hits')),
    'Bill Effect': 'NOT_EVALUATED',
    'Alignment Confidence': 'NOT_EVALUATED',
    'Model Verdict': 'GATED',
    'Model Agreed': 'NA',
```

(If `Bill Effect` / `Alignment Confidence` / `Model Verdict` are already set in the marker block below, delete these duplicates — keep one source per column.)

Add `'Gate Hits'`, `'Senator Role'`, `'Cloture Result'`, `'Scope'`, `'Valid Until'`, `'Promise Date'`, `'Vote Flags'` to the `optional` carry-through list so the audit trail lands on the sheet, and add those columns to `Add Gated Alignments` and `Add Promise Alignments (Workflow A)`.

## WF11 note

`NOT_APPLICABLE_EXPIRED` must be read the same way as `NOT_APPLICABLE`: unscored, not zero, excluded from "tested". Add it to whatever set WF11 uses for exclusion. `PROCEDURAL_SWITCH` is already frozen to 0.0 there per the existing comment in `Compute Party Vote Alignment`.
