import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowLeftIcon, RotateCcwIcon } from 'lucide-react';
import { surnameOf, type Corrections, type DirectoryMember, type InputKind, type Senator } from '@receipts/shared';
import { useReceiptStream } from './lib/useReceiptStream.js';
import { apiUrl } from './lib/api.js';
import { buildRoster, type Member } from './data/roster.js';
import { Entry } from './components/Entry.js';
import type { StatementKind } from './components/entry/PromiseInput.js';
import { QuestionCard, Waiting } from './components/Waiting.js';
import { EvidenceList, HowWeGotHereToggle, SearchSummary, VerdictCard, WhyPanel } from './components/Verdict.js';
import { ResultTabs } from './components/ResultTabs.js';
import { ClarifyState, DemoBanner, ErrorState, HaltState, ResultActions, SuggestedRewording, ThinResultActions, UncachedState } from './components/States.js';
import {
  AppliedCorrections,
  CorrectionPanel,
  type TaxonomyEntry,
} from './components/CorrectionPanel.js';
import { FollowUp } from './components/FollowUp.js';
import { GlossaryProvider } from './components/glossary/GlossaryContext.js';
import { SelectedMember } from './components/members/SelectedMember.js';
import { FundedThanks, FundingProvider } from './components/members/FundRecord.js';
import { SiteFooter } from './components/policy/PolicyPages.js';

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
  const [directory, setDirectory] = useState<DirectoryMember[]>([]);
  const [modes, setModes] = useState({ demo: false, fixture: false, override: false, followups: false, feedback: false, prompts: false });
  const [taxonomy, setTaxonomy] = useState<TaxonomyEntry[]>([]);
  // Nobody is preselected: with a short list, a default is a nudge.
  const [selected, setSelected] = useState('');
  const [promise, setPromise] = useState('');
  /**
   * What the reader typed, kept when they pick one of our options ("which
   * way?", "which taxes?", a rewording): the answer still says "You asked"
   * with their words, and "We checked" with the one they picked.
   */
  const [askedText, setAskedText] = useState<string | null>(null);
  const [kind, setKind] = useState<StatementKind>('position');

  const stream = useReceiptStream();

  /** Back from Stripe Checkout: ?funded=<member id>. Read once, then cleared from the address bar. */
  const [fundedId, setFundedId] = useState<string | null>(() => {
    try {
      return new URLSearchParams(window.location.search).get('funded');
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (!fundedId) return;
    window.history.replaceState(null, '', window.location.pathname);
    window.scrollTo({ top: 0 });
  }, [fundedId]);

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
    fetch(apiUrl('/api/members'))
      .then((r) => r.json())
      .then((d) => setDirectory(Array.isArray(d.members) ? d.members : []))
      .catch(() => {
        /* No directory: the picker falls back to the covered members and the planned list. */
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
  const roster = useMemo(() => buildRoster(senators, directory), [senators, directory]);
  const member: Member | null = roster.find((m) => m.politician_id === selected && m.cached) ?? null;

  // "This was a campaign promise" is the reader's assertion, sent as a
  // correction so the premise stays attributed to them. Only where the server
  // accepts it.
  const baseCorrections = (): Corrections | undefined =>
    modes.override && kind === 'promise' ? { assert_campaign_promise: true } : undefined;

  const submit = () => {
    setAskedText(null);
    stream.run(selected, promise.trim(), baseCorrections());
  };

  // A correction re-runs the ENTIRE query from embedding. `stream.run` resets
  // state first, so the previous verdict is gone before the new one starts —
  // there is no window in which an old verdict sits beside corrected values.
  const rerunWithCorrections = (corrections: Corrections) =>
    stream.run(selected, promise.trim(), corrections, undefined, { chosen: askedText !== null });

  // A STATEMENT_DATE_REQUIRED halt is resolved by supplying the date, which
  // re-runs the whole query — the date changes `valid_until`, which is what the
  // scope gates test against.
  const rerunWithDate = (isoDate: string) => stream.run(selected, promise.trim(), baseCorrections(), isoDate);

  /** Back to the entry screen with the words kept, to reword them. */
  const reword = () => stream.reset();
  /** The reader picked one of our options: that statement is now what they are asking. */
  const checkStatement = (statement: string, kind?: InputKind) => {
    // Picked from options we offered: checked as it stands, never asked again,
    // and the reader's own words stay at the top of the answer.
    setAskedText(stream.clarify?.original ?? askedText ?? promise.trim());
    setPromise(statement);
    stream.run(selected, statement, baseCorrections(), undefined, { chosen: true, kind });
  };
  /** Back to the entry screen with the statement we checked, to change it. */
  const editStatement = (statement: string) => {
    setAskedText(null);
    setPromise(statement);
    stream.reset();
  };
  /** A new question about the same member. */
  const askAnother = () => {
    stream.reset();
    setPromise('');
  };
  /** The same question, about another member who is covered. */
  const otherMembers = roster.filter((m) => m.cached && m.politician_id !== selected);
  const askSameOf = (politicianId: string) => {
    setSelected(politicianId);
    stream.run(politicianId, promise.trim(), baseCorrections(), undefined, { chosen: askedText !== null });
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
  /** The chat column exists once the answer is complete and the server can answer follow-ups. */
  const followupsShown = stream.phase === 'done' && Boolean(stream.traceId) && modes.followups;
  /** Every bill on the Receipts tab: weighed, and set aside. */
  const billCount = (stream.result?.scored.evidence.length ?? 0) + (stream.result?.gated?.length ?? 0);

  return (
    <GlossaryProvider>
      <FundingProvider>
      <div className="min-h-screen w-full bg-paper">
        <DemoBanner demo={modes.demo} fixture={modes.fixture} />
        {fundedId ? (
          <div className="px-4">
            <FundedThanks
              memberName={roster.find((m) => m.politician_id === fundedId)?.name ?? null}
              onClose={() => setFundedId(null)}
            />
          </div>
        ) : null}

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
              notes={stream.notes}
              interpretation={stream.interpretation}
              rewritten={stream.rewritten}
              asked={askedText}
              onCancel={reword}
              onChange={editStatement}
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
            {/* "Which taxes?" names what they typed itself, beside the choices. */}
            {stream.clarify?.reason !== 'POLICY_REQUIRED' ? (
              <p className="mt-6 text-[17px] text-ink-soft">
                You asked about: <span className="text-ink">“{promise.trim()}”</span>
              </p>
            ) : null}
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

            {/* ANSWER FIRST. The answer in one bar; under it, three tabs —
                Why (open first), Receipts, How we checked — so the page is
                one screen, not one long scroll. The follow-up chat sits in
                its own column on the right, where it can grow; on a phone it
                is a sheet. */}
            <div
              className={`mt-6 grid gap-6 pb-20 lg:pb-0 ${
                followupsShown ? 'lg:grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)]' : 'mx-auto max-w-3xl'
              }`}
            >
              <div className="min-w-0 space-y-5">
                {member ? <SelectedMember member={member} onChange={changeMember} compact /> : null}

                <h1 className="sr-only">Answer for {memberName}</h1>
                <VerdictCard
                  result={stream.result}
                  traceId={stream.traceId}
                  feedbackAvailable={modes.feedback}
                  feedbackPrompts={modes.prompts}
                  actions={
                    <ResultActions
                      surname={surnameOf(memberName)}
                      onAskAnother={askAnother}
                      others={otherMembers}
                      onAskSameOf={askSameOf}
                      onChangeMember={changeMember}
                    />
                  }
                />

                {/* "Too broad": a rewording of the reader's own topic to check instead. */}
                {stream.suggest?.length && stream.result.scored.nd_reason === 'NOT_EVALUABLE' ? (
                  <div className="rounded-card border border-rule bg-card px-4 py-4 text-[16px] text-ink-soft">
                    <SuggestedRewording options={stream.suggest} onPick={checkStatement} />
                  </div>
                ) : null}

                <ResultTabs
                  initial="why"
                  tabs={[
                    {
                      id: 'why',
                      label: 'Why',
                      content: (
                        <WhyPanel
                          result={stream.result}
                          traceId={stream.traceId}
                          feedbackAvailable={modes.feedback}
                          feedbackPrompts={modes.prompts}
                        />
                      ),
                    },
                    {
                      id: 'receipts',
                      label: `Receipts (${billCount})`,
                      content: (
                        <EvidenceList
                          result={stream.result}
                          traceId={stream.traceId}
                          feedbackAvailable={modes.feedback}
                          feedbackPrompts={modes.prompts}
                        />
                      ),
                    },
                    {
                      id: 'how',
                      label: 'How we checked',
                      content: (
                        <div className="space-y-6">
                          {/* What they asked and what we checked to answer it:
                              the same card as on the waiting screen, and the
                              same way to change it. */}
                          <QuestionCard
                            asked={stream.rewritten ? stream.rewritten.original : (askedText ?? promise.trim())}
                            statement={
                              stream.rewritten ? stream.rewritten.statement : askedText ? promise.trim() : stream.interpretation.restated
                            }
                            memberName={memberName}
                            interpretation={stream.interpretation}
                            done
                            onChange={() => editStatement(stream.rewritten ? stream.rewritten.statement : promise.trim())}
                          />

                          <div className="legacy">
                            <AppliedCorrections interpretation={stream.interpretation} />
                          </div>

                          <SearchSummary result={stream.result} />
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

                          <TraceLine traceId={stream.traceId} />
                        </div>
                      ),
                    },
                  ]}
                />
              </div>

              {/* Questions about THIS result are answered from its own record
                  and cannot change it; a new statement is a new query. */}
              {followupsShown ? (
                <aside className="lg:sticky lg:top-4 lg:self-start">
                  <FollowUp traceId={stream.traceId!} available={modes.followups} senatorName={memberName} />
                </aside>
              ) : null}
            </div>
          </Page>
        ) : null}
        <SiteFooter />
      </div>
      </FundingProvider>
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
