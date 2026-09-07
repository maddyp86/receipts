import { useState } from 'react';
import type { QueryHalt, Senator, ToolError } from '@receipts/shared';

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

/**
 * The query stopped before retrieval, on purpose.
 *
 * NOT an error surface, and deliberately not styled as one. The tool declined
 * to retrieve because retrieval could not produce evidence about this
 * statement — that is the product working. There is no "try again", because
 * trying again produces the same halt.
 *
 * The two halts want different things from the user:
 *   NON_TESTABLE_SPEECH_ACT   — a different statement. Offer the entry screen.
 *   STATEMENT_DATE_REQUIRED   — a date. Offer a date field and re-run with it.
 */
export function HaltState({
  halt,
  onReset,
  onRetryWithDate,
}: {
  halt: QueryHalt;
  onReset: () => void;
  onRetryWithDate: (isoDate: string) => void;
}) {
  const [date, setDate] = useState('');

  return (
    <section className="notice" aria-label="This statement can’t be checked against legislation">
      <h2>
        {halt.reason === 'STATEMENT_DATE_REQUIRED'
          ? 'When was this said?'
          : 'This isn’t something a vote can settle'}
      </h2>
      <p>{halt.message}</p>

      {halt.recoverable_with_date ? (
        <div className="actions">
          <label className="visually-hidden" htmlFor="statement-date">
            Date the statement was made
          </label>
          <input
            id="statement-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <button
            type="button"
            className="secondary"
            disabled={!date}
            onClick={() => onRetryWithDate(date)}
          >
            Check with this date
          </button>
          <button type="button" className="secondary" onClick={onReset}>
            Ask something else
          </button>
        </div>
      ) : (
        <div className="actions">
          <button type="button" className="secondary" onClick={onReset}>
            Ask something else
          </button>
        </div>
      )}

      {/* The classification is shown because it is the reason. A user who
          disagrees that this was a scheduling remark can see what we decided
          and why, rather than being told the tool declined. */}
      <p className="trust-cue">
        Read as a {halt.scope.speech_act.toLowerCase().replace('_', ' ')} statement
        {halt.scope.anchor_entity ? ` about ${halt.scope.anchor_entity}` : ''}. {halt.scope.reasoning}
      </p>
    </section>
  );
}
