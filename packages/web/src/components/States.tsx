import type { Senator, ToolError } from '@receipts/shared';

// ===========================================================================
// Honest states.
//
// A thin result gets as much design care as a strong one. None of these are
// error screens dressed up — they are answers, and each says specifically what
// happened rather than shrugging.
// ===========================================================================

export function DemoBanner({ demo, fixture }: { demo: boolean; fixture: boolean }) {
  if (!demo && !fixture) return null;

  const parts: string[] = [];
  if (fixture) parts.push('the bills shown are sample data, not this senator’s real record');
  if (demo) parts.push('the interpretation and explanation are canned, not written for you');

  return (
    <div className="banner" role="status">
      <span aria-hidden="true">▲</span>
      <span>
        <strong>Demo mode.</strong> No API keys are configured, so {parts.join(', and ')}. Nothing
        here is a real accountability finding.
      </span>
    </div>
  );
}

export function UncachedState({
  senator,
  queued,
  onReset,
}: {
  senator: Senator;
  queued: boolean;
  onReset: () => void;
}) {
  return (
    <section className="notice" aria-label="Senator not analyzed">
      <h2>We haven’t analyzed {senator.name} yet</h2>
      <p>
        We only answer for senators whose full legislative record we’ve already been through. Giving
        you a guess for {senator.name} would be worse than giving you nothing.
      </p>
      {queued ? (
        <p>
          Your request has been logged. Senators people actually ask about are the ones we analyze
          next, so this genuinely moves them up the list.
        </p>
      ) : null}
      <div className="actions">
        <button type="button" className="secondary" onClick={onReset}>
          Try an analyzed senator
        </button>
      </div>
    </section>
  );
}

export function ErrorState({ error, onRetry }: { error: ToolError; onRetry: () => void }) {
  return (
    <section className="notice error" aria-label="Something went wrong">
      <h2>We couldn’t finish checking this</h2>
      <p>{error.message}</p>
      <p>
        We’d rather show you this than a half-finished answer — nothing was scored, so there’s no
        partial verdict hiding behind it.
      </p>
      {error.recoverable ? (
        <div className="actions">
          <button type="button" className="secondary" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : null}
    </section>
  );
}

export function ThinResultActions({
  onReset,
  senatorName,
}: {
  onReset: () => void;
  senatorName: string;
}) {
  return (
    <div className="actions">
      <button type="button" className="secondary" onClick={onReset}>
        Ask something else
      </button>
      <span className="trust-cue" style={{ alignSelf: 'center' }}>
        Broadening the promise sometimes finds more of {senatorName}’s record.
      </span>
    </div>
  );
}
