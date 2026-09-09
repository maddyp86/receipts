import { describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { config } from './config.js';
import { isHealthProbe, respondRateLimited } from './rateLimit.js';

// ===========================================================================
// The rate limiter's two failure modes are both SILENT, which is why these
// tests exist rather than a live-socket integration test:
//
//   1. Answering a browser with a 429 JSON body it cannot read. EventSource
//      exposes no status and no body on a non-200, so the carefully-worded
//      envelope would vanish and the user would see the generic "something
//      went wrong" — the precise outcome the spec set out to avoid.
//   2. Rate-limiting `/api/health`. Render polls it, and a 429 marks the
//      service unhealthy and restarts it. The limiter would take production
//      down BY WORKING.
//
// Neither shows up in a typecheck and neither throws.
// ===========================================================================

interface Captured {
  status: number | null;
  headers: Record<string, string>;
  chunks: string[];
  json: unknown;
  ended: boolean;
}

function fakeRes(): { res: Response; captured: Captured } {
  const captured: Captured = { status: null, headers: {}, chunks: [], json: null, ended: false };
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    set(h: Record<string, string>) {
      Object.assign(captured.headers, h);
      return this;
    },
    write(chunk: string) {
      captured.chunks.push(chunk);
      return true;
    },
    json(body: unknown) {
      captured.json = body;
      return this;
    },
    end() {
      captured.ended = true;
      return this;
    },
  } as unknown as Response;
  return { res, captured };
}

const reqAccepting = (accept: string): Request =>
  ({ headers: { accept } }) as unknown as Request;

/** Every SSE frame the handler wrote, parsed back out of the wire format. */
const eventsFrom = (chunks: string[]): Array<Record<string, unknown>> =>
  chunks
    .join('')
    .split('\n\n')
    .filter((f) => f.startsWith('data: '))
    .map((f) => JSON.parse(f.slice('data: '.length)) as Record<string, unknown>);

describe('a rate-limited browser gets something EventSource can actually read', () => {
  const accept = 'text/event-stream';

  it('answers 200, because EventSource cannot read a non-200 body at all', () => {
    // The status divergence is deliberate. A 429 here would be correct HTTP and
    // useless in practice: the browser would see a bare onerror with no code
    // and no message, and render the generic failure state.
    const { res, captured } = fakeRes();
    respondRateLimited(reqAccepting(accept), res);
    expect(captured.status).toBe(200);
    expect(captured.headers['Content-Type']).toBe('text/event-stream');
  });

  it('sends the ToolError as a stream event the existing client path renders', () => {
    const { res, captured } = fakeRes();
    respondRateLimited(reqAccepting(accept), res);

    const events = eventsFrom(captured.chunks);
    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();

    const tool = error!.error as { code: string; recoverable: boolean; message: string };
    expect(tool.code).toBe('RATE_LIMITED');
    // Load-bearing: the UI's retry affordance keys off this, and waiting really
    // does fix a rate limit — unlike most members of the error union.
    expect(tool.recoverable).toBe(true);
    expect(tool.message.length).toBeGreaterThan(0);
  });

  it('closes the stream cleanly rather than leaving it hanging', () => {
    // A stream that opens and never ends looks identical to a slow query. The
    // `done` event is what tells the client this is finished, not pending.
    const { res, captured } = fakeRes();
    respondRateLimited(reqAccepting(accept), res);
    expect(eventsFrom(captured.chunks).some((e) => e.type === 'done')).toBe(true);
    expect(captured.ended).toBe(true);
  });

  it('mentions breakage only to DENY it, never to assert it', () => {
    // The same shape as the coverage sentence, which names the senator only
    // inside "not a finding that the senator has no record". Banning the word
    // outright would ban the reassurance too — and the reassurance is the point,
    // because a rate limit is the one refusal where the tool is working fine.
    const { res, captured } = fakeRes();
    respondRateLimited(reqAccepting(accept), res);
    const message = (
      eventsFrom(captured.chunks).find((e) => e.type === 'error')!.error as { message: string }
    ).message.toLowerCase();

    for (const word of ['broken', 'error', 'failed']) {
      if (message.includes(word)) {
        expect(message, `"${word}" must appear negated`).toMatch(
          new RegExp(`(nothing|not|no)[^.]*${word}`),
        );
      }
    }
    // And it must say the thing that is actually true and actionable.
    expect(message).toMatch(/try again|few minutes/);
  });
});

describe('a rate-limited script gets correct HTTP', () => {
  it('answers 429 with the same envelope, as JSON', () => {
    // curl and any API consumer get the honest status. A 200 for a refused
    // request is a lie to a machine; the browser branch above is the exception
    // and it is bought with a transport that cannot read the truthful one.
    const { res, captured } = fakeRes();
    respondRateLimited(reqAccepting('application/json'), res);
    expect(captured.status).toBe(429);
    const body = captured.json as { error: { code: string; recoverable: boolean } };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.recoverable).toBe(true);
  });

  it('treats a missing Accept header as a script, not a browser', () => {
    const { res, captured } = fakeRes();
    respondRateLimited({ headers: {} } as unknown as Request, res);
    expect(captured.status).toBe(429);
  });

  it('describes the same event in both transports', () => {
    // One description of what happened, two wire formats. If these drift, a
    // reader and an integrator get different accounts of the same refusal.
    const browser = fakeRes();
    respondRateLimited(reqAccepting('text/event-stream'), browser.res);
    const script = fakeRes();
    respondRateLimited(reqAccepting('application/json'), script.res);

    const fromStream = eventsFrom(browser.captured.chunks).find((e) => e.type === 'error')!.error;
    const fromJson = (script.captured.json as { error: unknown }).error;
    expect(fromStream).toEqual(fromJson);
  });
});

describe('the health exemption, which shipped broken and reached production', () => {
  // The original predicate compared `req.path === '/api/health'`. Inside
  // `app.use('/api', ...)` Express rewrites req.path relative to the mount
  // point, so the probe arrives as '/health' and the comparison was NEVER true.
  // The exemption never fired; the deployed service was counting its own health
  // checks against the read-only limit. Caught by reading RateLimit headers off
  // production, not by any test — because no test exercised `skip` at all.

  /** The shape Express actually hands a middleware mounted at '/api'. */
  const mounted = (originalUrl: string) =>
    ({ path: originalUrl.replace(/^\/api/, ''), baseUrl: '/api', originalUrl }) as never;

  it('exempts the probe even though req.path says "/health"', () => {
    const req = mounted('/api/health');
    expect((req as { path: string }).path).toBe('/health'); // the trap, pinned
    expect(isHealthProbe(req)).toBe(true);
  });

  it('exempts it with a query string attached', () => {
    expect(isHealthProbe(mounted('/api/health?probe=render'))).toBe(true);
    expect(isHealthProbe(mounted('/api/health/'))).toBe(true);
  });

  it('does NOT exempt anything else, including a prefix lookalike', () => {
    // An exact match, not a prefix: /api/healthz is a different route and must
    // not inherit an exemption that exists to protect one specific probe.
    expect(isHealthProbe(mounted('/api/healthz'))).toBe(false);
    expect(isHealthProbe(mounted('/api/health/deep'))).toBe(false);
    expect(isHealthProbe(mounted('/api/query'))).toBe(false);
    expect(isHealthProbe(mounted('/api/senators'))).toBe(false);
  });

  it('is unbothered by a missing originalUrl', () => {
    expect(isHealthProbe({ originalUrl: undefined } as never)).toBe(false);
  });
});

describe('the limits are configuration, not literals', () => {
  it('reads every limit from config so a retune needs no code change', () => {
    expect(config.rateLimit.queryPer15Min).toBeGreaterThan(0);
    expect(config.rateLimit.queryPerDay).toBeGreaterThan(config.rateLimit.queryPer15Min);
    expect(config.rateLimit.readPer15Min).toBeGreaterThan(config.rateLimit.queryPer15Min);
  });

  it('trusts a hop COUNT, never `true`', () => {
    // `true` trusts the entire X-Forwarded-For chain, which a client can forge —
    // an abuser would mint a fresh limiter bucket per request. A number is the
    // only safe form, and 0 would mean the proxy's own address keys everyone
    // into one bucket.
    expect(typeof config.rateLimit.trustProxyHops).toBe('number');
    expect(config.rateLimit.trustProxyHops).toBeGreaterThanOrEqual(1);
  });
});
