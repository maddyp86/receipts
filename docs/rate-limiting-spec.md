# Rate limiting — spec (NOT WIRED)

Status: **proposal**. Nothing is installed or wired. This is for review before
implementation.

`/api/query` is an unauthenticated endpoint that spends money at two vendors on
every call. Today there is **no rate limiting anywhere** — no middleware, no
dependency, no per-route cap. Anyone who knows the backend URL can run it in a
loop.

---

## What one request actually costs

Measured from the code, not estimated from memory:

| Leg | Calls per query | System prompt |
|---|---|---|
| Classify (`claude-haiku-4-5`) | 1 | taxonomy menu, ~121 lines |
| Embed (OpenAI) | 1 | — |
| Pinecone query | 1 | — |
| **Relevance (`gpt-5.4-mini`)** | **up to 10** (`RETRIEVAL_TOP_K`) | **13,740 chars ≈ 3,435 tokens each** |
| **Fulfillment (`gpt-5.4-mini`)** | 1 per admitted match | **32,507 chars ≈ 8,127 tokens each** |
| Explain loop (`claude-sonnet-5`) | up to 12 turns (`MAX_ITERATIONS`) | system + tool defs, `max_tokens` 64,000 |

**Worst case ≈ 14 paid model calls per query**, and on the OpenAI legs alone up
to **~115k input tokens** before caching. Both OpenAI legs send
`prompt_cache_key` (`match-eval-v3`, `promise-alignment-v1`), so the large
system prompts are cached across calls and the real figure is well below that —
but the *call count* is not reduced, and that is what an abuser multiplies.

**A correction is a full re-run from embedding**, not a re-filter. So one user
correcting a classification twice costs three full queries, not one. That drives
the limits below more than raw abuse does.

---

## PREREQUISITE: `trust proxy` — get this wrong and the limiter inverts

Render terminates TLS at a proxy, so `req.ip` is the **proxy's** address unless
Express is told otherwise. The library's own docs are explicit about the
consequence: it makes "the rate limiter effectively a global one and blocking
all requests once the limit is reached."

That is the worst possible failure: instead of limiting one abuser, the first
15 requests from *anyone* lock out *everyone*.

```js
// Number of proxies between the user and this server — NOT `true`.
app.set('trust proxy', 1);
```

**Verify the hop count rather than assuming it.** Add a temporary probe, hit it
from a phone on mobile data, and confirm it returns your real public IP:

```js
app.get('/api/__ip', (req, res) => res.json({ ip: req.ip, xff: req.headers['x-forwarded-for'] }));
```

If it returns a `10.x` / `100.64.x` internal address, the number is wrong.
Remove the probe before launch.

---

## Middleware

**`express-rate-limit`** — current version **8.6.2**. Standard, no runtime
dependencies of consequence, in-memory by default.

⚠️ The v8 API differs from most examples online, which are v6/v7:

| v6 / v7 | v8 |
|---|---|
| `max: 100` | **`limit: 100`** |
| `standardHeaders: true` | **`standardHeaders: 'draft-8'`** |
| manual IPv6 key handling | **`ipv6Subnet: 56`** |

---

## Proposed limits

Three tiers, because the routes differ by an order of magnitude in cost.

| Route | Window | Limit | Reasoning |
|---|---|---|---|
| `/api/query` | 15 min | **15** | An engaged session is 3–5 promises; with corrections (full re-runs) that reaches ~10–15. This fits a real user and caps a scripted one. |
| `/api/query` | 24 h | **60** | Sustained cap. Stops a slow drip that never trips the 15-minute window. |
| `/api/senators`, `/api/taxonomy` | 15 min | **120** | Free and cached in memory. Generous; exists only to stop a hammering loop. |
| `/api/health` | — | **EXEMPT** | See below. |

These are **starting values to tune from week-one telemetry**, not derived
constants. The knobs are `windowMs` and `limit`; nothing else needs to change to
retune.

### `/api/health` must be exempt

Render polls it continuously. If the probe ever receives a 429, Render marks the
service unhealthy and restarts it — a rate limit would take the service down by
being *correct*. Exempt it explicitly:

```js
skip: (req) => req.path === '/api/health',
```

---

## Sketch

```js
import { rateLimit } from 'express-rate-limit';

const queryBurst = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  ipv6Subnet: 56,
  handler: rateLimitHandler,   // see below
});

const queryDaily = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  ipv6Subnet: 56,
  handler: rateLimitHandler,
});

const readOnly = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  ipv6Subnet: 56,
  skip: (req) => req.path === '/api/health',
});

app.use('/api', readOnly);
app.get('/api/query', queryDaily, queryBurst, /* existing handler */);
```

---

## The 429 body must match the app's error envelope

`/api/query` is an SSE endpoint and the UI renders `ToolError`. A bare
`express-rate-limit` string body would surface as a generic failure, which reads
to a user as "the tool is broken" rather than "you have run a lot of queries".

That needs a new code on the shared union — `ToolError.code` currently has no
rate-limit member:

```ts
// packages/shared/src/index.ts
| 'RATE_LIMITED'
```

```js
const rateLimitHandler = (req, res) => {
  res.status(429).json({
    error: {
      code: 'RATE_LIMITED',
      message: 'You have run a lot of checks in a short time. Try again in a few minutes.',
      recoverable: true,   // drives the UI's retry affordance
    },
  });
};
```

`recoverable: true` is correct here and load-bearing: a retry genuinely will
succeed later, which is not true of most errors in that union.

---

## What this does NOT solve — stated plainly

1. **It is not protection against a determined abuser.** Per-IP limits fall to
   anything distributed, and rotating IPs is cheap. This raises the floor; it
   does not close the door.
2. **CORS is not a second line here.** CORS is browser-enforced only — `curl`
   ignores it entirely. `CORS_ORIGIN` stops other *websites* embedding the API;
   it does nothing about scripts.
3. **Shared IPs are collateral.** Offices, universities and mobile carriers
   (CGNAT) put many people behind one address. At 15 per 15 minutes a busy
   shared connection could hit the limit legitimately. Accepted for MVP; the fix
   is auth, not a bigger number.
4. **In-memory store is single-instance.** Render free tier runs one instance,
   so this is fine now. Scale past one and each instance keeps its own counter,
   silently multiplying the effective limit by the instance count. That is the
   moment to add a Redis store, and it will not announce itself.

### The gap worth closing next: a global spend cap

Per-IP limits do nothing against distributed abuse, and the thing actually being
protected is a bill. A simple global counter — "N `/api/query` calls per day
across all IPs, then serve a maintenance response" — is a blunt but effective
circuit breaker, and it is the only control here that bounds worst-case spend
rather than per-actor rate. Worth specifying separately.

---

## Test plan before merge

1. `trust proxy` returns a real public IP from an external network (probe above).
2. 16 rapid `/api/query` calls → the 16th returns **429** with the `RATE_LIMITED`
   envelope, not a generic error.
3. `/api/health` still returns **200** after the query limit is exhausted —
   this is the check that prevents a self-inflicted outage.
4. `RateLimit` headers present (`standardHeaders: 'draft-8'`).
5. The UI renders the 429 as a retryable message, not as a broken tool.
