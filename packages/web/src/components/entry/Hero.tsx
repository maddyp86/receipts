import { ArrowRightIcon } from 'lucide-react';
import { surnameOf } from '@receipts/shared';
import { STARTERS, type Starter } from '../../data/topics.js';
import type { Member } from '../../data/roster.js';

// ===========================================================================
// Pieces shared by the entry screens: one-tap starter questions, and the
// helper that puts a member's name into one.
//
// Each starter is an eval case (topics.ts STARTERS), so a first answer is a
// real one, not "nothing found".
// ===========================================================================

interface StartersProps {
  /** Covered members; a starter shows only when its member is covered. */
  members: ReadonlyArray<Member>;
  onStart: (starter: Starter) => void;
  busy: boolean;
}

/** One-tap first questions, under the query card. */
export function Starters({ members, onStart, busy }: StartersProps) {
  const starters = STARTERS.flatMap((s) => {
    const m = members.find((x) => x.politician_id === s.politicianId && x.cached);
    return m ? [{ starter: s, member: m }] : [];
  });
  if (!starters.length) return null;

  return (
    <section aria-labelledby="starters-heading">
      <h2 id="starters-heading" className="text-[15px] font-semibold text-ink-soft">
        Or try one now, one tap:
      </h2>
      <ul className="mt-2 space-y-2">
        {starters.map(({ starter, member }) => (
          <li key={starter.evalCase}>
            <button
              type="button"
              disabled={busy}
              onClick={() => onStart(starter)}
              className="group flex min-h-[48px] w-full items-center gap-3 rounded-card border border-rule bg-card px-4 py-2.5 text-left transition-colors duration-150 hover:border-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-60"
            >
              <span className="min-w-0 flex-1 text-[15px] leading-snug text-ink">
                {withName(starter.text, surnameOf(member.name))}
                <span className="text-ink-soft">
                  {' '}
                  · {member.party && member.state ? `${member.party}-${member.state}` : member.name}
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
  );
}

/** "Did they vote for X?" → "Did Thune vote for X?" — reads as a real question about a real person. */
export function withName(text: string, surname: string): string {
  return text.replace(/^(Did|Do|Does|Has|Have) they\b/, (_m, verb: string) => {
    const v = verb === 'Do' ? 'Does' : verb === 'Have' ? 'Has' : verb;
    return `${v} ${surname}`;
  });
}
