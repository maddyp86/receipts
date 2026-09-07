<!--
DERIVED FILE — do not edit by hand.

  source:  docs/fix/01_statement_scope_classifier.md  (fix bundle, 2026-09-04)
  change:  handoff v2 §1 — one paragraph added to FIELD 2 (scope), verbatim.
  version: scope-classifier-v1.1
  date:    2026-09-07

WHY THE PARAGRAPH EXISTS. Without it, "I support the IRA" was BOUNDED and expired
730 days after it was said, so a 2026 repeal vote could not be tested against it.
Opinions do not expire; pledges about a specific vehicle do.

This file is the generator input for
packages/server/src/scope/scopeClassifierPrompt.ts — regenerate after editing:
  node tools/extract-fix-prompt.mjs
-->

# 01 — Statement Scope Classifier

Runs on any statement text: a row from `Evaluable Statements - {politician}` (backfill) or a user's query (Receipts). Model: Claude Haiku 4.5, temperature 0. Output is five fields that every downstream gate reads.

## Output columns (add to Evaluable Statements tabs)

| Column | Values | Meaning |
|---|---|---|
| `Speech Act` | `POSITION` / `COMMITMENT` / `OPERATIONAL` / `CREDIT_CLAIM` / `RHETORIC` | What kind of thing was said |
| `Scope` | `STANDING` / `BOUNDED` | Does it bind across the term, or only inside a window/vehicle/role |
| `Valid Until` | ISO date or blank | Last date an action can be tested against it (blank = STANDING) |
| `Anchor Entity` | free text or blank | The specific vehicle, FY, president, nominee set, or bill it points at |
| `Role Condition` | `NONE` / `MAJORITY_LEADER` / `COMMITTEE_CHAIR` / `MAJORITY_PARTY` | Precondition the statement presupposes |
| `Scope Confidence` | 0–1 | |
| `Scope Reasoning` | 1 sentence | |

Existing `Statement Type` / `Promise Type` / `Stance` stay as they are. This is additive.

---

## System prompt

```
You classify a single statement by a U.S. senator so that a downstream system knows WHETHER and WHEN legislative action can be tested against it. You are not judging the statement's merit or whether it was kept.

You receive: the statement text, the date it was made (may be blank), the senator's name and party, the office they held on that date (may be blank), and the statement's existing type/stance labels.

Return ONLY a JSON object. No prose.

## FIELD 1 — speech_act

Choose exactly one:

POSITION — a stated view, value, or preference with no deliverable.
  "I support universal background checks." "Rural broadband is essential."

COMMITMENT — a forward pledge with a deliverable the senator controls: a bill to introduce, a vote to cast, funding to secure, a named policy to pass or block.
  "I will introduce legislation to X." "I am working to secure $15M for Y." "We will vote on the PACT Act."

OPERATIONAL — scheduling or process language about what a chamber, committee, or leadership will do in the near term.
  "The Senate will take up the CR next week." "Voting is expected to begin tomorrow." "I will file cloture on these nominees." "We are on track to vote on six judges this work period."

CREDIT_CLAIM — reports something already done or delivered.
  "I am proud to have secured $15M for X." "I delivered this funding."

RHETORIC — evaluative or descriptive language with no position and no deliverable.
  "This is a historic day for New York."

A statement can contain more than one; classify by its dominant clause. A CREDIT_CLAIM with a trailing "and I will keep fighting" is CREDIT_CLAIM with scope STANDING on the trailing clause noted in anchor_entity as "(trailing commitment: ...)".

## FIELD 2 — scope

STANDING — binds for the full term and beyond until the senator explicitly changes position. All POSITIONs are STANDING unless they name a bounded vehicle. A COMMITMENT with no vehicle, date, FY, or administration is STANDING.

BOUNDED — the statement points at something that closes. Any of these makes it BOUNDED:
- deictic vehicle: "this bill", "this CR", "this resolution", "this funding", "this year's spending bill", "the upcoming NDAA"
- calendar window: "today", "tomorrow", "this week", "next week", "this work period", "before [date]", "by the end of the month"
- fiscal year: "FY2023", "fiscal year 2024"
- administration or named president: "President Biden's nominees", "the Biden EPA"
- a named, non-recurring bill or act: "the FY2023 omnibus", "the Public Health and Border Security Act"
- a named set of people or events: "these nominees", "the 12 additional nominees"

All OPERATIONAL statements are BOUNDED.

Naming a law, bill, or act makes a statement BOUNDED only when the speech_act is
COMMITMENT or OPERATIONAL — a pledge to pass, vote on, fund, or block that specific
vehicle, which resolves once that vehicle is decided. A POSITION that names a law
("the Inflation Reduction Act was written with families in mind", "I support H.R. 8")
is an opinion about it, not a pledge to act on it, and stays STANDING. Opinions do not
expire when the bill does.

## FIELD 3 — valid_until

For BOUNDED only. Pick the tightest that applies:
- explicit date → that date
- "today"/"tomorrow"/"this week"/"next week"/"this work period" → statement date + 30 days
- "this year's [bill]" / named FY → September 30 of that fiscal year
- named president or administration → last day of that president's term (Biden: 2025-01-20)
- named non-recurring act → statement date + 730 days (two Congress sessions), unless a date is given
- "the upcoming NDAA" / "this year's NDAA" → December 31 of the statement year
If the statement date is blank and the window is relative, set valid_until to "UNKNOWN" and say so in reasoning.

## FIELD 4 — anchor_entity

The specific thing the statement points at, in the senator's own words where possible. Blank for STANDING with no named entity. Examples: "February 18 CR deadline", "President Biden", "FY2023 NDAA", "Public Health and Border Security Act", "12 nominees with cloture filed", "Fort Drum railhead upgrade".

## FIELD 5 — role_condition

The precondition the statement presupposes. Choose one:
- MAJORITY_LEADER — the speaker is describing what the floor will do because they control it ("I will file cloture", "the Senate will take up", "we will confirm the President's nominees")
- COMMITTEE_CHAIR — presupposes chairing a committee
- MAJORITY_PARTY — presupposes the speaker's party controls the agenda but not the speaker personally
- NONE — no precondition; an individual senator can do this from any seat

Use the office field if provided. If the office is blank, infer from the language: first-person control of floor scheduling is MAJORITY_LEADER.

## Rules
- Do not soften OPERATIONAL into COMMITMENT because it sounds committed. "I will file cloture on them" is OPERATIONAL.
- Do not promote CREDIT_CLAIM to COMMITMENT because it mentions future fighting; note the trailing clause instead.
- Do not treat "we will" as STANDING when it refers to a chamber action; that is OPERATIONAL and BOUNDED.
- A named recurring vehicle ("the NDAA", "the farm bill") with no year is STANDING with anchor_entity set to the vehicle type.

## Output

{
  "speech_act": "POSITION|COMMITMENT|OPERATIONAL|CREDIT_CLAIM|RHETORIC",
  "scope": "STANDING|BOUNDED",
  "valid_until": "YYYY-MM-DD|UNKNOWN|",
  "anchor_entity": "",
  "role_condition": "NONE|MAJORITY_LEADER|COMMITTEE_CHAIR|MAJORITY_PARTY",
  "confidence": 0.0,
  "reasoning": "one sentence"
}
```

## User template (n8n expression)

```
Statement: {{ $json["ExtractedStatement"] || $json["statement_text"] }}
Date made: {{ $json["Date"] || $json["statement_date"] || "" }}
Senator: {{ $json["Full Name"] || $json["politician_name"] || "" }} ({{ $json["Party"] || "" }})
Office on that date: {{ $json["Office"] || "" }}
Existing labels: type={{ $json["Statement Type"] || "" }}, promise_type={{ $json["Promise Type"] || "" }}, stance={{ $json["Stance"] || "" }}
```

For the query tool, `statement_text` is the user's input, `statement_date` is whatever the user supplied or blank, and `Office` is looked up from the Politicians tab by politician + date if a date exists.

---

## Post-check Code node (deterministic, runs after the LLM)

```javascript
// ===================================================================
// SCOPE POST-CHECK — enforces the parts of the rule that don't need a model
// ===================================================================
const S = (v) => (v === null || v === undefined ? '' : String(v).trim());
const U = (v) => S(v).toUpperCase();

const BOUNDED_RE = /\b(this (bill|resolution|continuing resolution|CR|funding|legislation|year's)|these nominees|the (12|twelve) additional nominees|next week|this week|this work period|today|tomorrow|before (the )?(end of the (week|month)|[A-Z][a-z]+ \d{1,2})|by the end of the (week|month|year)|fiscal year 20\d\d|FY ?20\d\d|President (Biden|Trump|Obama)|(Biden|Trump|Obama)('s)? (administration|EPA|nominees|judicial nominees)|the upcoming (NDAA|omnibus|farm bill))\b/i;
const OPERATIONAL_RE = /\b(the Senate will (take up|vote|move|consider|pass)|I will file cloture|voting (is expected|will begin)|we are on track to vote|schedule votes|(first|next) (two )?weeks? of this work period)\b/i;
const LEADER_RE = /\b(I will file cloture|I intend to have the Senate|the Senate will take it up|we will confirm|I will schedule)\b/i;
const CREDIT_RE = /\b(I am proud to have (secured|delivered|helped)|I secured|I delivered|we delivered)\b/i;
const PRES_TERM_END = { BIDEN: '2025-01-20', TRUMP: '2029-01-20', OBAMA: '2017-01-20' };

const addDays = (iso, d) => { const t = new Date(iso); if (isNaN(t)) return 'UNKNOWN'; t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0,10); };
const parseLLM = (item) => {
  const txt = item.json.output?.[0]?.content?.[0]?.text || item.json.message?.content || item.json.text || item.json.content || '';
  try { return JSON.parse(String(txt).replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/\s*```$/i,'').trim()); } catch (e) { return null; }
};

const out = [];
for (const item of $input.all()) {
  const src = $('Loop Over Statements').item?.json || item.json;   // rename to your loop node
  const text = S(src['ExtractedStatement'] || src['statement_text']);
  const date = S(src['Date'] || src['statement_date']);
  const p = parseLLM(item) || {};
  const flags = [];

  let speech = U(p.speech_act) || 'POSITION';
  let scope  = U(p.scope) || 'STANDING';
  let until  = S(p.valid_until);
  let anchor = S(p.anchor_entity);
  let role   = U(p.role_condition) || 'NONE';

  // Deterministic overrides — the regexes are conservative; when they fire, they win.
  if (OPERATIONAL_RE.test(text) && speech !== 'OPERATIONAL') { speech = 'OPERATIONAL'; flags.push('SPEECH_ACT_OVERRIDE_OPERATIONAL'); }
  if (CREDIT_RE.test(text) && speech === 'COMMITMENT') { speech = 'CREDIT_CLAIM'; flags.push('SPEECH_ACT_OVERRIDE_CREDIT'); }
  if ((BOUNDED_RE.test(text) || speech === 'OPERATIONAL') && scope !== 'BOUNDED') { scope = 'BOUNDED'; flags.push('SCOPE_OVERRIDE_BOUNDED'); }
  if (LEADER_RE.test(text) && role === 'NONE') { role = 'MAJORITY_LEADER'; flags.push('ROLE_OVERRIDE_LEADER'); }

  // valid_until fallback when the model left it blank on a BOUNDED statement
  if (scope === 'BOUNDED' && (!until || until === 'UNKNOWN')) {
    const pres = text.match(/\b(Biden|Trump|Obama)\b/i);
    const fy = text.match(/\b(?:FY ?|fiscal year )(20\d\d)\b/i);
    if (pres) until = PRES_TERM_END[pres[1].toUpperCase()];
    else if (fy) until = `${fy[1]}-09-30`;
    else if (/\b(today|tomorrow|this week|next week|this work period)\b/i.test(text)) until = date ? addDays(date, 30) : 'UNKNOWN';
    else if (/\bupcoming NDAA|this year's/i.test(text)) until = date ? `${date.slice(0,4)}-12-31` : 'UNKNOWN';
    else until = date ? addDays(date, 730) : 'UNKNOWN';
    flags.push('VALID_UNTIL_DERIVED');
  }
  if (scope === 'STANDING') until = '';

  out.push({ json: {
    ...src,
    'Speech Act': speech,
    'Scope': scope,
    'Valid Until': until,
    'Anchor Entity': anchor,
    'Role Condition': role,
    'Scope Confidence': typeof p.confidence === 'number' ? p.confidence : 0,
    'Scope Reasoning': S(p.reasoning) + (flags.length ? ' [' + flags.join(',') + ']' : ''),
    'Scope Classified At': new Date().toISOString()
  }});
}
return out;
```

## Wiring

**Backfill (one-time, then nightly on new statements):** Get Statements (tab) → Loop Over Statements (batch 25) → Haiku classifier → Post-check → Update row on `Promise UID`. Dry-run: write to a `Scope QA` tab first, review the distribution, then write back. Expected on Schumer's 781: COMMITMENT well under 100; OPERATIONAL over 200.

**WF7a:** add `scope`, `valid_until`, `role_condition`, `speech_act` to the `metadata` object in `Promise Embedding Text` and carry them through `Parse and Store Matches` (both CASE A and CASE B) so they land on the match row. Optional but recommended: in `Filter Unevaluated Promises`, skip `Speech Act ∈ {OPERATIONAL, CREDIT_CLAIM, RHETORIC}` — they don't need Pinecone queries at all. That alone cuts LLM calls by roughly a third.

**Query tool:** run classifier + post-check on the user's text before retrieval. If `scope = BOUNDED` and `valid_until = UNKNOWN`, ask the user for the date instead of evaluating. If `speech_act ∈ {OPERATIONAL, CREDIT_CLAIM, RHETORIC}`, explain that this kind of statement can't be tested against legislation and offer the underlying position instead.
