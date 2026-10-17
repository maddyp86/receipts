import { describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import { createCheckout, fundingCredits, fundingStatus, handleWebhook, modeForOrigin, testReturnUrl, CREDIT_FIELD, type FundingDeps, type StripeLike } from './funding.js';
import { MemoryFundingStore, type FundableMember } from './FundingStore.js';

// ===========================================================================
// Funding a member's record. Three failures here would each be silent:
//
//   1. A webhook that trusts an unsigned body: anyone could mark a member
//      funded without paying.
//   2. A webhook that is not idempotent: Stripe retries, and one payment
//      would become two rows and a second "funded" claim.
//   3. Checkout that takes money for a member it cannot deliver: someone
//      already live, already funded, in the House, or out of office.
//
// The real Stripe SDK signs and verifies here (no network); only the
// checkout call is stood in for.
// ===========================================================================

const SECRET = 'whsec_test_secret';
const real = new Stripe('sk_test_not_a_real_key');

const MEMBERS: FundableMember[] = [
  { member_id: 'S001198', full_name: 'Dan Sullivan', chamber: 'Senate', live: false, left_at: null },
  { member_id: 'O000174', full_name: 'Jon Ossoff', chamber: 'Senate', live: true, left_at: null },
  { member_id: 'L000599', full_name: 'Michael Lawler', chamber: 'House', live: false, left_at: null },
  { member_id: 'G000359', full_name: 'Lindsey Graham', chamber: 'Senate', live: false, left_at: '2026-01-03' },
];

function deps(store = new MemoryFundingStore(MEMBERS)) {
  const created: Stripe.Checkout.SessionCreateParams[] = [];
  const stripe: StripeLike = {
    checkout: {
      sessions: {
        async create(params) {
          created.push(params);
          return { url: 'https://checkout.stripe.com/c/pay/cs_test_1' };
        },
      },
    },
    webhooks: real.webhooks,
  };
  const d: FundingDeps = {
    store,
    stripe,
    settings: { priceCents: 2000, currency: 'usd', slaDays: 14, returnUrl: 'https://receipts.example', webhookSecret: SECRET },
    livemode: false,
  };
  return { d, store, created };
}

function paidEvent(overrides: Partial<Record<string, unknown>> = {}, type = 'checkout.session.completed') {
  return JSON.stringify({
    id: 'evt_1',
    object: 'event',
    livemode: false,
    type,
    created: Date.UTC(2026, 9, 15) / 1000,
    data: {
      object: {
        id: 'cs_test_1',
        object: 'checkout.session',
        payment_status: 'paid',
        amount_total: 2000,
        currency: 'usd',
        metadata: { member_id: 'S001198' },
        customer_details: { email: 'reader@example.com' },
        custom_fields: [{ key: CREDIT_FIELD, type: 'text', text: { value: '  A reader in Anchorage ' } }],
        ...overrides,
      },
    },
  });
}

const sign = (payload: string, secret = SECRET) => real.webhooks.generateTestHeaderString({ payload, secret });

describe('createCheckout', () => {
  it('opens a session for a senator who is not live, carrying the member id and the price', async () => {
    const { d, created } = deps();
    const out = await createCheckout('S001198', d);
    expect(out).toEqual({ ok: true, url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    expect(created).toHaveLength(1);
    expect(created[0]!.metadata).toEqual({ member_id: 'S001198' });
    expect(created[0]!.line_items![0]!.price_data!.unit_amount).toBe(2000);
    expect(created[0]!.success_url).toBe('https://receipts.example/?funded=S001198&session_id={CHECKOUT_SESSION_ID}');
    // The promise and the not-a-donation line travel onto Stripe's own page.
    expect(created[0]!.line_items![0]!.price_data!.product_data!.description).toMatch(/within 14 days, or a full refund\..*sponsor.*Not tax-deductible/);
  });

  it.each([
    ['O000174', 409, /already checked/],
    ['G000359', 409, /no longer in office/],
    ['X000000', 404, /on file/],
    ['not-an-id', 400, /not a member id/],
  ])('refuses %s without calling Stripe', async (id, status, message) => {
    const { d, created } = deps();
    const out = await createCheckout(id, d);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(status);
      expect(out.message).toMatch(message);
    }
    expect(created).toHaveLength(0);
  });

  it('refuses a member who already has a sponsor', async () => {
    const { d, store, created } = deps();
    await handleWebhook(paidEvent(), sign(paidEvent()), { live: null, test: d });
    expect(store.rows).toHaveLength(1);
    const out = await createCheckout('S001198', d);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toMatch(/already has a sponsor/);
    expect(created).toHaveLength(0);
  });
});

describe('createCheckout for the House', () => {
  it('opens a session for a House member who is not live', async () => {
    const { d, created } = deps();
    const out = await createCheckout('L000599', d);
    expect(out.ok).toBe(true);
    expect(created[0]!.metadata).toEqual({ member_id: 'L000599' });
    expect(created[0]!.line_items![0]!.price_data!.product_data!.description).toMatch(/Michael Lawler’s votes/);
  });
});

describe('handleWebhook', () => {
  it('records a paid session once, with the promised date and the trimmed credit name', async () => {
    const { d, store } = deps();
    const body = paidEvent();
    const out = await handleWebhook(Buffer.from(body), sign(body), { live: null, test: d });
    expect(out).toEqual({ status: 200, body: { recorded: true } });
    expect(store.rows).toEqual([
      {
        member_id: 'S001198',
        stripe_session_id: 'cs_test_1',
        amount_cents: 2000,
        currency: 'usd',
        email: 'reader@example.com',
        display_name: 'A reader in Anchorage',
        refund_due_at: new Date(Date.UTC(2026, 9, 29)),
        livemode: false,
      },
    ]);
  });

  it('writes nothing more when Stripe retries the same event', async () => {
    const { d, store } = deps();
    const body = paidEvent();
    await handleWebhook(body, sign(body), { live: null, test: d });
    const again = await handleWebhook(body, sign(body), { live: null, test: d });
    expect(again).toEqual({ status: 200, body: { recorded: false } });
    expect(store.rows).toHaveLength(1);
  });

  it('refuses a body that is unsigned, signed with another secret, or altered after signing', async () => {
    const { d, store } = deps();
    const body = paidEvent();
    expect((await handleWebhook(body, undefined, { live: null, test: d })).status).toBe(400);
    expect((await handleWebhook(body, sign(body, 'whsec_someone_else'), { live: null, test: d })).status).toBe(400);
    const altered = body.replace('S001198', 'C001035');
    expect((await handleWebhook(altered, sign(body), { live: null, test: d })).status).toBe(400);
    expect(store.rows).toHaveLength(0);
  });

  it('ignores an unpaid session and an event for something else', async () => {
    const { d, store } = deps();
    const unpaid = paidEvent({ payment_status: 'unpaid' });
    expect((await handleWebhook(unpaid, sign(unpaid), { live: null, test: d })).body).toEqual({ ignored: 'checkout.session.completed' });
    const noMember = paidEvent({ metadata: {} });
    expect((await handleWebhook(noMember, sign(noMember), { live: null, test: d })).body).toEqual({ ignored: 'no member_id' });
    expect(store.rows).toHaveLength(0);
  });

  it('records a delayed payment when it succeeds', async () => {
    const { d, store } = deps();
    const body = paidEvent({ payment_status: 'unpaid' }, 'checkout.session.async_payment_succeeded');
    expect((await handleWebhook(body, sign(body), { live: null, test: d })).status).toBe(200);
    expect(store.rows).toHaveLength(1);
  });

  it('answers 500 when the row cannot be stored, so Stripe retries', async () => {
    const store = new MemoryFundingStore(MEMBERS);
    store.record = async () => {
      throw new Error('relation "app.member_funding" does not exist');
    };
    const { d } = deps(store);
    const body = paidEvent();
    expect((await handleWebhook(body, sign(body), { live: null, test: d })).status).toBe(500);
  });
});

describe('fundingStatus', () => {
  it('lists funded members with the day they are promised by', async () => {
    const { d } = deps();
    const body = paidEvent();
    await handleWebhook(body, sign(body), { live: null, test: d });
    expect(await fundingStatus(d)).toEqual({
      enabled: true,
      mode: 'test',
      credits: [],
      price_cents: 2000,
      currency: 'usd',
      sla_days: 14,
      funded: [{ member_id: 'S001198', live_by: '2026-10-29' }],
    });
  });
});

describe('funder credits', () => {
  it('lists only names an operator has set live', async () => {
    const { d, store } = deps();
    const body = paidEvent();
    await handleWebhook(body, sign(body), { live: null, test: d });
    // Paid but not live: a name given at checkout is not shown yet.
    expect((await fundingStatus(d)).credits).toEqual([]);
    store.live.push({ member_id: 'S001198', name: 'A reader in Anchorage' });
    expect((await fundingStatus(d)).credits).toEqual([{ member_id: 'S001198', name: 'A reader in Anchorage' }]);
  });

  it('a credits read that fails (migration 019 not run) is no credits, not a failed status', async () => {
    const store = new MemoryFundingStore(MEMBERS);
    store.credits = async () => {
      throw new Error('permission denied for table member_funding');
    };
    expect(await fundingCredits(store, false)).toEqual([]);
    expect((await fundingStatus(deps(store).d)).credits).toEqual([]);
  });

  it('asks at checkout for a sponsor name, and says we will email', async () => {
    const { d, created } = deps();
    await createCheckout('S001198', d);
    const field = created[0]!.custom_fields![0]!;
    expect(field.label.custom).toMatch(/sponsor/);
    expect(field.optional).toBe(true);
    expect(created[0]!.line_items![0]!.price_data!.product_data!.description).toMatch(/email you when it’s ready/);
  });
});

// ===========================================================================
// Test and live on one server. The live site must never show a test
// sponsorship, and a test signature must never record a live one.
// ===========================================================================

const LIVE_SECRET = 'whsec_live_secret';

function twoModes() {
  const store = new MemoryFundingStore(MEMBERS);
  const test = deps(store).d;
  const live: FundingDeps = { ...test, livemode: true, settings: { ...test.settings, webhookSecret: LIVE_SECRET } };
  return { store, test, live, modes: { live, test } };
}

const withMode = (body: string, livemode: boolean) => body.replace('"livemode":false', `"livemode":${livemode}`);

describe('which mode a request is in', () => {
  const LIVE = ['receipts-eight-tau.vercel.app'];
  it('only a listed production host is live', () => {
    expect(modeForOrigin('https://receipts-eight-tau.vercel.app', LIVE)).toBe('live');
    expect(modeForOrigin('https://receipts-git-feat-x-litsaber.vercel.app', LIVE)).toBe('test');
    expect(modeForOrigin('http://localhost:5173', LIVE)).toBe('test');
  });
  it('no origin, or a malformed one, is test (the harmless side)', () => {
    expect(modeForOrigin(null, LIVE)).toBe('test');
    expect(modeForOrigin('not a url', LIVE)).toBe('test');
    expect(modeForOrigin('https://receipts-eight-tau.vercel.app', [])).toBe('test');
  });
  it('a test payer goes back to the preview they came from, never to an arbitrary site', () => {
    const fallback = 'https://receipts-eight-tau.vercel.app';
    expect(testReturnUrl('https://receipts-git-feat-x-litsaber.vercel.app', fallback)).toBe('https://receipts-git-feat-x-litsaber.vercel.app');
    expect(testReturnUrl('http://localhost:5173', fallback)).toBe('http://localhost:5173');
    expect(testReturnUrl('https://evil.example', fallback)).toBe(fallback);
    expect(testReturnUrl('http://receipts.vercel.app', fallback)).toBe(fallback);
  });
});

describe('the webhook with both modes', () => {
  it('labels a test payment test and a live payment live', async () => {
    const { store, modes } = twoModes();
    const t = paidEvent();
    expect((await handleWebhook(t, sign(t), modes)).status).toBe(200);
    const l = withMode(paidEvent({ id: 'cs_live_1' }), true);
    expect((await handleWebhook(l, sign(l, LIVE_SECRET), modes)).status).toBe(200);
    expect(store.rows.map((r) => [r.stripe_session_id, r.livemode])).toEqual([['cs_test_1', false], ['cs_live_1', true]]);
  });

  it('refuses an event whose mode does not match the secret that signed it', async () => {
    const { store, modes } = twoModes();
    const liveClaim = withMode(paidEvent(), true);
    expect((await handleWebhook(liveClaim, sign(liveClaim), modes)).status).toBe(400);
    expect(store.rows).toHaveLength(0);
  });

  it('with only test keys, a live-signed event does not verify', async () => {
    const { store, test } = twoModes();
    const l = withMode(paidEvent(), true);
    expect((await handleWebhook(l, sign(l, LIVE_SECRET), { live: null, test })).status).toBe(400);
    expect(store.rows).toHaveLength(0);
  });
});

describe('each site sees only its own mode', () => {
  it('a test sponsorship shows on previews, never on the live site', async () => {
    const { modes, test, live } = twoModes();
    const t = paidEvent();
    await handleWebhook(t, sign(t), modes);
    expect((await fundingStatus(test)).funded.map((f) => f.member_id)).toEqual(['S001198']);
    expect((await fundingStatus(live)).funded).toEqual([]);
    expect((await fundingStatus(live)).mode).toBe('live');
  });

  it('a test sponsorship does not block a real one for the same member', async () => {
    const { modes, live, test } = twoModes();
    const t = paidEvent();
    await handleWebhook(t, sign(t), modes);
    expect((await createCheckout('S001198', test)).ok).toBe(false);
    expect((await createCheckout('S001198', live)).ok).toBe(true);
  });

  it('credits follow the mode too', async () => {
    const { store, live, test } = twoModes();
    store.live.push({ member_id: 'S001198', name: 'Tester' }, { member_id: 'S001198', name: 'Real Sponsor', livemode: true });
    expect((await fundingStatus(live)).credits).toEqual([{ member_id: 'S001198', name: 'Real Sponsor' }]);
    expect((await fundingStatus(test)).credits).toEqual([{ member_id: 'S001198', name: 'Tester' }]);
  });

  it('a test checkout returns to the preview it came from', async () => {
    const { d, created } = deps();
    await createCheckout('S001198', d, 'https://receipts-git-x-litsaber.vercel.app');
    expect(created[0]!.success_url).toMatch(/^https:\/\/receipts-git-x-litsaber\.vercel\.app\/\?funded=S001198/);
  });
});

