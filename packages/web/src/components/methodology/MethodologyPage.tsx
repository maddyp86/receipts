import type { ReactNode } from 'react';
import { ArrowRightIcon, CheckIcon, ChevronDownIcon, ShieldCheckIcon } from 'lucide-react';
import { ANSWER_LABEL_COPY, BAND_REASON_COPY, ND_HEADLINE, type BandReason } from '@receipts/shared';
import { SiteFooter } from '../policy/PolicyPages.js';
import {
  CANT_TELL_MEANING,
  CHECK_OUR_WORK,
  HERO,
  LIMITS,
  MODELS_TABLE,
  SAFEGUARDS,
  SOURCES,
  STEPS,
  VERDICTS,
  type TechRow,
} from './content.js';

// ===========================================================================
// /methodology — how Receipts checks the record, step by step.
//
// Plain language first; each step's models and numbers sit in a "Technical
// details" expander, closed by default, so the page reads whole without them.
// The words live in content.ts (honest to the code, see its header); the
// labels shown here are the product's own (ANSWER_LABEL_COPY, ND_HEADLINE,
// BAND_REASON_COPY from @receipts/shared), so they can't drift from it.
// In the landing page's look (lp-* colors, display serif).
// ===========================================================================

export const METHODOLOGY_PATH = '/methodology';

/** True for /methodology, with or without a trailing slash. */
export function isMethodologyPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, '') === METHODOLOGY_PATH;
}

/** Which band each reason can produce (packages/server/src/scoring/score.ts, classOf and the lowering rules). */
const BANDS: { level: string; reasons: BandReason[] }[] = [
  { level: 'High', reasons: ['DIRECT_VOTE'] },
  { level: 'Medium', reasons: ['SPONSORSHIP_ONLY', 'BROAD_PACKAGE', 'PROCEDURAL_ONLY', 'UNCERTAIN_READ'] },
  {
    level: 'Low',
    reasons: ['INDIRECT_ONLY', 'NEAR_MISS', 'PARTIAL_MATCH', 'UNCERTAIN_READ', 'TEXT_UNAVAILABLE', 'UNREAD_BILL', 'RECORD_GAPS'],
  },
];

const JUMPS = [
  ...STEPS.map((s) => ({ id: s.id, label: s.short })),
  { id: 'safeguards', label: 'Safeguards' },
  { id: 'check', label: 'Check our work' },
  { id: 'limits', label: 'Limits' },
  { id: 'sources', label: 'Sources' },
];

export function MethodologyPage() {
  return (
    <div className="min-h-screen w-full bg-lp-paper font-lp-sans text-lp-ink antialiased">
      <Header />
      <main>
        <Hero />
        <div className="mx-auto max-w-3xl px-5 pb-20 pt-12 sm:px-6">
          {STEPS.map((step, i) => (
            <Section key={step.id} id={step.id} eyebrow={`Step ${i + 1}`} title={step.title} tech={step.tech}>
              {step.paragraphs.map((p) => (
                <p key={p}>{p}</p>
              ))}
              {step.id === 'answer' ? <Outcomes /> : null}
            </Section>
          ))}

          <Section id="safeguards" title="Safeguards against a wrong accusation">
            <ul className="grid gap-4 sm:grid-cols-2">
              {SAFEGUARDS.map((s) => (
                <li key={s.title} className="rounded-xl border border-lp-line bg-white p-4">
                  <p className="flex items-start gap-2 font-semibold text-lp-ink">
                    <ShieldCheckIcon className="mt-0.5 h-5 w-5 shrink-0 text-lp-brand" aria-hidden="true" />
                    {s.title}
                  </p>
                  <p className="mt-1.5 text-[15px] leading-relaxed text-lp-muted">{s.body}</p>
                </li>
              ))}
            </ul>
          </Section>

          <Section id="check" title="Check our work on any answer">
            <ul className="space-y-2.5">
              {CHECK_OUR_WORK.map((c) => (
                <li key={c} className="flex items-start gap-3">
                  <CheckIcon className="mt-1 h-4 w-4 shrink-0 text-lp-brand" aria-hidden="true" />
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          </Section>

          <Section id="limits" title="What Receipts doesn’t do (yet)">
            <ul className="list-disc space-y-2 pl-5">
              {LIMITS.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
            <p className="text-[15px] text-lp-muted">
              Beta · Senate record since January 2023 · Answers can miss bills or be wrong. If something looks off on
              an answer, tell us with “Something look wrong?”.
            </p>
          </Section>

          <Section id="sources" title="Sources and models">
            <Table caption="Where the record comes from" rows={SOURCES} />
            <Table caption="Which model does each step" rows={MODELS_TABLE} mono />
          </Section>

          <div className="mt-14 flex flex-col items-start gap-4 rounded-2xl bg-lp-navy px-6 py-7 text-white sm:flex-row sm:items-center sm:justify-between sm:px-8">
            <p className="font-display text-2xl font-semibold">See it on a real question.</p>
            <a
              href="/"
              className="inline-flex items-center gap-2 whitespace-nowrap rounded-xl bg-lp-brand px-5 py-3 text-[15px] font-semibold transition-colors duration-150 hover:bg-lp-brand-dark"
            >
              Check a lawmaker
              <ArrowRightIcon className="h-4 w-4" aria-hidden="true" />
            </a>
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

function Header() {
  return (
    <header className="border-b border-white/10 bg-lp-navy text-white">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-6">
        <a href="/" className="flex items-center gap-2.5" aria-label="Receipts home">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-lp-brand font-display text-base font-semibold">
            R
          </span>
          <span className="text-[15px] font-semibold">Receipts</span>
          <span className="rounded-full border border-white/20 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-white/70">
            Beta
          </span>
        </a>
        <a
          href="/"
          className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg bg-white px-4 py-2 text-sm font-semibold text-lp-navy transition-colors duration-150 hover:bg-white/90"
        >
          Check a lawmaker
          <ArrowRightIcon className="h-4 w-4" aria-hidden="true" />
        </a>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="bg-lp-navy text-white" aria-labelledby="methodology-title">
      <div className="mx-auto max-w-3xl px-5 pb-12 pt-10 sm:px-6 sm:pt-14">
        <p className="text-sm font-medium uppercase tracking-wide text-lp-signal">Methodology</p>
        <h1 id="methodology-title" className="mt-2 text-balance font-display text-[2.3rem] font-semibold leading-[1.1] sm:text-5xl">
          {HERO.title}
        </h1>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-white/75">{HERO.lead}</p>
        <nav aria-label="On this page" className="mt-6 flex flex-wrap gap-2">
          {JUMPS.map((j) => (
            <a
              key={j.id}
              href={`#${j.id}`}
              className="rounded-full border border-white/20 px-3 py-1.5 text-sm text-white/80 transition-colors duration-150 hover:border-lp-signal hover:text-white"
            >
              {j.label}
            </a>
          ))}
        </nav>
      </div>
      <Diagram />
    </section>
  );
}

/** The six steps at a glance; each station jumps to its section. */
function Diagram() {
  return (
    <div className="border-t border-white/10 bg-lp-navy2">
      <ol aria-label="The steps at a glance" className="mx-auto grid max-w-6xl gap-px px-5 py-6 sm:grid-cols-3 sm:px-6 lg:grid-cols-6">
        {STEPS.map((s, i) => (
          <li key={s.id}>
            <a href={`#${s.id}`} className="group flex h-full gap-3 rounded-lg p-3 transition-colors duration-150 hover:bg-white/5 lg:flex-col lg:gap-2">
              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-lp-brand text-[13px] font-semibold text-white">
                {i + 1}
              </span>
              <span>
                <span className="block text-[15px] font-semibold text-white group-hover:text-lp-signal">{s.short}</span>
                <span className="mt-0.5 block text-[13px] leading-snug text-white/60">{s.caption}</span>
              </span>
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Section({
  id,
  eyebrow,
  title,
  tech,
  children,
}: {
  id: string;
  eyebrow?: string;
  title: string;
  tech?: TechRow[];
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-6 border-t border-lp-line py-10 first:border-t-0 first:pt-0">
      {eyebrow ? <p className="text-sm font-semibold uppercase tracking-wide text-lp-brand">{eyebrow}</p> : null}
      <h2 id={`${id}-title`} className="mt-1 font-display text-[1.75rem] font-semibold leading-tight text-lp-ink sm:text-[2rem]">
        {title}
      </h2>
      <div className="mt-4 space-y-4 text-[17px] leading-relaxed text-lp-ink/90">{children}</div>
      {tech?.length ? <TechDetails rows={tech} /> : null}
    </section>
  );
}

/** Models and numbers for one step. Closed by default; the page reads whole without it. */
function TechDetails({ rows }: { rows: TechRow[] }) {
  return (
    <details className="group mt-5 rounded-xl border border-lp-line bg-white">
      <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-2 px-4 text-[15px] font-semibold text-lp-ink [&::-webkit-details-marker]:hidden">
        Technical details
        <ChevronDownIcon className="h-4 w-4 text-lp-muted transition-transform duration-200 group-open:rotate-180" aria-hidden="true" />
      </summary>
      <dl className="divide-y divide-lp-line border-t border-lp-line">
        {rows.map((r) => (
          <div key={r.label} className="grid gap-1 px-4 py-3 sm:grid-cols-[11rem_1fr] sm:gap-4">
            <dt className="text-[14px] font-medium text-lp-muted">{r.label}</dt>
            <dd className="text-[15px] leading-relaxed text-lp-ink">{r.value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/** What an answer can say, in the product's own words. */
function Outcomes() {
  const cantTell = [...new Set(Object.values(ND_HEADLINE).filter((h): h is string => Boolean(h)))];
  return (
    <div className="space-y-6 pt-2">
      <div>
        <h3 className="text-[17px] font-semibold text-lp-ink">A question about what they did</h3>
        <ul className="mt-2 space-y-1.5">
          {Object.values(ANSWER_LABEL_COPY).map((label) => (
            <li key={label} className="flex items-start gap-2 text-[16px]">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-lp-brand" aria-hidden="true" />
              {label}
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="text-[17px] font-semibold text-lp-ink">A statement or a promise</h3>
        <dl className="mt-2 space-y-2">
          {VERDICTS.map((v) => (
            <div key={v.label}>
              <dt className="font-medium text-lp-ink">{v.label}</dt>
              <dd className="text-[16px] text-lp-muted">{v.meaning}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div>
        <h3 className="text-[17px] font-semibold text-lp-ink">When we can’t tell</h3>
        <p className="mt-1 text-[16px] text-lp-muted">We say so, with the reason, rather than guess. The answer will read:</p>
        <dl className="mt-2 space-y-2">
          {cantTell.map((h) => (
            <div key={h}>
              <dt className="font-medium text-lp-ink">“{h}”</dt>
              {CANT_TELL_MEANING[h] ? <dd className="text-[16px] text-lp-muted">{CANT_TELL_MEANING[h]}</dd> : null}
            </div>
          ))}
        </dl>
      </div>

      <div>
        <h3 className="text-[17px] font-semibold text-lp-ink">How sure we are: High, Medium or Low</h3>
        <p className="mt-1 text-[16px] text-lp-muted">Every answer says how sure we are, and why. The level comes from the clearest evidence behind it:</p>
        <dl className="mt-2 space-y-3">
          {BANDS.map((b) => (
            <div key={b.level}>
              <dt className="font-medium text-lp-ink">{b.level}, when</dt>
              <dd>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-[16px] text-lp-muted">
                  {b.reasons.map((r) => (
                    <li key={r}>{BAND_REASON_COPY[r]}</li>
                  ))}
                </ul>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

function Table({ caption, rows, mono = false }: { caption: string; rows: TechRow[]; mono?: boolean }) {
  return (
    <table className="w-full text-left text-[15px]">
      <caption className="pb-2 text-left text-[16px] font-semibold text-lp-ink">{caption}</caption>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label} className="border-t border-lp-line">
            <th scope="row" className="w-[45%] py-2.5 pr-4 align-top font-medium text-lp-muted">
              {r.label}
            </th>
            <td className={`py-2.5 align-top text-lp-ink ${mono ? 'font-lp-mono text-[14px]' : ''}`}>{r.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
