import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { apiUrl } from '../../lib/api.js';

// ===========================================================================
// "Fund this record": a reader pays once to have a not-yet-checked senator
// added, for everyone. Shown only when the server says funding is on.
//
// The copy carries three promises and must keep all of them: the money pays
// for the work, never a finding; live by a date or a full refund; and it is
// not a donation (not tax-deductible).
// ===========================================================================

export interface FundingStatus {
  enabled: boolean;
  price_cents?: number;
  currency?: string;
  sla_days?: number;
  funded?: { member_id: string; live_by: string }[];
  /** Names credited on live records, chosen by the payer and seen by an operator first. */
  credits?: { member_id: string; name: string }[];
}

const OFF: FundingStatus = { enabled: false };
const FundingContext = createContext<FundingStatus>(OFF);

export function FundingProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<FundingStatus>(OFF);
  useEffect(() => {
    fetch(apiUrl('/api/fund/status'))
      .then((r) => r.json())
      // Off still carries credits: a funded record keeps its thank-you.
      .then((d: FundingStatus) => setStatus(d?.enabled ? d : { enabled: false, credits: d?.credits ?? [] }))
      .catch(() => {
        /* No status: no button. Nothing else depends on it. */
      });
  }, []);
  return <FundingContext.Provider value={status}>{children}</FundingContext.Provider>;
}

export function useFundingStatus(): FundingStatus {
  return useContext(FundingContext);
}

export function formatPrice(cents: number, currency = 'usd'): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: whole ? 0 : 2,
  }).format(cents / 100);
}

/** "December 1", from a yyyy-mm-dd day, without a time-zone shift. */
export function formatDay(isoDay: string): string {
  const [y = 1970, m = 1, d = 1] = isoDay.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/**
 * The button, or the "already funded" line, for one senator who is not
 * checked yet. Renders nothing when funding is off.
 */
export function FundRecord({ memberId, name }: { memberId: string; name: string }) {
  const status = useFundingStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!status.enabled || !status.price_cents) return null;

  const funded = status.funded?.find((f) => f.member_id === memberId);
  if (funded) {
    return (
      <p className="mt-2 text-[15px] leading-snug text-ink" data-funded="true">
        Funded by a reader. Live for everyone by {formatDay(funded.live_by)}.
      </p>
    );
  }

  const price = formatPrice(status.price_cents, status.currency);
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(apiUrl('/api/fund/checkout'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId }),
      });
      const d = await r.json();
      if (r.ok && typeof d.url === 'string') {
        window.location.assign(d.url);
        return;
      }
      setError(d?.error?.message ?? 'The payment page could not be opened.');
    } catch {
      setError('The payment page could not be opened. Please try again.');
    }
    setBusy(false);
  };

  return (
    <div className="mt-3 space-y-2">
      <button
        type="button"
        onClick={start}
        disabled={busy}
        aria-label={`Fund ${name}’s record, ${price}`}
        className="inline-flex min-h-[44px] items-center justify-center rounded-card border border-ink bg-card px-4 text-[15px] font-semibold text-ink transition-colors duration-150 hover:bg-paper disabled:border-rule disabled:text-ink-soft"
      >
        {busy ? 'Opening payment…' : `Fund this record — ${price}`}
      </button>
      <p className="text-[14px] leading-snug text-ink-soft">
        Covers what it costs us to check this record, once. When it’s done it’s free for everyone, and
        we’ll email you to come and check it. Add a name at checkout and we’ll credit you on the record.
        Live within {status.sla_days} days or a full refund. Paying never changes what we find. Not a
        tax-deductible donation.
      </p>
      {error ? (
        <p className="text-[14px] leading-snug text-broken" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** After Stripe sends the reader back: a thank-you, read from the URL. */
export function FundedThanks({ memberName, onClose }: { memberName: string | null; onClose: () => void }) {
  const status = useFundingStatus();
  return (
    <div role="status" className="mx-auto mt-4 max-w-[720px] rounded-card border border-rule bg-card px-5 py-4 shadow-soft">
      <p className="text-[17px] font-semibold text-ink">Thank you, your payment went through.</p>
      <p className="mt-1 text-[15px] leading-relaxed text-ink-soft">
        We’ll check {memberName ?? 'this senator'}’s record and make it free for everyone
        {status.sla_days ? ` within ${status.sla_days} days` : ''}, and email you when it’s ready to check.
        If we don’t, you get a full refund. Stripe has emailed your receipt.
      </p>
      <button type="button" onClick={onClose} className="mt-2 text-[15px] font-medium text-ink underline underline-offset-2">
        Close
      </button>
    </div>
  );
}

/** "Record funded by …" for a live record whose payer gave a name. Nothing otherwise. */
export function FunderCredit({ memberId, className = '' }: { memberId: string; className?: string }) {
  const names = (useFundingStatus().credits ?? []).filter((c) => c.member_id === memberId).map((c) => c.name);
  if (!names.length) return null;
  return (
    // A span, not a p: it sits inside the cards' own <p> and <button>.
    <span className={`block text-[14px] leading-snug text-ink-soft ${className}`} data-funder-credit="true">
      Record funded by <span className="font-medium text-ink">{names.join(', ')}</span>
    </span>
  );
}
