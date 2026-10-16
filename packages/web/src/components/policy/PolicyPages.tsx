import type { ReactNode } from 'react';
import { ArrowLeftIcon } from 'lucide-react';
import { FundingProvider, formatPrice, useFundingStatus } from '../members/FundRecord.js';

// ===========================================================================
// Terms, Privacy and Refunds.
//
// HONEST TO THE CODE. Every sentence here describes what the app actually
// does today; change the code and this file in the same PR. In particular:
//   - stored per question: app.app_sessions (user agent), app.app_queries,
//     app.app_query_trace_* (the model calls), app.member_requests;
//   - feedback: app.app_feedback, no IP, user agent or session id;
//   - funding: app.member_funding (email, optional credit name), card
//     details only ever at Stripe; the name is shown only on 'live' rows
//     (migration 019); the email is used for the go-live notice;
//   - the tab id is sessionStorage (session.ts); no cookies, no analytics;
//   - IP addresses are used by the rate limiter in memory and not stored by
//     the app (hosts keep their own logs).
// ===========================================================================

export const POLICY_PATHS = {
  '/terms': 'terms',
  '/privacy': 'privacy',
  '/refunds': 'refunds',
} as const;

export type PolicyKind = (typeof POLICY_PATHS)[keyof typeof POLICY_PATHS];

const UPDATED = 'October 15, 2026';
const DEFAULT_PRICE_CENTS = 2000;
const DEFAULT_SLA_DAYS = 14;

const TITLES: Record<PolicyKind, string> = {
  terms: 'Terms of use',
  privacy: 'Privacy',
  refunds: 'Refund policy',
};

/** The links at the foot of every page. */
export function SiteFooter() {
  return (
    <footer className="mx-auto max-w-2xl px-5 pb-10 pt-4 sm:px-8">
      <nav aria-label="Policies" className="flex flex-wrap gap-x-5 gap-y-2 border-t border-rule pt-5 text-[14px]">
        {(Object.keys(POLICY_PATHS) as (keyof typeof POLICY_PATHS)[]).map((path) => (
          <a key={path} href={path} className="text-ink-soft underline underline-offset-2 hover:text-ink">
            {TITLES[POLICY_PATHS[path]]}
          </a>
        ))}
      </nav>
    </footer>
  );
}

function H2({ children }: { children: ReactNode }) {
  return <h2 className="mt-8 font-serif text-[22px] leading-tight text-ink">{children}</h2>;
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="text-ink underline underline-offset-2">
      {children}
    </a>
  );
}

function Terms() {
  return (
    <>
      <p>
        Receipts checks what members of the U.S. Congress say against their recorded votes and the bills they
        sponsored. By using this site you agree to these terms.
      </p>

      <H2>What Receipts is, and isn’t</H2>
      <p>
        Answers are built from public records, such as Senate roll-call votes and bill data from congress.gov and
        GovInfo. AI models from Anthropic and OpenAI help read your question, find related bills and write the
        explanation. Every answer links to the bills it relied on, so you can check them yourself.
      </p>
      <p>
        Receipts is in beta. It covers the 118th Congress (from January 2023) onward. It can miss bills, misread a
        question, or be wrong. An answer is a starting point for your own judgment, not a final finding about anyone. It
        is not legal advice and not advice on how to vote.
      </p>

      <H2>Using the site</H2>
      <ul className="list-disc space-y-2 pl-6">
        <li>There are no accounts. Anyone can use the site for free.</li>
        <li>
          Each address has a daily limit on questions, and the whole site has a daily limit. Please don’t try to get
          around them, scrape the site in bulk, or interfere with how it runs.
        </li>
        <li>
          A share link shows a stored answer to anyone who has the link. Don’t put anything in a question you wouldn’t
          want someone else to see.
        </li>
      </ul>

      <H2>Funding a record</H2>
      <p>
        You can pay a one-time fee to have a senator whose record we haven’t checked yet added to Receipts. The payment
        covers the cost of checking that record once. When it’s done, the record is free for everyone. The payment
        doesn’t change what we find, and it doesn’t buy you any say over the result. It is a purchase of a service, not
        a donation, and it is not tax-deductible. Stripe handles the payment. If you give a name at checkout, we show
        it on the record as its funder once the record is live; we may leave out a name that isn’t fit to publish. We
        email you when the record is ready. Refunds are covered in the{' '}
        <Link href="/refunds">refund policy</Link>.
      </p>

      <H2>No warranty</H2>
      <p>
        The site is provided as is, without any warranty that it is complete, accurate or always available. To the
        extent the law allows, Receipts is not liable for any loss that comes from relying on it. If you paid to fund a
        record, the most we owe you is a refund of what you paid.
      </p>

      <H2>Changes</H2>
      <p>
        We may update these terms. The date at the top says when they last changed. Using the site after a change
        means you accept the new terms.
      </p>
    </>
  );
}

function Privacy() {
  return (
    <>
      <p>Receipts has no accounts, no ads, no analytics and no tracking cookies. This page lists what we do keep.</p>

      <H2>When you ask a question</H2>
      <ul className="list-disc space-y-2 pl-6">
        <li>
          We store your question, the member you asked about, the answer, and the steps that produced it, including what
          was sent to and returned by the AI models. We use this to fix wrong answers and to power share links.
        </li>
        <li>We store your browser’s user-agent string (the browser and operating system it reports).</li>
        <li>
          If you ask about a member we haven’t checked yet, we store the question and the member’s name as a request.
          That tells us whose records people want.
        </li>
        <li>
          Your browser keeps a random ID for the current tab, used only so a repeated question can be answered from a
          short-lived cache. It is deleted when you close the tab and isn’t tied to who you are.
        </li>
        <li>
          Your IP address is used to apply the daily question limit. The app doesn’t store it, but our hosting
          providers keep standard server logs that can include it.
        </li>
      </ul>

      <H2>When you send feedback</H2>
      <p>
        We store what you picked and any comment you wrote, with the answer it was about. We don’t store your IP
        address, user agent or tab ID with it. Feedback is read by a person, and it can’t change an answer by itself.
      </p>

      <H2>When you fund a record</H2>
      <p>
        Stripe takes the payment on its own page. We never see or store your card number. Stripe gives us your email,
        the amount, and the name you asked to be credited with, if you entered one. We use your email to tell you when
        the record is live, to send a refund if one is owed, and to answer questions about your payment. We don’t add
        you to a mailing list. If you gave a name, it is shown publicly on the record as its funder once the record is
        live. Leave it blank and you won’t be named.
      </p>

      <H2>Who else handles this data</H2>
      <ul className="list-disc space-y-2 pl-6">
        <li>Anthropic and OpenAI receive the text of your question to read it, search for bills and write the answer.</li>
        <li>Supabase stores the database.</li>
        <li>Render runs the server, and Vercel serves the website.</li>
        <li>Stripe processes payments under its own privacy policy.</li>
      </ul>
      <p>We don’t sell your data or share it with anyone else, and we don’t use it for advertising.</p>

      <H2>How long we keep it</H2>
      <p>
        We don’t delete stored questions, answers or requests on a fixed schedule yet. Payment records are kept as long
        as we need them for refunds, accounting and the law.
      </p>

      <H2>Children</H2>
      <p>Receipts is not aimed at children under 13.</p>

      <H2>Changes</H2>
      <p>If this changes, we’ll update this page and the date at the top.</p>
    </>
  );
}

function Refunds() {
  const status = useFundingStatus();
  const price = formatPrice(status.price_cents ?? DEFAULT_PRICE_CENTS, status.currency);
  const days = status.sla_days ?? DEFAULT_SLA_DAYS;
  return (
    <>
      <p>
        This covers the one-time payment ({price}) to have a senator’s record checked and added to Receipts.
      </p>

      <H2>What you’re paying for</H2>
      <p>
        We check the senator’s votes and sponsored bills, review them by hand, and publish the record so anyone can
        check it for free. The payment doesn’t affect what the record shows. It is not a donation and is not
        tax-deductible.
      </p>

      <H2>When you get a full refund</H2>
      <ul className="list-disc space-y-2 pl-6">
        <li>
          <span className="font-semibold text-ink">The record isn’t live within {days} days of your payment.</span> We
          refund you in full without being asked.
        </li>
        <li>
          <span className="font-semibold text-ink">Someone else already paid for the same senator.</span> If two
          payments arrive for one record, the later one is refunded in full.
        </li>
        <li>
          <span className="font-semibold text-ink">You change your mind before we start.</span> Ask before work on the
          record has begun and we refund you in full.
        </li>
      </ul>

      <H2>When we can’t refund</H2>
      <p>
        Once the record is live, the service has been delivered and the payment can’t be refunded. That applies even if
        you disagree with what the record shows.
      </p>

      <H2>How refunds are paid</H2>
      <p>
        Refunds go back to the card or account you paid with, through Stripe. Your bank usually shows them within 5 to
        10 business days. To ask about a payment, use the support contact on your Stripe receipt.
      </p>
    </>
  );
}

/** One policy page, whole: back link, title, date, body, footer. */
export function PolicyPage({ kind }: { kind: PolicyKind }) {
  const body = kind === 'terms' ? <Terms /> : kind === 'privacy' ? <Privacy /> : <Refunds />;
  return (
    <FundingProvider>
      <div className="min-h-screen w-full bg-paper">
        <main className="mx-auto max-w-2xl px-5 pb-10 pt-8 sm:px-8 sm:pt-12">
          <a href="/" className="inline-flex min-h-[44px] items-center gap-1.5 text-[16px] font-medium text-focus">
            <ArrowLeftIcon className="h-4 w-4" aria-hidden="true" />
            Back to Receipts
          </a>
          <h1 className="mt-4 font-serif text-[34px] leading-tight text-ink">{TITLES[kind]}</h1>
          <p className="mt-1 text-[14px] text-ink-faint">Last updated {UPDATED}</p>
          <div className="mt-6 space-y-4 text-[17px] leading-relaxed text-ink-soft">{body}</div>
        </main>
        <SiteFooter />
      </div>
    </FundingProvider>
  );
}

/** The policy page for this path, or null when the path is the app. */
export function policyForPath(pathname: string): PolicyKind | null {
  const path = pathname.replace(/\/+$/, '') as keyof typeof POLICY_PATHS;
  return POLICY_PATHS[path] ?? null;
}
