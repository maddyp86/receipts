import { useEffect, useRef, type FormEvent, type ReactNode } from 'react';
import {
  ArrowRightIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  DatabaseIcon,
  ExternalLinkIcon,
  FileTextIcon,
  GaugeIcon,
  HelpCircleIcon,
  Loader2Icon,
  ScaleIcon,
  ShieldQuestionIcon,
  XIcon,
} from 'lucide-react';
import { SCOPE_NOTE, surnameOf } from '@receipts/shared';
import type { Member } from '../../data/roster.js';
import { STARTERS, type Starter } from '../../data/topics.js';
import { LawmakerSearch } from '../entry/LawmakerSearch.js';
import { PhrasingHelp } from '../entry/PhrasingHelp.js';
import { withName } from '../entry/Hero.js';
import { BETA_LINE, DATA_SOURCES, HOW_STEPS, SAMPLE_ANSWERS, TRUST_POINTS, type SampleAnswer } from './content.js';

// ===========================================================================
// The landing page: the first visit. Its one job is a first check.
//
// Design: Magic Patterns (2026-11), ported onto the real app. The design's
// mock member list and fake "checking" timer are replaced by the real
// directory search and the real query; its sample answers are cut to what is
// verified (content.ts). After the first check the reader is in the tool
// (App.tsx `mode`), and "new question" goes to the tool's own entry screen,
// not back here.
// ===========================================================================

interface Props {
  members: readonly Member[];
  selected: Member | null;
  onSelect: (id: string) => void;
  promise: string;
  onPromiseChange: (text: string) => void;
  onSubmit: () => void;
  onStart: (starter: Starter) => void;
  /** Open the tool's browse panel (by state / district), at a name if given. */
  onBrowse: (name?: string) => void;
  busy: boolean;
  /** Checks a day per reader, from the server. Not shown until known. */
  dailyLimit: number | null;
  /** The full beta note, where "Something look wrong?" exists for it to point at. */
  showScopeNote: boolean;
}

export function Landing(props: Props) {
  return (
    <div className="w-full bg-lp-paper font-lp-sans text-lp-ink antialiased">
      <LandingHeader />
      <main>
        <LandingHero {...props} />
        <ProofSection />
        <HowItWorksSection />
      </main>
    </div>
  );
}

function LandingHeader() {
  return (
    <header className="border-b border-white/10 bg-lp-navy text-white">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-6">
        <a href="#hero-title" className="flex items-center gap-2.5" aria-label="Receipts home">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-lp-brand font-display text-base font-semibold">
            R
          </span>
          <span className="text-[15px] font-semibold">Receipts</span>
          <span className="rounded-full border border-white/20 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-white/70">
            Beta
          </span>
        </a>
        <nav aria-label="Primary" className="flex items-center gap-1 sm:gap-6">
          <a href="#proof" className="hidden text-sm text-white/75 hover:text-white sm:inline">
            Sample answer
          </a>
          <a href="#how-it-works" className="hidden text-sm text-white/75 hover:text-white sm:inline">
            How it works
          </a>
          <a
            href="#hero-title"
            className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg bg-white px-4 py-2 text-sm font-semibold text-lp-navy transition-colors duration-150 hover:bg-white/90"
          >
            Get started
            <ArrowRightIcon className="h-4 w-4" aria-hidden="true" />
          </a>
        </nav>
      </div>
    </header>
  );
}

function LandingHero({
  members,
  selected,
  onSelect,
  promise,
  onPromiseChange,
  onSubmit,
  onStart,
  onBrowse,
  busy,
  dailyLimit,
  showScopeNote,
}: Props) {
  const textRef = useRef<HTMLTextAreaElement>(null);
  const starters = STARTERS.flatMap((s) => {
    const m = members.find((x) => x.politician_id === s.politicianId && x.cached);
    return m ? [{ starter: s, member: m }] : [];
  });

  // One line to start; grows with what is typed (up to about five lines).
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [promise]);

  // Picked someone with nothing typed yet: straight on to the question.
  const prev = useRef<string | null>(selected?.politician_id ?? null);
  useEffect(() => {
    const id = selected?.politician_id ?? null;
    if (id && id !== prev.current && !promise) textRef.current?.focus();
    prev.current = id;
  }, [selected, promise]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!selected) {
      document.getElementById('lawmaker')?.focus();
      return;
    }
    if (promise.trim().length <= 2) {
      textRef.current?.focus();
      return;
    }
    onSubmit();
  }

  function pick(text: string) {
    onPromiseChange(text);
    requestAnimationFrame(() => {
      const el = textRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(text.length, text.length);
      }
    });
  }

  return (
    <section className="bg-lp-navy text-white" aria-labelledby="hero-title">
      <div className="mx-auto max-w-6xl px-5 pb-20 pt-5 sm:px-6 lg:pt-7">
        <div className="mx-auto max-w-3xl text-center">
          <h1 id="hero-title" className="scroll-mt-24 text-balance font-display text-[2.3rem] font-semibold leading-[1.05] sm:text-[3.25rem]">
            Hold Congress to <span className="text-lp-signal">its word</span>
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-lg leading-relaxed text-white/75">
            See whether the people who represent you vote the way they talk, from campaign promises to the bills they back.
          </p>
        </div>

        <div className="mx-auto mt-6 max-w-2xl">
          <form
            onSubmit={handleSubmit}
            aria-label="Check a lawmaker"
            className="rounded-2xl bg-lp-navy3 p-4 text-left text-white shadow-[0_24px_60px_-24px_rgba(0,0,0,0.7)] ring-1 ring-white/20 sm:p-5"
          >
            <StepLabel n={1} done={Boolean(selected)} htmlFor="lawmaker">
              Who do you want to check?
            </StepLabel>
            <div className="mt-2 sm:pl-10">
              <LawmakerSearch
                tone="dark"
                members={members}
                selected={selected}
                onSelect={onSelect}
                onClear={() => onSelect('')}
                onBrowse={onBrowse}
              />
            </div>

            <fieldset
              disabled={!selected}
              className={`mt-5 transition-opacity duration-200 ease-out ${selected ? '' : 'opacity-55'}`}
            >
              <StepLabel n={2} done={false} htmlFor="promise">
                What do you want to check{selected ? ` about ${selected.name}` : ''}?
              </StepLabel>
              <div className="mt-2 sm:pl-10">
                <textarea
                  ref={textRef}
                  id="promise"
                  rows={1}
                  maxLength={600}
                  value={promise}
                  onChange={(e) => onPromiseChange(e.target.value)}
                  placeholder={selected ? 'e.g., Did they vote for the Laken Riley Act?' : 'Pick a lawmaker first'}
                  className="block max-h-[9.5rem] w-full resize-none overflow-y-auto rounded-xl border border-white/15 bg-lp-navy px-3.5 py-3 text-[15px] text-white outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-white/40 focus:border-lp-signal focus:ring-4 focus:ring-lp-signal/20"
                />
                <PhrasingHelp
                  tone="dark"
                  onPick={pick}
                  className="group mt-1"
                  lead={<span className="text-[13px] text-white/55">Be specific: name the policy, program or bill.</span>}
                />
              </div>
            </fieldset>

            <button
              type="submit"
              aria-disabled={busy ? 'true' : undefined}
              className="mt-5 inline-flex w-full items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-lp-brand px-5 py-3 text-[15px] font-semibold text-white transition-[background-color,transform] duration-150 ease-out hover:bg-lp-brand-dark focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-lp-signal/40 active:scale-[0.98]"
            >
              {busy ? (
                <>
                  <Loader2Icon className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Checking the record…
                </>
              ) : (
                <>
                  Check the record
                  <ArrowRightIcon className="h-4 w-4" aria-hidden="true" />
                </>
              )}
            </button>
          </form>

          <LandingBeta full={showScopeNote} />

          {dailyLimit ? (
            <p className="mt-2 flex items-start gap-2 px-1 text-sm text-white/70">
              <GaugeIcon className="mt-0.5 h-4 w-4 shrink-0 text-lp-signal" aria-hidden="true" />
              <span>Free during the preview: up to {dailyLimit} checks a day, including follow-up questions.</span>
            </p>
          ) : null}

          {starters.length ? (
            <div className="mt-8">
              <h2 className="px-1 text-sm font-medium text-white/55">Or try one now, in one tap:</h2>
              <ul className="mt-1 divide-y divide-white/[0.07]">
                {starters.map(({ starter, member }) => (
                  <li key={starter.evalCase}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onStart(starter)}
                      className="group flex w-full items-center gap-3 rounded-md px-1 py-3 text-left text-[15px] text-white/75 transition-colors duration-150 hover:text-white focus-visible:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lp-signal/50 disabled:opacity-60"
                    >
                      <span className="flex-1">
                        {withName(starter.text, surnameOf(member.name))}
                        {member.party && member.state ? (
                          <span className="ml-2 text-sm text-white/50">
                            {member.party}-{member.state}
                          </span>
                        ) : null}
                      </span>
                      <ArrowRightIcon
                        className="h-4 w-4 shrink-0 text-lp-signal transition-transform duration-150 ease-out group-hover:translate-x-0.5"
                        aria-hidden="true"
                      />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

        </div>
      </div>
    </section>
  );
}

/** The beta note: the one line always; the full approved note one tap away where it can point at feedback. */
function LandingBeta({ full }: { full: boolean }) {
  if (!full) return <p className="mt-3 px-1 text-[13px] text-white/60">{BETA_LINE}</p>;
  return (
    <details className="group mt-3 px-1">
      <summary className="cursor-pointer list-none text-[13px] text-white/60 [&::-webkit-details-marker]:hidden">
        {BETA_LINE}{' '}
        <span className="inline-flex items-center gap-1 font-medium text-lp-signal underline underline-offset-4">
          About this beta
          <ChevronDownIcon className="h-3.5 w-3.5 transition-transform duration-200 group-open:rotate-180" aria-hidden="true" />
        </span>
      </summary>
      <aside aria-label="About this beta" className="mt-3 space-y-3 rounded-xl bg-white/5 p-4 text-sm leading-relaxed text-white/75 ring-1 ring-white/10">
        {SCOPE_NOTE.map((p) => (
          <p key={p}>{p}</p>
        ))}
      </aside>
    </details>
  );
}

function StepLabel({ n, done, htmlFor, children }: { n: number; done: boolean; htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="flex items-center gap-3 text-[15px] font-semibold">
      <span
        aria-hidden="true"
        className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[13px] transition-colors duration-200 ${
          done ? 'bg-lp-verified text-white' : 'bg-white/10 text-white ring-1 ring-inset ring-white/25'
        }`}
      >
        {done ? <CheckIcon className="h-3.5 w-3.5" /> : n}
      </span>
      {children}
    </label>
  );
}

const TRUST_ICONS = { scale: ScaleIcon, file: FileTextIcon, shield: ShieldQuestionIcon } as const;

function ProofSection() {
  return (
    <section id="proof" aria-labelledby="proof-title" className="scroll-mt-4 bg-lp-paper">
      <div className="mx-auto grid max-w-6xl gap-12 px-5 py-20 sm:px-6 lg:grid-cols-12 lg:gap-16 lg:py-28">
        <div className="lg:col-span-5">
          <h2 id="proof-title" className="font-display text-4xl font-semibold leading-tight text-lp-ink sm:text-[2.75rem]">
            Receipts, not ratings
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-lp-muted">
            We focus on policy, not politics. Every answer is built from the Senate’s own record and shows its sources.
          </p>
          <ul className="mt-10 space-y-7">
            {TRUST_POINTS.map(({ icon, title, body }) => {
              const Icon = TRUST_ICONS[icon];
              return (
                <li key={title} className="flex gap-4">
                  <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-lp-brand-soft text-lp-brand">
                    <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
                  </span>
                  <div>
                    <h3 className="text-[15px] font-semibold text-lp-ink">{title}</h3>
                    <p className="mt-1 text-[15px] leading-relaxed text-lp-muted">{body}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="lg:col-span-7">
          <SampleAnswerCard answers={SAMPLE_ANSWERS} />
        </div>
      </div>
    </section>
  );
}

const VERDICT = {
  yes: { badge: 'bg-lp-verified-soft text-lp-verified', Icon: CheckIcon },
  no: { badge: 'bg-lp-refuted-soft text-lp-refuted', Icon: XIcon },
  unclear: { badge: 'bg-lp-unclear-soft text-lp-unclear', Icon: HelpCircleIcon },
} as const;

/** One verified sample answer. (The design had tabs for several; they return when there are more verified ones.) */
export function SampleAnswerCard({ answers }: { answers: readonly SampleAnswer[] }) {
  const answer = answers[0];
  if (!answer) return null;
  const v = VERDICT[answer.tone];
  return (
    <div className="overflow-hidden rounded-2xl border border-lp-line bg-white shadow-[0_20px_50px_-30px_rgba(14,27,51,0.45)]">
      <div className="p-6 sm:p-7">
        <div className="flex items-center justify-between gap-4 text-xs text-lp-muted">
          <span className="font-medium uppercase tracking-wide">Sample answer</span>
          <span>{answer.who}</span>
        </div>

        <p className="mt-3 font-display text-2xl leading-snug text-lp-ink">“{answer.question}”</p>

        <span className={`mt-4 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[15px] font-semibold ${v.badge}`}>
          <v.Icon className="h-4 w-4" aria-hidden="true" />
          {answer.label}
        </span>

        <p className="mt-4 text-[15px] leading-relaxed text-lp-ink/90">{answer.summary}</p>

        <h3 className="mt-6 text-sm font-semibold text-lp-ink">The record</h3>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-lp-line text-xs text-lp-muted">
                <th scope="col" className="py-2 pr-3 font-medium">Bill</th>
                <th scope="col" className="py-2 pr-3 font-medium">Senate vote</th>
                <th scope="col" className="py-2 font-medium">Their vote</th>
              </tr>
            </thead>
            <tbody>
              {answer.rows.map((r) => (
                <tr key={r.rollCall} className="border-b border-lp-line/70 last:border-0">
                  <td className="py-2.5 pr-3">
                    <a
                      href={r.billUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 font-lp-mono text-[13px] text-lp-brand hover:underline"
                    >
                      {r.bill}
                      <ExternalLinkIcon className="h-3 w-3" aria-hidden="true" />
                      <span className="sr-only">(opens Congress.gov)</span>
                    </a>
                  </td>
                  <td className="py-2.5 pr-3 text-lp-ink/90">{r.rollCall}</td>
                  <td className="py-2.5 font-semibold text-lp-ink">{r.vote}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {answer.caveat ? (
          <p className="mt-4 rounded-lg bg-lp-unclear-soft px-3 py-2 text-sm text-lp-unclear">{answer.caveat}</p>
        ) : null}

        <p className="mt-6 border-t border-lp-line pt-4 text-xs text-lp-muted">
          Sources: Senate roll-call votes · Congress.gov. Follow-up questions count toward your daily checks.
        </p>
      </div>
    </div>
  );
}

function HowItWorksSection() {
  return (
    <section id="how-it-works" aria-labelledby="how-title" className="scroll-mt-4 border-t border-lp-line bg-white">
      <div className="mx-auto max-w-6xl px-5 py-20 sm:px-6 lg:py-28">
        <div className="max-w-2xl">
          <h2 id="how-title" className="font-display text-4xl font-semibold leading-tight text-lp-ink sm:text-[2.75rem]">
            How it works
          </h2>
          <p className="mt-4 text-lg text-lp-muted">From your question to the votes behind the answer.</p>
        </div>

        <ol className="relative mt-14 grid gap-10 md:grid-cols-3 md:gap-8">
          <span aria-hidden="true" className="absolute left-4 right-4 top-4 hidden h-px bg-lp-line md:block" />
          {HOW_STEPS.map((step, i) => (
            <li key={step.title} className="relative">
              <span className="relative inline-flex h-8 w-8 items-center justify-center rounded-full bg-lp-navy text-sm font-semibold text-white ring-8 ring-white">
                {i + 1}
              </span>
              <h3 className="mt-5 text-lg font-semibold text-lp-ink">{step.title}</h3>
              <p className="mt-2 max-w-xs text-[15px] leading-relaxed text-lp-muted">{step.body}</p>
            </li>
          ))}
        </ol>

        <div className="mt-16 flex flex-col gap-6 rounded-2xl bg-lp-navy px-6 py-7 text-white sm:px-8 md:flex-row md:items-center md:justify-between">
          <div className="flex items-start gap-4">
            <DatabaseIcon className="mt-1 h-5 w-5 shrink-0 text-lp-signal" aria-hidden="true" />
            <div>
              <p className="font-semibold">Where the answers come from</p>
              <p className="mt-1 text-sm text-white/70">{DATA_SOURCES.join(' · ')}</p>
            </div>
          </div>
          <a
            href="#hero-title"
            className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-lp-brand px-5 py-3 text-[15px] font-semibold transition-colors duration-150 hover:bg-lp-brand-dark"
          >
            Check a lawmaker
            <ArrowUpIcon className="h-4 w-4" aria-hidden="true" />
          </a>
        </div>
      </div>
    </section>
  );
}
