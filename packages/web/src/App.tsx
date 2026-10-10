import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowLeftIcon, RotateCcwIcon } from 'lucide-react';
import type { Corrections, Senator } from '@receipts/shared';
import { useReceiptStream } from './lib/useReceiptStream.js';
import { apiUrl } from './lib/api.js';
import { buildRoster, type Member } from './data/roster.js';
import { Entry } from './components/Entry.js';
import type { StatementKind } from './components/entry/PromiseInput.js';
import { Waiting } from './components/Waiting.js';
import { EvidenceList, HowWeGotHereToggle, VerdictCard } from './components/Verdict.js';
import { ClarifyState, DemoBanner, ErrorState, HaltState, SuggestedRewording, ThinResultActions, UncachedState } from './components/States.js';
import {
  AppliedCorrections,
  AssertedPremiseBadge,
  CorrectionPanel,
  type TaxonomyEntry,
} from './components/CorrectionPanel.js';
import { FollowUp } from './components/FollowUp.js';
import { GlossaryProvider } from './components/glossary/GlossaryContext.js';
import { SelectedMember } from './components/members/SelectedMember.js';

// ===========================================================================
// Three screens, chosen by where the query is:
//
//   entry    nothing running — pick who, say what
//   waiting  the stream is open and there is no answer yet
//   result   an answer arrived
//
// plus "stopped": the stream ended without an answer, on purpose (a statement
// no vote can settle, a member not analysed) or not (an error, a limit).
// ===========================================================================

function Page({ width, children }: { width: 'narrow' | 'wide'; children: ReactNode }) {
  return (
    <main
      className={`mx-auto px-5 sm:px-8 ${
        width === 'wide' ? 'max-w-6xl pb-20 pt-6 sm:pt-10' : 'max-w-2xl pb-16 pt-8 sm:pt-12'
      }`}
    >
      {children}
    </main>
  );
}

export default function App() {
  const [senators, setSenators] = useState<Senator[]>([]);
  const [modes, setModes] = useState({ demo: false, fixture: false, override: false, followups: false, feedback: false, prompts: false });
  const [taxonomy, setTaxonomy] = useState<TaxonomyEntry[]>([]);
  // Nobody is preselected: with a short list, a default is a nudge.
  const [selected, setSelected] = useState('');
  const [promise, setPromise] = useState('');
  const [kind, setKind] = useState<StatementKind>('position');

  const stream = useReceiptStream();

  useEffect(() => {
    fetch(apiUrl('/api/senators'))
      .then((r) => r.json())
      .then((d) => {
        const list: Senator[] = d.senators ?? [];
        setSenators(list);
        // A selection the list no longer covers is dropped, not kept.
        setSelected((cur) => (list.some((s) => s.politician_id === cur && s.cached) ? cur : ''));
        setModes({
          demo: Boolean(d.demo_mode),
          fixture: Boolean(d.fixture_mode),
          override: Boolean(d.campaign_promise_override),
          followups: Boolean(d.followups_available),
          feedback: Boolean(d.feedback_available),
          prompts: Boolean(d.feedback_prompts_available),
        });
      })
      .catch(() => {
        /* The entry screen still renders, and says the list could not be loaded. */
      });
  }, []);

  useEffect(() => {
    fetch(apiUrl('/api/taxonomy'))
      .then((r) => r.json())
      .then((d) => setTaxonomy(d.primary_issues ?? []))
      .catch(() => {
        /* No taxonomy means no correction pickers; the query path is unaffected. */
      });
  }, []);

  // Coverage is the server's. The roster only adds chamber and district for
  // members it knows, and the planned members the server does not cover yet.
  const roster = useMemo(() => buildRoster(senators), [senators]);
  const member: Member | null = roster.find((m) => m.politician_id === selected && m.cached) ?? null;

  // "This was a campaign promise" is the reader's assertion, sent as a
  // correction so the premise stays attributed to them. Only where the server
  // accepts it.
  const baseCorrections = (): Corrections | undefined =>
    modes.override && kind === 'promise' ? { assert_campaign_promise: true } : undefined;

  const submit = () => stream.run(selected, promise.trim(), baseCorrections());

  // A correction re-runs the ENTIRE query from embedding. `stream.run` resets
  // state first, so the previous verdict is gone before the new one starts —
  // there is no window in which an old verdict sits beside corrected values.
  const rerunWithCorrections = (corrections: Corrections) => stream.run(selected, promise.trim(), corrections);

  // A STATEMENT_DATE_REQUIRED halt is resolved by supplying the date, which
  // re-runs the whole query — the date changes `valid_until`, which is what the
  // scope gates test against.
  const rerunWithDate = (isoDate: string) => stream.run(selected, promise.trim(), baseCorrections(), isoDate);

  /** Back to the entry screen with the words kept, to reword them. */
  const reword = () => stream.reset();
  /** The reader picked a side: that statement is now what they are asking. */
  const checkStatement = (statement: string) => {
    setPromise(statement);
    stream.run(selected, statement, baseCorrections());
  };
  /** Back to the entry screen with the statement we checked, to change it. */
  const editStatement = (statement: string) => {
    setPromise(statement);
    stream.reset();
  };
  /** A new question about the same member. */
  const askAnother = () => {
    stream.reset();
    setPromise('');
  };
  /** Back to the picker. */
  const changeMember = () => {
    stream.reset();
    setSelected('');
  };

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [stream.phase, Boolean(stream.result)]);

  const busy = stream.phase === 'streaming';
  const hasResult = Boolean(stream.result && stream.interpretation);
  const screen: 'entry' | 'waiting' | 'result' | 'stopped' =
    stream.phase === 'idle' ? 'entry' : hasResult ? 'result' : busy ? 'waiting' : 'stopped';
  const memberName = member?.name ?? stream.result?.senator.name ?? 'this member';

  return (
    <GlossaryProvider>
      <div className="min-h-screen w-full bg-paper">
        <DemoBanner demo={modes.demo} fixture={modes.fixture} />

        {screen === 'entry' ? (
          <Page width="narrow">
            <Entry
              senators={roster}
              selected={selected}
              promise={promise}
              busy={busy}
              onSelect={setSelected}
              onPromiseChange={setPromise}
              onSubmit={submit}
              showScopeNote={modes.feedback}
              kindEnabled={modes.override}
              kind={kind}
              onKindChange={setKind}
            />
          </Page>
        ) : null}

        {screen === 'waiting' && member ? (
          <Page width="narrow">
            <Waiting
              member={member}
              promise={promise.trim()}
              steps={stream.steps}
              interpretation={stream.interpretation}
              rewritten={stream.rewritten}
              onCancel={reword}
            />
          </Page>
        ) : null}

        {screen === 'stopped' ? (
          <Page width="narrow">
            <TopBar onBack={reword} backLabel="Go back" />
            {member ? (
              <div className="mt-6">
                <SelectedMember member={member} onChange={changeMember} compact />
              </div>
            ) : null}
            <p className="mt-6 text-[17px] text-ink-soft">
              You asked about: <span className="text-ink">“{promise.trim()}”</span>
            </p>
            <div className="mt-5 space-y-5">
              {stream.uncached ? (
                <UncachedState senator={stream.uncached.senator} queued={stream.uncached.queued} onReset={changeMember} />
              ) : null}
              {stream.error ? <ErrorState error={stream.error} onRetry={submit} onReset={reword} /> : null}
              {stream.halt ? (
                <HaltState
                  halt={stream.halt}
                  onReset={reword}
                  onRetryWithDate={rerunWithDate}
                  suggestions={stream.suggest}
                  onPick={checkStatement}
                />
              ) : null}
              {stream.clarify ? <ClarifyState clarify={stream.clarify} onPick={checkStatement} onReset={reword} /> : null}
              {/* The stream closed with nothing at all. Say so rather than show an empty page. */}
              {!stream.uncached && !stream.error && !stream.halt && !stream.clarify ? (
                <ErrorState
                  error={{
                    code: 'UPSTREAM_UNAVAILABLE',
                    message: 'The check ended without an answer.',
                    recoverable: true,
                  }}
                  onRetry={submit}
                  onReset={reword}
                />
              ) : null}
            </div>
            <TraceLine traceId={stream.traceId} />
          </Page>
        ) : null}

        {screen === 'result' && stream.result && stream.interpretation ? (
          <Page width="wide">
            <TopBar onBack={askAnother} backLabel="New question" icon="new" />

            <div className="mt-6 grid gap-10 lg:grid-cols-[minmax(0,440px)_minmax(0,1fr)] lg:gap-14">
              {/* The answer, beside the bills on a wide screen. Not pinned: the
                  explanation is the longest thing on the page, and pinning the
                  column would cut it off or make it scroll inside itself. */}
              <div className="min-w-0 space-y-5">
                {member ? <SelectedMember member={member} onChange={changeMember} compact /> : null}

                <section aria-label="How we read your statement" className="rounded-card border border-rule bg-card px-4 py-3">
                  {/* A question was restated before it was checked. Both are
                      shown: the answer below is about the second. */}
                  {stream.rewritten ? (
                    <div className="mb-3 border-b border-rule pb-3">
                      <p className="text-[14px] font-medium text-ink-soft">You typed</p>
                      <p className="mt-0.5 text-[16px] leading-snug text-ink-soft">“{stream.rewritten.original}”</p>
                      <p className="mt-2 text-[14px] font-medium text-ink-soft">We checked it as</p>
                      <p className="mt-0.5 text-[16px] font-medium leading-snug text-ink">“{stream.rewritten.statement}”</p>
                      <button
                        type="button"
                        onClick={() => editStatement(stream.rewritten!.statement)}
                        className="mt-1 inline-flex min-h-[44px] items-center text-[15px] font-medium text-focus underline underline-offset-4"
                      >
                        Not what you meant? Change it
                      </button>
                    </div>
                  ) : null}
                  <p className="text-[14px] font-medium text-ink-soft">How we read it</p>
                  <p className="mt-0.5 text-[16px] leading-snug text-ink">“{stream.interpretation.restated}”</p>
                </section>

                <div className="legacy">
                  <AssertedPremiseBadge interpretation={stream.interpretation} />
                  <AppliedCorrections interpretation={stream.interpretation} />
                </div>

                <h1 className="sr-only">Answer for {memberName}</h1>
                <VerdictCard
                  result={stream.result}
                  traceId={stream.traceId}
                  feedbackAvailable={modes.feedback}
                  feedbackPrompts={modes.prompts}
                />

                {/* "Too broad": a rewording of the reader's own topic to check instead. */}
                {stream.suggest?.length && stream.result.scored.nd_reason === 'NOT_EVALUABLE' ? (
                  <div className="rounded-card border border-rule bg-card px-4 py-4 text-[16px] text-ink-soft">
                    <SuggestedRewording options={stream.suggest} onPick={checkStatement} />
                  </div>
                ) : null}

                <div className="hidden lg:block">
                  <ThinResultActions onReset={askAnother} onChangeMember={changeMember} senatorName={memberName} />
                </div>
              </div>

              {/* The receipts. */}
              <div className="min-w-0 space-y-8">
                <EvidenceList
                  result={stream.result}
                  traceId={stream.traceId}
                  feedbackAvailable={modes.feedback}
                  feedbackPrompts={modes.prompts}
                />

                <div className="space-y-6 border-t border-rule pt-6">
                  <HowWeGotHereToggle result={stream.result} />

                  {/* Offered only once the answer is complete: correcting a
                      classification mid-flight would stage edits against
                      values still changing. */}
                  {stream.phase === 'done' ? (
                    <div className="legacy">
                      <CorrectionPanel
                        interpretation={stream.interpretation}
                        taxonomy={taxonomy}
                        overrideEnabled={modes.override}
                        busy={busy}
                        onRerun={rerunWithCorrections}
                      />
                    </div>
                  ) : null}

                  {/* Questions about THIS result are answered from its own
                      record and cannot change it; a new statement is a new
                      query. */}
                  {stream.phase === 'done' && stream.traceId ? (
                    <div className="legacy">
                      <FollowUp traceId={stream.traceId} available={modes.followups} senatorName={memberName} />
                    </div>
                  ) : null}
                </div>

                <div className="border-t border-rule pt-6 lg:hidden">
                  <ThinResultActions onReset={askAnother} onChangeMember={changeMember} senatorName={memberName} />
                </div>

                <TraceLine traceId={stream.traceId} />
              </div>
            </div>
          </Page>
        ) : null}
      </div>
    </GlossaryProvider>
  );
}

function TopBar({ onBack, backLabel, icon = 'back' }: { onBack: () => void; backLabel: string; icon?: 'back' | 'new' }) {
  const Icon = icon === 'new' ? RotateCcwIcon : ArrowLeftIcon;
  return (
    <div className="flex items-center justify-between">
      <p className="font-serif text-[24px] text-ink">Receipts</p>
      <button
        type="button"
        onClick={onBack}
        className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md px-2 text-[16px] font-medium text-focus"
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
        {backLabel}
      </button>
    </div>
  );
}

/**
 * The run id. Deliberately quiet — it is for whoever is repairing the
 * pipeline, not for the voter — but it has to be ON the page, because a wrong
 * answer with no id is a wrong answer nobody can trace.
 */
function TraceLine({ traceId }: { traceId: string | null }) {
  if (!traceId) return null;
  return (
    <p className="mt-6 text-[13px] text-ink-faint">
      Trace{' '}
      <a href={apiUrl(`/api/trace/${traceId}`)} target="_blank" rel="noreferrer" className="underline underline-offset-2">
        <code className="font-mono">{traceId}</code>
      </a>
    </p>
  );
}
