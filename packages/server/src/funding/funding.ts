import type Stripe from 'stripe';
import type { FunderCredit, FundingStore } from './FundingStore.js';

// ===========================================================================
// A reader funds a not-yet-checked member's record (Senate or House).
//
// WHAT A PAYMENT BUYS: the work of adding the member, once, for everyone. It
// never buys a finding. The member goes through the same pipeline and the
// same hand review as any other, and nothing here can change a verdict.
//
// WHAT A PAYMENT DOES NOT DO: add the member. The webhook writes one row to
// app.member_funding and stops. An operator runs the Phase 4 steps
// (plan.md, "Funded members"); a row not live by refund_due_at is refunded.
//
// Card details never reach this server: Stripe Checkout hosts the form. Not
// called a donation anywhere — without a 501(c)(3) it is a purchase of a
// service, and the copy says it is not tax-deductible.
// ===========================================================================

export interface FundingSettings {
  priceCents: number;
  currency: string;
  slaDays: number;
  returnUrl: string;
  webhookSecret: string;
}

/** The two Stripe calls this module makes, so a test can stand in for checkout. */
export interface StripeLike {
  checkout: { sessions: { create(params: Stripe.Checkout.SessionCreateParams): Promise<{ url: string | null }> } };
  webhooks: Pick<Stripe['webhooks'], 'constructEvent'>;
}

/** One Stripe mode's wiring. A server holds up to two: live and test. */
export interface FundingDeps {
  store: FundingStore;
  stripe: StripeLike;
  settings: FundingSettings;
  /** True for the live keys (real money), false for the test keys. */
  livemode: boolean;
}

/** The modes this server has keys for. */
export interface FundingModes {
  live: FundingDeps | null;
  test: FundingDeps | null;
}

/**
 * Which Stripe mode a request belongs to, from the site the reader is on.
 * Live only for a host listed as live (the production site); everything else
 * (Vercel previews, localhost, a request with no origin) is test. Getting
 * this wrong the safe way round costs nothing: a test checkout moves no money
 * and its row never shows on the live site.
 */
export function modeForOrigin(origin: string | null | undefined, liveHosts: readonly string[]): 'live' | 'test' {
  if (!origin) return 'test';
  try {
    return liveHosts.includes(new URL(origin).host.toLowerCase()) ? 'live' : 'test';
  } catch {
    return 'test';
  }
}

/**
 * Where to send a TEST payer back: the preview or local site they came from,
 * when it looks like one of ours; otherwise the configured site. A live payer
 * always goes to the configured production site.
 */
export function testReturnUrl(origin: string | null | undefined, fallback: string): string {
  if (!origin) return fallback;
  try {
    const u = new URL(origin);
    const ok =
      (u.protocol === 'https:' && u.hostname.endsWith('.vercel.app')) ||
      (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'));
    return ok ? u.origin : fallback;
  } catch {
    return fallback;
  }
}

export type Refusal = { ok: false; status: number; code: 'BAD_INPUT' | 'NOT_FUNDABLE' | 'UPSTREAM_UNAVAILABLE'; message: string };

const MEMBER_ID = /^[A-Z]\d{6}$/;
/** The Checkout custom field that carries the opt-in credit name. */
export const CREDIT_FIELD = 'credit_name';

/**
 * Start a Checkout Session for one member, or say why not.
 *
 * Refused for: an unknown id, a member who has left office, one already live, and one someone has
 * already funded. Two readers paying in the same minute can still both get
 * through; the operator refunds the second.
 */
export async function createCheckout(
  memberId: string,
  deps: FundingDeps,
  returnTo?: string,
): Promise<{ ok: true; url: string } | Refusal> {
  const id = memberId.trim();
  if (!MEMBER_ID.test(id)) return { ok: false, status: 400, code: 'BAD_INPUT', message: 'memberId is not a member id.' };

  const member = await deps.store.member(id);
  if (!member) return { ok: false, status: 404, code: 'NOT_FUNDABLE', message: 'We don’t have that member on file.' };
  if (member.left_at) return { ok: false, status: 409, code: 'NOT_FUNDABLE', message: `${member.full_name} is no longer in office.` };
  if (member.live) return { ok: false, status: 409, code: 'NOT_FUNDABLE', message: `${member.full_name}’s record is already checked.` };
  if ((await deps.store.open(deps.livemode)).some((o) => o.member_id === id)) {
    return { ok: false, status: 409, code: 'NOT_FUNDABLE', message: `${member.full_name}’s record already has a sponsor.` };
  }

  const { priceCents, currency, slaDays } = deps.settings;
  const returnUrl = (returnTo || deps.settings.returnUrl).replace(/\/+$/, '');
  const session = await deps.stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency,
          unit_amount: priceCents,
          product_data: {
            name: `Sponsor ${member.full_name}’s record on Receipts`,
            description:
              `We check ${member.full_name}’s votes and the bills they’ve backed, and email you when it’s ready: ` +
              `within ${slaDays} days, or a full refund. Your name appears as the record’s sponsor if you give one. Not tax-deductible.`,
          },
        },
      },
    ],
    metadata: { member_id: id },
    payment_intent_data: { metadata: { member_id: id } },
    custom_fields: [
      {
        key: CREDIT_FIELD,
        label: { type: 'custom', custom: 'Name to show as sponsor (optional)' },
        type: 'text',
        optional: true,
        text: { maximum_length: 80 },
      },
    ],
    success_url: `${returnUrl}/?funded=${encodeURIComponent(id)}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${returnUrl}/`,
  });
  if (!session.url) return { ok: false, status: 502, code: 'UPSTREAM_UNAVAILABLE', message: 'The payment page could not be opened.' };
  return { ok: true, url: session.url };
}

/**
 * The Stripe webhook, one address for both modes. Verifies the signature
 * against the RAW body with each mode's secret, and accepts the event only if
 * its own livemode matches the secret that verified it. Then records a paid
 * session for a member, labelled with that mode. Idempotent: Stripe retries,
 * and a repeated event writes nothing.
 *
 * Returns 500 when the row could not be stored, so Stripe retries rather than
 * the payment going unrecorded.
 */
export async function handleWebhook(
  rawBody: Buffer | string,
  signature: string | undefined,
  modes: FundingModes,
): Promise<{ status: number; body: Record<string, unknown> }> {
  let event: Stripe.Event | null = null;
  let deps: FundingDeps | null = null;
  for (const candidate of [modes.live, modes.test]) {
    if (!candidate) continue;
    try {
      event = candidate.stripe.webhooks.constructEvent(rawBody, signature ?? '', candidate.settings.webhookSecret);
      deps = candidate;
      break;
    } catch {
      /* Not this mode's secret; try the other. */
    }
  }
  if (!event || !deps) return { status: 400, body: { error: 'Signature did not verify.' } };
  if (event.livemode !== deps.livemode) {
    return { status: 400, body: { error: 'Event mode does not match the secret that signed it.' } };
  }

  const paid =
    (event.type === 'checkout.session.completed' && event.data.object.payment_status === 'paid') ||
    event.type === 'checkout.session.async_payment_succeeded';
  if (!paid) return { status: 200, body: { ignored: event.type } };

  const session = event.data.object as Stripe.Checkout.Session;
  const memberId = session.metadata?.member_id ?? '';
  if (!MEMBER_ID.test(memberId)) return { status: 200, body: { ignored: 'no member_id' } };

  const credit = session.custom_fields?.find((f) => f.key === CREDIT_FIELD)?.text?.value?.trim() || null;
  const paidAt = new Date(event.created * 1000);
  try {
    const written = await deps.store.record({
      member_id: memberId,
      stripe_session_id: session.id,
      amount_cents: session.amount_total ?? 0,
      currency: session.currency ?? deps.settings.currency,
      email: session.customer_details?.email ?? null,
      display_name: credit ? credit.slice(0, 80) : null,
      refund_due_at: new Date(paidAt.getTime() + deps.settings.slaDays * 86_400_000),
      livemode: deps.livemode,
    });
    if (written) console.info(`[funding] ${memberId} funded, ${deps.livemode ? 'LIVE' : 'test'} (session ${session.id})`);
    return { status: 200, body: { recorded: written } };
  } catch (err) {
    console.error('[funding] could not record a paid session:', session.id, err instanceof Error ? err.message : err);
    return { status: 500, body: { error: 'Not recorded; retry.' } };
  }
}

/**
 * Public funder credits. A read that fails (migration 019 not run yet) is no
 * credits, never a failed page: the credit is a thank-you, not the record.
 */
export async function fundingCredits(store: FundingStore, livemode: boolean): Promise<FunderCredit[]> {
  try {
    return await store.credits(livemode);
  } catch (err) {
    console.warn('[funding] credits not readable (has migration 019 run?):', err instanceof Error ? err.message : err);
    return [];
  }
}

/** For the picker: who is funded, the day each is promised by, and who to credit. */
export async function fundingStatus(deps: Pick<FundingDeps, 'store' | 'settings' | 'livemode'>) {
  const open = await deps.store.open(deps.livemode);
  return {
    enabled: true,
    // Lets a preview say it is taking test payments; the live site never shows it.
    mode: deps.livemode ? 'live' : 'test',
    credits: await fundingCredits(deps.store, deps.livemode),
    price_cents: deps.settings.priceCents,
    currency: deps.settings.currency,
    sla_days: deps.settings.slaDays,
    funded: open.map((o) => ({ member_id: o.member_id, live_by: new Date(o.refund_due_at).toISOString().slice(0, 10) })),
  };
}
