import { describe, expect, it } from 'vitest';
import { NullQueryStore } from './QueryStore.js';
import { SupabaseQueryStore } from './SupabaseQueryStore.js';

// ===========================================================================
// What can be verified without a live Postgres.
//
// The SQL round-trip cannot be tested here — there is no local Postgres or
// Docker in this environment. What IS tested is the seam's contract and the
// guards that must hold before a query ever reaches the database.
// ===========================================================================

describe('the seam stays aggregate-read-free', () => {
  it('exposes only startSession, saveQuery and getQuery', () => {
    // The moment this interface can answer "what has anyone else asked about
    // this senator", it becomes possible to let that influence a verdict — and
    // it would look like an ordinary feature in review. The absence of those
    // methods is the design, so it is asserted.
    const methods = ['startSession', 'saveQuery', 'getQuery'];
    const stores: unknown[] = [
      new NullQueryStore(),
      new SupabaseQueryStore('postgresql://x@127.0.0.1:1/x'),
    ];
    for (const store of stores) {
      const bag = store as Record<string, unknown>;
      for (const m of methods) expect(typeof bag[m]).toBe('function');
      for (const forbidden of ['countQueriesFor', 'getSimilarQueries', 'listQueries', 'search']) {
        expect(bag[forbidden]).toBeUndefined();
      }
    }
  });
});

describe('NullQueryStore is honest rather than plausible', () => {
  it('returns null from getQuery instead of reconstructing a result', async () => {
    // A share link built on it reports "not found", which is true. It is not a
    // stub that pretends the write landed.
    expect(await new NullQueryStore().getQuery('any-id')).toBeNull();
  });

  it('reports kind as local so the banner cannot claim persistence', () => {
    expect(new NullQueryStore().kind).toBe('local');
  });
});

describe('SupabaseQueryStore guards', () => {
  const store = new SupabaseQueryStore('postgresql://receipts_app:pw@127.0.0.1:1/postgres');

  it('rejects a malformed id without touching the database', async () => {
    // Reaching Postgres with a non-uuid would raise a cast error; a bad link is
    // a miss, not a fault. This resolves instantly because no connection is
    // attempted — if it ever tried, this test would hang on the dead port.
    expect(await store.getQuery('not-a-uuid')).toBeNull();
    expect(await store.getQuery('')).toBeNull();
    expect(await store.getQuery('11111111-1111-1111-1111-11111111111')).toBeNull(); // one short
  });

  it('reports kind as supabase', () => {
    expect(store.kind).toBe('supabase');
  });

  it('surfaces a connection failure without throwing', async () => {
    // verifyConnection must never throw: it runs at startup and persistence is
    // best effort. A database that is down must not stop the service booting.
    const result = await store.verifyConnection();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(typeof result.error).toBe('string');
  });
});
