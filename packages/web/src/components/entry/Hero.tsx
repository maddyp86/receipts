import { ArrowDownIcon, ArrowRightIcon, CheckIcon, FileTextIcon, ScaleIcon, ShieldQuestionIcon } from 'lucide-react';
import { surnameOf } from '@receipts/shared';
import { STARTERS, type Starter } from '../../data/topics.js';
import type { Member } from '../../data/roster.js';

// ===========================================================================
// The landing hero: what Receipts is, what an answer looks like, and a
// one-tap way to get a first one.
//
// A cold visitor needs three things before they will type: what this does
// (headline), why to believe it (proof bullets), and what they get (an
// example answer). Then the cheapest possible first query: a starter chip
// runs a real question about a real member in one tap.
//
// The example card is a REAL answer, labeled as an example: Thune voted Yea on
// all three Senate votes on S.5 (roll calls 1, 5 and 7 of 2025; passed 64-35),
// checked in core.member_votes — eval case 35. An invented example would be
// the fabricated answer this product exists to avoid.
// ===========================================================================

const PROOF = [
  { Icon: ScaleIcon, text: 'Real votes and bills, not opinions or ratings' },
  { Icon: FileTextIcon, text: 'Every answer links back to the bill' },
  { Icon: ShieldQuestionIcon, text: 'Says “can’t tell” when the record doesn’t settle it' },
];

interface Props {
  /** Covered members; a starter shows only when its member is covered. */
  members: ReadonlyArray<Member>;
  /** Omitted: no starters are offered. */
  onStart?: (starter: Starter) => void;
  onBrowse: () => void;
  busy: boolean;
}

export function Hero({ members, onStart, onBrowse, busy }: Props) {
  const starters = !onStart ? [] : STARTERS.flatMap((s) => {
    const m = members.find((x) => x.politician_id === s.politicianId && x.cached);
    return m ? [{ starter: s, member: m }] : [];
  });

  return (
    <header>
      <p className="font-serif text-[22px] leading-none text-ink">Receipts</p>
      <h1 className="mt-6 text-balance font-serif text-[38px] leading-[1.05] text-ink sm:text-[50px]">
        Hold Congress to its word.
      </h1>
      <p className="mt-4 max-w-[44ch] text-[18px] leading-snug text-ink-soft sm:text-[20px]">
        See whether the people who represent you vote the way they talk, from campaign promises to the bills they back.
      </p>

      <ul className="mt-6 space-y-2.5">
        {PROOF.map(({ Icon, text }) => (
          <li key={text} className="flex items-start gap-3 text-[16px] leading-snug text-ink">
            <Icon className="mt-0.5 h-5 w-5 shrink-0 text-brand" aria-hidden="true" />
            {text}
          </li>
        ))}
      </ul>

      <ExampleAnswer />

      {starters.length ? (
        <section aria-labelledby="starters-heading" className="mt-8">
          <h2 id="starters-heading" className="text-[17px] font-semibold text-ink">
            Try one now, one tap:
          </h2>
          <ul className="mt-3 space-y-2.5">
            {starters.map(({ starter, member }) => (
              <li key={starter.evalCase}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onStart?.(starter)}
                  className="group flex min-h-[56px] w-full items-center gap-3 rounded-card border border-rule bg-card px-4 py-3 text-left shadow-soft transition-colors duration-150 hover:border-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-60"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-medium text-ink-soft">
                      {member.name}
                      {member.party ? ` (${member.party}-${member.state})` : ''}
                    </span>
                    <span className="block text-[16px] leading-snug text-ink">
                      {withName(starter.text, surnameOf(member.name))}
                    </span>
                  </span>
                  <ArrowRightIcon
                    className="h-5 w-5 shrink-0 text-brand transition-transform duration-150 group-hover:translate-x-0.5"
                    aria-hidden="true"
                  />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <button
        type="button"
        onClick={onBrowse}
        className="mt-6 inline-flex min-h-[48px] items-center gap-2 rounded-md text-[17px] font-semibold text-focus underline underline-offset-4"
      >
        Or pick your own lawmaker and question
        <ArrowDownIcon className="h-4 w-4" aria-hidden="true" />
      </button>
    </header>
  );
}

/** "Did they vote for X?" → "Did Thune vote for X?" — reads as a real question about a real person. */
export function withName(text: string, surname: string): string {
  return text.replace(/^(Did|Do|Does|Has|Have) they\b/, (_m, verb: string) => {
    const v = verb === 'Do' ? 'Does' : verb === 'Have' ? 'Has' : verb;
    return `${v} ${surname}`;
  });
}

function ExampleAnswer() {
  return (
    <figure className="mt-8 overflow-hidden rounded-card border border-rule bg-card shadow-soft" aria-label="An example answer">
      <figcaption className="flex items-center justify-between border-b border-rule px-4 py-2 text-[13px] font-medium uppercase tracking-wide text-ink-faint">
        Example answer
        <span className="normal-case tracking-normal">Sen. John Thune</span>
      </figcaption>
      <div className="px-4 py-4">
        <p className="text-[15px] text-ink-soft">“Did Thune vote for the Laken Riley Act?”</p>
        <p className="mt-3 inline-flex items-center gap-2 rounded-full bg-kept-wash px-3 py-1 text-[16px] font-semibold text-kept">
          <CheckIcon className="h-4 w-4" strokeWidth={3} aria-hidden="true" />
          Voted for this.
        </p>
        <p className="mt-3 text-[16px] leading-relaxed text-ink">
          Three recorded Senate votes on S.5 in January 2025, all Yea. The bill passed 64–35.
        </p>
        <ul className="mt-3 flex flex-wrap gap-2" aria-label="Receipts">
          {['Roll call 1', 'Roll call 5', 'Roll call 7'].map((r) => (
            <li key={r} className="rounded-md border border-rule bg-paper px-2.5 py-1 font-mono text-[13px] text-ink-soft">
              S.5 · {r}
            </li>
          ))}
        </ul>
      </div>
    </figure>
  );
}
