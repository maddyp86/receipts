import { describe, expect, it } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import type pg from 'pg';
import {
  capacityError,
  dailyLimitError,
  globalDailyCap,
  whenUtc,
} from './rateLimit.js';
import { MemoryUsageCounter, SupabaseUsageCounter, utcDay } from './data/UsageCounter.js';

// ===========================================================================
// The global daily cap — beta readiness, item 2.
//
// The per-IP limits (#10) bound one caller. This bounds the bill: N paid
// requests per UTC day across everyone. The count is persisted (migration
// 011) because the free tier restarts the service; without the table it
// carries on in memory rather than switching the cap off.
// ===========================================================================

function fakeRes() {
  const captured = { status: null as number | null, chunks: [] as string[], json: null as unknown };
  const res = {
    status(code: number) { captured.status = code; return this; },
    set() { return this; },
    write(chunk: string) { captured.chunks.push(chunk); return true; },
    json(body: unknown) { captured.json = body; return this; },
    end() { return this; },
  } as unknown as Response;
  return { res, captured };
}
const req = (accept = 'application/json') => ({ headers: { accept } }) as unknown as Request;

async function call(mw: ReturnType<typeof globalDailyCap>, accept?: string) {
  const { res, captured } = fakeRes();
  let passed = false;
  await mw(req(accept), res, (() => { passed = true; }) as NextFunction);
  return { passed, captured };
}

const NOON = new Date('2026-10-04T12:00:00Z');

describe('the cap', () => {
  it('admits up to the limit, then refuses everyone for the rest of the UTC day', async () => {
    const mw = globalDailyCap(new MemoryUsageCounter(), 3, () => NOON);
    for (let i = 0; i < 3; i++) expect((await call(mw)).passed).toBe(true);
    const fourth = await call(mw);
    expect(fourth.passed).toBe(false);
    expect(fourth.captured.status).toBe(503);
    expect((fourth.captured.json as { error: { code: string } }).error.code).toBe('CAPACITY_REACHED');
  });

  it('starts again at midnight UTC', async () => {
    let now = new Date('2026-10-04T23:59:00Z');
    const mw = globalDailyCap(new MemoryUsageCounter(), 1, () => now);
    expect((await call(mw)).passed).toBe(true);
    expect((await call(mw)).passed).toBe(false);
    now = new Date('2026-10-05T00:00:30Z');
    expect((await call(mw)).passed).toBe(true);
  });

  // EventSource sees no status and no body on a non-200; the browser gets the
  // message as an SSE error event, like the per-IP limits.
  it('tells a browser in the shape it can read', async () => {
    const mw = globalDailyCap(new MemoryUsageCounter(), 0, () => NOON);
    const { captured } = await call(mw, 'text/event-stream');
    expect(captured.status).toBe(200);
    const event = JSON.parse(captured.chunks[0]!.replace(/^data: /, ''));
    expect(event.type).toBe('error');
    expect(event.error.code).toBe('CAPACITY_REACHED');
  });
});

describe('what the reader is told', () => {
  it('global: shared budget, when it resets, nothing broken, no retry button', () => {
    const e = capacityError(NOON);
    expect(e.message).toMatch(/limit of checks for today/);
    expect(e.message).toMatch(/shared by everyone testing it/);
    expect(e.message).toMatch(/resets at October 5 at 12:00 AM UTC/);
    expect(e.message).toMatch(/Nothing is broken/);
    expect(e.recoverable).toBe(false);
  });

  // The per-IP daily cap used the burst copy: "Give it a few minutes". Its
  // window is a day.
  it('per-IP daily: says when it lifts, not "a few minutes"', () => {
    const e = dailyLimitError(60, new Date('2026-10-05T09:30:00Z'));
    expect(e.message).toMatch(/today's limit of 60 checks from your connection/);
    expect(e.message).toMatch(/after October 5 at 9:30 AM UTC/);
    expect(e.message).not.toMatch(/few minutes/);
    expect(e.recoverable).toBe(false);
    expect(dailyLimitError(60, undefined).message).toMatch(/tomorrow/);
  });

  it('writes times in UTC', () => {
    expect(whenUtc(new Date('2026-10-05T15:07:00Z'))).toBe('October 5 at 3:07 PM UTC');
  });
});

// A pool that answers from a function, so the database path runs without one.
function fakePool(answer: () => Promise<{ rows: Array<{ queries: number }> }>) {
  return { query: answer, on() {}, end: async () => {} } as unknown as pg.Pool;
}

describe('the persisted count', () => {
  it('uses the database count when it is available', async () => {
    let n = 41;
    const c = new SupabaseUsageCounter('', fakePool(async () => ({ rows: [{ queries: ++n }] })));
    expect(await c.increment('2026-10-04')).toBe(42);
    expect(c.isDegraded).toBe(false);
  });

  // The whole point of the table: a restarted process starts at 0 in memory,
  // but the day's count is still there.
  it('survives a restart', async () => {
    const db = { count: 0 };
    const pool = fakePool(async () => ({ rows: [{ queries: ++db.count }] }));
    const before = new SupabaseUsageCounter('', pool);
    for (let i = 0; i < 5; i++) await before.increment('2026-10-04');
    const after = new SupabaseUsageCounter('', pool);
    expect(await after.increment('2026-10-04')).toBe(6);
  });

  // Fails to memory, never open; tries the database again after a pause; and
  // never under-counts what this process saw during the gap.
  it('falls back to memory, retries after five minutes, and keeps the larger count', async () => {
    let t = 0;
    let up = false;
    let dbCount = 0;
    const c = new SupabaseUsageCounter(
      '',
      fakePool(async () => {
        if (!up) throw new Error('relation "app.app_usage_daily" does not exist');
        return { rows: [{ queries: ++dbCount }] };
      }),
      () => t,
    );
    expect(await c.increment('d')).toBe(1);
    expect(c.isDegraded).toBe(true);
    expect(await c.increment('d')).toBe(2); // memory, database not retried yet
    up = true;
    expect(await c.increment('d')).toBe(3); // still inside the pause
    t = 5 * 60 * 1000;
    expect(await c.increment('d')).toBe(4); // database says 1, memory says 4
    expect(c.isDegraded).toBe(false);
  });
});

describe('utcDay', () => {
  it('is the UTC calendar day', () => {
    expect(utcDay(new Date('2026-10-04T23:30:00-07:00'))).toBe('2026-10-05');
  });
});
