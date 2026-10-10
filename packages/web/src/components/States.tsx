import { useState, type ReactNode } from 'react';
import { TriangleAlertIcon } from 'lucide-react';
import {
  coverageSentence,
  enrichmentGapSentence,
  type CoverageWindow,
  type EnrichmentGap,
  type QueryHalt,
  type Senator,
  type ToolError,
} from '@receipts/shared';

// ===========================================================================
// Honest states.
//
// A thin result gets as much design care as a strong one. None of these are
// error screens dressed up — they are answers, and each says specifically what
// happened rather than shrugging.
// ===========================================================================

/** `a` / `an`, so the speech act reads as English rather than as a template. */
function article(word: string): string {
  return /^[AEIOU]/i.test(word) ? 'an' : 'a';
}

/** The card every stop state sits in. Calm by default; `tone="error"` only for a real failure. */
function Notice({
  label,
  title,
  tone = 'plain',
  children,
}: {
  label: string;
  title: string;
  tone?: 'plain' | 'error';
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className={`notice rounded-card border bg-card p-6 shadow-soft ${tone === 'error' ? 'border-broken/40' : 'border-rule'}`}
    >
      <h2 className="font-serif text-[26px] leading-tight text-ink">{title}</h2>
      <div className="mt-3 space-y-3 text-[17px] leading-relaxed text-ink-soft">{children}</div>
    </section>
  );
}

const BTN_PRIMARY =
  'inline-flex min-h-[48px] items-center justify-center rounded-card bg-ink px-5 text-[16px] font-semibold text-paper transition-colors duration-150 hover:bg-[#33312D] disabled:bg-rule disabled:text-ink-soft';
const BTN_SECONDARY =
  'inline-flex min-h-[48px] items-center justify-center rounded-card border border-rule bg-card px-5 text-[16px] font-medium text-ink transition-colors duration-150 hover:border-ink-faint disabled:text-ink-faint';

export function DemoBanner({ demo, fixture }: { demo: boolean; fixture: boolean }) {
  if (!demo && !fixture) return null;

  const parts: string[] = [];
  if (fixture) parts.push('the bills shown are sample data, not this senator’s real record');
  if (demo) parts.push('the interpretation and explanation are canned, not written for you');

  // The two modes are independent, and the banner used to assert "Demo mode. No
  // API keys are configured" for either one. With an Anthropic key present and
  // Pinecone absent, both halves of that were false: it is not demo mode, and a
  // key IS configured. A degradation notice that misdescribes the degradation
  // is the same defect as a verdict that misdescribes the evidence.
  const label = demo && fixture ? 'Demo mode.' : fixture ? 'Sample data.' : 'Canned answers.';
  const cause =
    demo && fixture
      ? 'No API keys are configured'
      : fixture
        ? 'The retrieval keys are not configured'
        : 'No language-model key is configured';

  return (
    <div className="border-b border-rule bg-cantsay-wash" role="status">
      <p className="mx-auto flex max-w-6xl items-start gap-2 px-5 py-3 text-[15px] leading-snug text-ink sm:px-8">
        <TriangleAlertIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          <strong className="font-semibold">{label}</strong> {cause}, so {parts.join(', and ')}. Nothing here is a real
          accountability finding.
        </span>
      </p>
    </div>
  );
}

/**
 * What record was actually searched.
 *
 * Renders on EVERY result, not only the empty ones. The sentence exists because
 * "We didn't find any bills or votes in this senator's analyzed record" is the
 * tool's most dangerous output: every word of it is true, and a reader hears
 * "he has no record on this". Schumer passed the Inflation Reduction Act in the
 * 117th Congress; the corpus starts at the 118th, so without this line his
 * defining drug-pricing law reads as an absence of action.
 *
 * It is the mirror of the false-accusation class and the less protected of the
 * two — an accusation must clear a confidence floor, carry a counterargument
 * and survive a judge, while an absence otherwise gets a clean sentence and no
 * scrutiny at all.
 *
 * The copy comes from `coverageSentence` in shared rather than from this file,
 * so the sentence the user reads is the same one the server persists.
 */
export function CoverageNote({ coverage }: { coverage?: CoverageWindow }) {
  // Absent is not the same as unknown. An older result that predates the field
  // says nothing here rather than asserting a window it never recorded.
  if (!coverage) return null;

  return (
    <p
      className="coverage-note border-t border-rule pt-4 text-[15px] leading-relaxed text-ink-soft"
      data-unknown={coverage.unknown ? 'true' : undefined}
    >
      {coverageSentence(coverage)}
    </p>
  );
}

/**
 * Said when part of the evidence layer could not be read for this answer.
 *
 * Every check that needs those reads fails open — a timing check with no vote
 * date does not fire — so the verdict above was reached with less scrutiny
 * than usual. That used to be visible only in the server log; it is a fact
 * about this answer, so it is on the answer. Renders nothing when every read
 * succeeded, or for an older result that predates the field.
 */
export function EnrichmentGapNote({ gaps }: { gaps?: EnrichmentGap[] }) {
  const sentence = enrichmentGapSentence(gaps);
  if (!sentence) return null;
  return (
    <p
      className="degraded-note rounded-lg border border-broken/30 bg-broken-wash px-3.5 py-3 text-[15px] leading-relaxed text-ink"
      role="note"
    >
      {sentence}
    </p>
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
    <Notice label="Senator not analyzed" title={`We haven’t analyzed ${senator.name} yet`}>
      <p>
        We only answer for senators whose Senate record we’ve already been through. Giving
        you a guess for {senator.name} would be worse than giving you nothing.
      </p>
      {queued ? (
        <p>
          Your request has been logged. Senators people actually ask about are the ones we analyze
          next, so this genuinely moves them up the list.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3 pt-2">
        <button type="button" className={BTN_PRIMARY} onClick={onReset}>
          Try an analyzed senator
        </button>
      </div>
    </Notice>
  );
}

/**
 * A limit is not a failure. "We couldn't finish checking this" over a limit
 * reads as the tool breaking; the limit's own message says what happened and
 * when it lifts.
 */
const LIMIT_HEADLINE: Partial<Record<ToolError['code'], string>> = {
  RATE_LIMITED: 'You’ve reached the limit for now',
  CAPACITY_REACHED: 'Receipts has reached today’s limit',
};

export function ErrorState({
  error,
  onRetry,
  onReset,
}: {
  error: ToolError;
  onRetry: () => void;
  /** Back to the entry screen. A limit has no retry, so without this it would be a dead end. */
  onReset?: () => void;
}) {
  const limitHeadline = LIMIT_HEADLINE[error.code];
  return (
    <Notice
      label={limitHeadline ?? 'Something went wrong'}
      title={limitHeadline ?? 'We couldn’t finish checking this'}
      tone={limitHeadline ? 'plain' : 'error'}
    >
      <p>{error.message}</p>
      {limitHeadline ? null : (
        <p>
          We’d rather show you this than a half-finished answer — nothing was scored, so there’s no
          partial verdict hiding behind it.
        </p>
      )}
      <div className="flex flex-wrap gap-3 pt-2">
        {error.recoverable ? (
          <button type="button" className={BTN_PRIMARY} onClick={onRetry}>
            Try again
          </button>
        ) : null}
        {onReset ? (
          <button type="button" className={BTN_SECONDARY} onClick={onReset}>
            Go back
          </button>
        ) : null}
      </div>
    </Notice>
  );
}

export function ThinResultActions({
  onReset,
  onChangeMember,
  senatorName,
}: {
  onReset: () => void;
  /** Back to the picker. Omitted where there is nobody else to pick. */
  onChangeMember?: () => void;
  senatorName: string;
}) {
  return (
    <div className="space-y-3">
      <button type="button" className={`${BTN_PRIMARY} w-full`} onClick={onReset}>
        Check something else about {senatorName}
      </button>
      {onChangeMember ? (
        <button type="button" className={`${BTN_SECONDARY} w-full`} onClick={onChangeMember}>
          Check someone else
        </button>
      ) : null}
      <p className="text-center text-[14px] leading-snug text-ink-soft">
        Broadening the promise sometimes finds more of {senatorName}’s record.
      </p>
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
    <Notice
      label="This statement can’t be checked against legislation"
      title={
        halt.reason === 'STATEMENT_DATE_REQUIRED'
          ? 'When was this said?'
          : 'This doesn’t look like something a vote can settle'
      }
    >
      <p>{halt.message}</p>

      {/* What to do about it. A question or a bare topic is the usual cause, and
          neither names a side for a vote to be checked against. */}
      {halt.reason === 'NON_TESTABLE_SPEECH_ACT' ? (
        <p>
          Try it as a statement that takes a side — for example “supports expanding background checks” or “opposes
          cuts to Social Security.”
        </p>
      ) : null}

      {halt.recoverable_with_date ? (
        <div className="flex flex-wrap items-center gap-3 pt-2">
          <label className="sr-only" htmlFor="statement-date">
            Date the statement was made
          </label>
          <input
            id="statement-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="min-h-[48px] rounded-card border border-rule bg-card px-3 text-[16px] text-ink focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
          />
          <button type="button" className={BTN_PRIMARY} disabled={!date} onClick={() => onRetryWithDate(date)}>
            Check with this date
          </button>
          <button type="button" className={BTN_SECONDARY} onClick={onReset}>
            Reword it
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-3 pt-2">
          <button type="button" className={BTN_PRIMARY} onClick={onReset}>
            Reword it
          </button>
        </div>
      )}

      {/* The classification is shown because it is the reason. A user who
          disagrees that this was a scheduling remark can see what we decided
          and why, rather than being told the tool declined. */}
      <p className="border-t border-rule pt-3 text-[14px] leading-snug text-ink-soft">
        Read as {article(halt.scope.speech_act)}{' '}
        {halt.scope.speech_act.toLowerCase().replace('_', ' ')} statement
        {halt.scope.anchor_entity ? ` about ${halt.scope.anchor_entity}` : ''}. {halt.scope.reasoning}
      </p>
    </Notice>
  );
}
