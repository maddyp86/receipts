import { useMemo, useRef } from 'react';
import { ArrowRightIcon, FileTextIcon, InfoIcon } from 'lucide-react';
import type { Senator } from '@receipts/shared';
import type { Member } from '../data/roster.js';
import { BetaNotice } from './entry/BetaNotice.js';
import { HowItWorks } from './entry/HowItWorks.js';
import { PromiseInput, type StatementKind } from './entry/PromiseInput.js';
import { MemberPicker } from './members/MemberPicker.js';
import { SelectedMember } from './members/SelectedMember.js';

// Exported from here as before; the list itself lives with the other input copy.
export { SPECIFIC_EXAMPLES } from '../data/topics.js';

// ===========================================================================
// The entry screen.
//
// Two steps, in the order a voter thinks: who, then what. The picker is not
// clutter — it is how a reader learns what they can ask, so coverage is shown
// honestly (checked now / being added) rather than hidden behind a search box
// that quietly fails.
//
// Nobody is preselected. With a short list, a default would be a nudge toward
// whichever member happens to be first.
// ===========================================================================

interface Props {
  /** The picker's list. Plain `Senator` rows are shown as senators. */
  senators: ReadonlyArray<Member | Senator>;
  /** The selected member's id, or '' for none. */
  selected: string;
  promise: string;
  busy: boolean;
  onSelect: (politicianId: string) => void;
  onPromiseChange: (text: string) => void;
  onSubmit: () => void;
  /** The beta scope note. It points at "Something look wrong?", so only where that exists. */
  showScopeNote?: boolean;
  /** The reader may assert "this was a campaign promise" (server flag). */
  kindEnabled?: boolean;
  kind?: StatementKind;
  onKindChange?: (kind: StatementKind) => void;
}

export function Entry({
  senators,
  selected,
  promise,
  busy,
  onSelect,
  onPromiseChange,
  onSubmit,
  showScopeNote = false,
  kindEnabled = false,
  kind = 'position',
  onKindChange = () => {},
}: Props) {
  const pickerRef = useRef<HTMLElement>(null);

  const members = useMemo<Member[]>(
    () => senators.map((s) => ('chamber' in s ? s : { ...s, chamber: 'senate' as const })),
    [senators],
  );
  // Only a covered member can be the selection: an id for someone the pipeline
  // has not analysed would run straight into the "not analysed" stop.
  const member = members.find((m) => m.politician_id === selected && m.cached) ?? null;

  const hasPromise = promise.trim().length > 2;
  const blockedReason = !member ? 'Pick who to check first' : !hasPromise ? 'Tell us what they said' : null;
  const stepsDone = !member ? 0 : !hasPromise ? 1 : 2;

  function handleSubmit() {
    if (busy) return;
    if (!member) {
      pickerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (!hasPromise) {
      document.getElementById('promise')?.focus();
      return;
    }
    onSubmit();
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        handleSubmit();
      }}
    >
      <header>
        <h1 className="font-serif text-[36px] leading-none text-ink sm:text-[44px]">Receipts</h1>
        <p className="mt-3 max-w-[38ch] text-[19px] leading-snug text-ink-soft sm:text-[21px]">
          See if what a member of Congress says matches what they do — checked against their real votes and bills.
        </p>
        <BetaNotice full={showScopeNote} />
      </header>

      <div className="mt-6 border-y border-rule py-4">
        <HowItWorks done={stepsDone} />
      </div>

      <section ref={pickerRef} aria-labelledby="picker-heading" className="mt-10 scroll-mt-6">
        {member ? (
          <>
            <h2 id="picker-heading" className="sr-only">
              Who you’re checking
            </h2>
            <SelectedMember member={member} onChange={() => onSelect('')} />
          </>
        ) : (
          <>
            <h2 id="picker-heading" className="font-serif text-[26px] leading-tight text-ink sm:text-[30px]">
              Who do you want to check?
            </h2>
            <p className="mb-5 mt-2 text-[17px] text-ink-soft">
              These are the members of Congress we’ve checked so far. More are being added.
            </p>
            <MemberPicker members={members} selectedId={null} onSelect={onSelect} />
          </>
        )}
      </section>

      <section aria-label="What they said" className="mt-12">
        <PromiseInput
          memberName={member?.name ?? null}
          value={promise}
          onChange={onPromiseChange}
          kindEnabled={kindEnabled}
          kind={kind}
          onKindChange={onKindChange}
        />
      </section>

      <div className="sticky bottom-0 z-10 -mx-5 mt-10 border-t border-rule bg-paper/95 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0 sm:pb-16 sm:backdrop-blur-none">
        <button
          type="submit"
          aria-disabled={blockedReason || busy ? 'true' : undefined}
          className={`flex min-h-[56px] w-full items-center justify-center gap-2 rounded-card text-[18px] font-semibold transition-colors duration-150 ${
            blockedReason
              ? 'cursor-default border border-dashed border-ink-faint bg-cantsay-wash text-ink-soft'
              : 'bg-ink text-paper hover:bg-[#33312D]'
          }`}
        >
          {blockedReason ? (
            <>
              <InfoIcon className="h-5 w-5" aria-hidden="true" />
              {blockedReason}
            </>
          ) : (
            <>
              {busy ? 'Checking…' : 'Check their record'}
              <ArrowRightIcon className="h-5 w-5" aria-hidden="true" />
            </>
          )}
        </button>
        <p className="mt-3 flex items-center justify-center gap-2 text-[15px] text-ink-soft">
          <FileTextIcon className="h-4 w-4" aria-hidden="true" />
          Every answer links back to real bills.
        </p>
      </div>
    </form>
  );
}
