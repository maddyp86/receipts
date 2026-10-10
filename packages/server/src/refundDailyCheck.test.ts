import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queryDailyLimiter, refundDailyCheck } from './rateLimit.js';

// ===========================================================================
// A "which way?" stop does not use one of the reader's daily checks.
// The real daily limiter, in front of a route that refunds when asked.
// ===========================================================================

let base = '';
let close: () => void = () => {};

beforeAll(async () => {
  const app = express();
  app.get('/q', queryDailyLimiter, async (req, res) => {
    if (req.query.clarify) await refundDailyCheck(req);
    res.json({ ok: true });
  });
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());

/** Checks left after this request, from the standard RateLimit header (draft-8: r=…). */
async function remainingAfter(path: string): Promise<number> {
  const res = await fetch(base + path);
  return Number(/r=(\d+)/.exec(res.headers.get('ratelimit') ?? '')?.[1]);
}

describe('refundDailyCheck', () => {
  it('a check that ends in "which way?" is given back; an ordinary check is not', async () => {
    const r1 = await remainingAfter('/q');
    const r2 = await remainingAfter('/q?clarify=1'); // counted here, then refunded
    expect(r2).toBe(r1 - 1);
    const r3 = await remainingAfter('/q');
    expect(r3).toBe(r1 - 1);
    const r4 = await remainingAfter('/q');
    expect(r4).toBe(r1 - 2);
  });
});
