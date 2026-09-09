import { rateLimit, type RateLimitRequestHandler } from 'express-rate-limit';
import type { Request, Response } from 'express';
import type { ToolError } from '@receipts/shared';
import { config } from './config.js';

// ===========================================================================
// Per-IP rate limiting for the public API.
//
// `/api/query` is unauthenticated and spends money at two vendors per call.
// docs/rate-limiting-spec.md has the cost breakdown and, more usefully, the
// list of what this does NOT solve — distributed abuse, shared-IP collateral,
// and the multi-instance counter split.
//
// ── THE PART THE SPEC COULD NOT HAVE KNOWN ────────────────────────────────
//
// The spec says the 429 body should be the app's `ToolError` envelope, "which
// the UI renders". The UI cannot render it. `useReceiptStream` consumes
// `/api/query` with `EventSource`, and EventSource exposes NO status code and
// NO response body on a non-200 — it fires a bare `onerror`. A JSON 429 would
// be invisible to the browser and would surface as the generic failure state,
// which is exactly the outcome the spec set out to avoid: it reads as "the
// tool is broken" rather than "you have run a lot of checks".
//
// So the limiter answers differently depending on who is asking:
//
//   EventSource / any Accept: text/event-stream
//       200 + a single SSE `error` event carrying the ToolError, then close.
//       The client's existing error path renders it, including the retry
//       affordance driven by `recoverable: true`.
//
//   curl, scripts, anything else
//       429 + the same ToolError as JSON. The correct status for an API
//       consumer, and what the spec's test plan checks.
//
// The status divergence is deliberate and worth stating plainly: a 200 for a
// refused request is a lie to a machine, so machines get the 429. Browsers get
// the shape they can actually read. The envelope is identical either way, so
// there is one description of what happened, in two transports.
// ===========================================================================

/** Copy for a rate-limited caller. Says what happened and that waiting fixes it. */
const RATE_LIMITED_ERROR: ToolError = {
  code: 'RATE_LIMITED',
  message:
    'You have run a lot of checks in a short time. Give it a few minutes and try again — nothing is broken, and your earlier answers are unaffected.',
  // Load-bearing, not decoration. Unlike most members of this union, waiting
  // genuinely does fix this, and the UI's retry affordance keys off the flag.
  recoverable: true,
};

const wantsEventStream = (req: Request): boolean =>
  String(req.headers.accept ?? '').includes('text/event-stream');

/**
 * Answer a limited request in whichever shape the caller can read.
 *
 * Exported for tests: the browser path is the one that regressed silently in
 * design, so it is worth asserting directly rather than through a live socket.
 */
export function respondRateLimited(req: Request, res: Response): void {
  if (wantsEventStream(req)) {
    // A stream that opens, explains itself and closes. The client already
    // handles a `type: 'error'` event; nothing new is needed on that side.
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'error', error: RATE_LIMITED_ERROR })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
    return;
  }

  res.status(429).json({ error: RATE_LIMITED_ERROR });
}

/** Shared across every limiter, so they cannot drift apart in the details. */
const COMMON = {
  // v8 API. v6/v7 examples say `standardHeaders: true` and `max:` — both are
  // wrong here, and wrong quietly: `max` is simply ignored, leaving the route
  // on the library default rather than the configured limit.
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  // Without this an IPv6 client gets a fresh bucket per address, and a /64 is
  // free to allocate from — the limit would be trivially sidestepped.
  ipv6Subnet: 56,
} as const;

const MINUTES_15 = 15 * 60 * 1000;
const HOURS_24 = 24 * 60 * 60 * 1000;

/** Burst cap on the expensive endpoint. */
export const queryBurstLimiter: RateLimitRequestHandler = rateLimit({
  ...COMMON,
  windowMs: MINUTES_15,
  limit: config.rateLimit.queryPer15Min,
  handler: respondRateLimited,
});

/** Sustained cap, for the drip that never trips the burst window. */
export const queryDailyLimiter: RateLimitRequestHandler = rateLimit({
  ...COMMON,
  windowMs: HOURS_24,
  limit: config.rateLimit.queryPerDay,
  handler: respondRateLimited,
});

/**
 * The free, memory-cached routes.
 *
 * `/api/health` is EXEMPT, and that exemption prevents a self-inflicted outage
 * rather than being a convenience: Render polls health continuously, and a 429
 * there marks the service unhealthy and restarts it. The limiter would take the
 * service down by working correctly.
 */
export const readOnlyLimiter: RateLimitRequestHandler = rateLimit({
  ...COMMON,
  windowMs: MINUTES_15,
  limit: config.rateLimit.readPer15Min,
  skip: (req) => req.path === '/api/health',
  handler: respondRateLimited,
});
