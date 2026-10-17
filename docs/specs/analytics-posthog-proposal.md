# PostHog — anonymous analytics (PROPOSAL, NOT WIRED)

Status: **proposal**. Nothing is installed. Wire only once the GitHub remote is
up and the project token is in the host's env.

Goal: usage volume and shape — how many queries, which senators, which issues,
which features get used.

**Division of labour, and the reason the split is clean:** PostHog holds
*structured usage events*. Supabase `app_queries` holds the *content* — including
`promise_text` — where it is SQL-queryable and joinable to retrieval results and
verdicts. Analytics answers "how much and what shape"; the database answers
"what did people actually ask, and what did we return".

---

## Config — conventional tracking

Matt's call: standard PostHog, not anonymous-mode hardening. Cookies,
persistence and session continuity all normal.

```js
posthog.init('<project_token>', {
  api_host: 'https://us.i.posthog.com',

  // Default. Anonymous until identified; person profiles created when they are.
  person_profiles: 'identified_only',

  // Default persistence — cookies + localStorage. Session continuity and
  // returning-visitor recognition both work normally.
  persistence: 'localStorage+cookie',

  capture_pageview: true,
  capture_pageleave: true,

  // The ONE non-default setting, and it is not a privacy posture — it is a
  // data-quality one. Autocapture records DOM interactions including input
  // values, which would sweep the promise textarea into event payloads as a
  // side effect. The promise text IS being captured, deliberately, as a column
  // in app_queries where it is SQL-queryable and joinable to retrieval results
  // and verdicts. Incidental capture in analytics would give us a second,
  // worse copy: unjoinable, unversioned, and shaped by whatever the DOM
  // happened to look like.
  autocapture: false,
})
```

Nothing else is special. IP handling, GeoIP, session recording and identify()
are all left at PostHog's defaults — no `Discard client IP data` toggle, no
cookieless mode, no `person_profiles: 'never'`.

(For the record, since it was researched: `$ip` cannot be redacted via
`property_denylist` — it needs the project-level toggle — and cookieless server
hash mode strips IP before transformations so GeoIP never enriches. Neither
applies now, but both are the kind of thing worth not rediscovering.)

## Event schema

Four events. Every property is either a bounded enum or an id from a closed set
— no free text, ever.

### `query_submitted`

| Property | Type | Example | Why it is safe |
|---|---|---|---|
| `politician_id` | string | `S000148` | public official, closed set |
| `primary_issue` | enum | `Health Care` | one of 23 approved values |
| `sub_issue` | enum | `Prescription Drugs` | one of 121 approved pairs |
| `stance` | enum | `In Favor` | 3 values |
| `promise_type` | enum | `policy` | 4 values |
| `is_evaluable` | boolean | `true` | |

**`promise_text` is not sent to PostHog** — not because it is too sensitive to
store, but because this is the wrong store for it. It goes to
`app_queries.promise_text`, where it can be joined to the classification, the
retrieved candidates and the verdict, and queried with SQL. A copy in event
payloads would be unjoinable, unversioned, and a second source of truth for the
same string.

### `result_returned`

| Property | Type | Example |
|---|---|---|
| `result_type` | enum | `verdict` \| `no_match` \| `gated` \| `not_determinable` \| `error` |
| `verdict` | enum \| null | `KEPT` \| `BROKE` \| `NOT_DETERMINABLE` |
| `band` | enum \| null | `High` \| `Medium` \| `Low` |
| `evidence_count` | integer | `3` |
| `retrieved_count` | integer | `10` |
| `gate_reason` | enum \| null | `PROMISE_TYPE` \| `STANCE` \| `EVALUABILITY` |
| `degraded` | boolean | true when a leg was skipped for a missing credential |

`retrieved` vs `evidence` as separate counts is deliberate: "10 retrieved, 0
admitted" is the shape that tells us the relevance gate is too tight, and it is
invisible if only the final count is recorded.

### `correction_used`

| Property | Type | Example |
|---|---|---|
| `fields_corrected` | string[] | `['primary_issue','sub_issue']` — field NAMES only |
| `from_primary_issue` / `to_primary_issue` | enum | taxonomy values |
| `from_sub_issue` / `to_sub_issue` | enum | taxonomy values |

The classifier's misreads are the most useful thing here: a recurring
`Social Security → Health Care` correction is a prompt bug with a queue of
evidence behind it.

### `override_used`

| Property | Type |
|---|---|
| `politician_id` | string |
| `primary_issue` | enum |

Fired when a user asserts the Campaign Promise premise. Worth its own event
because it is the one path that produces KEPT/BROKE language, and its rate is a
signal about whether the copy is doing its job.

---

## Boundary with Supabase

| | Owns |
|---|---|
| **PostHog** | structured usage events — counts, shape, funnels, feature use |
| **Supabase** | content and function — `promise_text`, classification, result, the `mirror` read replica, and `getQuery(id)` for share links |

`app_queries` is the training/analysis store. The rule is one copy of each fact
in the place it can actually be used: text and results in Postgres where they
join and can be queried with SQL; counts and funnels in PostHog where they are
already aggregated.

### The corpus firewall is untouched by this

Worth stating plainly, because "we now store the user's query text" and "user
queries can never influence a senator's score" sound like they are in tension
and are not.

The firewall is a **data-integrity** control, not a privacy one. It exists so a
user's typed text can never become evidence in the trust index. It is enforced
by Postgres grants — `receipts_trust` holds no privilege on the `app` schema at
all, so a scorer query touching `app_queries` errors rather than returning rows —
and by the `QueryStore` seam exposing no aggregate read.

`promise_text` sits **behind** that wall. The scorer cannot read the column
because it cannot read the table because it cannot see the schema. Capturing the
text and keeping the firewall are fully compatible: one is about what we keep,
the other about what can influence a score. Both stay exactly as designed.

## Where the calls go

Client-side, in `packages/web`, so no event ever passes through the server —
keeping analytics off the request path and out of the backend's dependency set.

The project token is public by design (it is in the bundle) and is **not** a
secret; it goes in `VITE_POSTHOG_KEY` alongside `VITE_API_BASE`. Absent token →
PostHog is not initialised at all, and the app runs normally with no analytics.
