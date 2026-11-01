import { useMemo, useRef, useState } from 'react';
import { ArrowRightIcon, InfoIcon, XIcon } from 'lucide-react';
import type { Senator } from '@receipts/shared';
import type { Member } from '../data/roster.js';
import { BetaNotice } from './entry/BetaNotice.js';
import { ExampleAnswer, Proof, Starters } from './entry/Hero.js';
import { LawmakerSearch } from './entry/LawmakerSearch.js';
import type { Starter } from '../data/topics.js';
import { PromiseInput, type StatementKind } from './entry/PromiseInput.js';
import { MemberPicker } from './members/MemberPicker.js';

// Exported from here as before; the list itself lives with the other input copy.
export { SPECIFIC_EXAMPLES } from '../data/topics.js';

// ===========================================================================
// The entry screen: step one of two. Step two is the answer.
//
// Everything a first-time visitor needs is above the fold: what Receipts is
// (headline), and one card to ask in — who (a name search), what (the
// question), and the button. One-tap starters sit under the card for anyone
// who would rather see an answer first. On a wide screen an example answer
// and the reasons to trust it sit beside the card; on a phone, below it.
//
// The full picker (by state, House district, request or sponsor a record)
// is still here, opened from the search, not leading the page. Coverage is
// shown honestly in both: unchecked members are listed, never selectable.
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
  /** A one-tap starter from the hero: runs that question about that member now. */
  onStart?: (starter: Starter) => void;
  /** The beta scope note. It points at "Something look wrong?", so only where that exists. */
  showScopeNote?: boolean;
  /** Back to the landing page (the wordmark). Omitted: the wordmark is plain text. */
  onHome?: () => void;

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
  onStart,
  onHome,
  showScopeNote = false,
  kindEnabled = false,
  kind = 'position',
  onKindChange = () => {},
}: Props) {
  const browseRef = useRef<HTMLElement>(null);
  /** The browse panel: closed, or open (at a name, when one was picked from the search). */
  const [browse, setBrowse] = useState<{ query: string; n: number } | null>(null);

  const members = useMemo<Member[]>(
    () => senators.map((s) => ('chamber' in s ? s : { ...s, chamber: 'senate' as const })),
    [senators],
  );
  // Only a covered member can be the selection: an id for someone the pipeline
  // has not analysed would run straight into the "not analysed" stop.
  const member = members.find((m) => m.politician_id === selected && m.cached) ?? null;

  const hasPromise = promise.trim().length > 2;
  const blockedReason = !member ? 'Pick who to check first' : !hasPromise ? 'Tell us what to check' : null;

  function openBrowse(query = '') {
    setBrowse((b) => ({ query, n: (b?.n ?? 0) + 1 }));
    requestAnimationFrame(() => browseRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  function handleSubmit() {
    if (busy) return;
    if (!member) {
      document.getElementById('lawmaker')?.focus();
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
      className="lg:grid lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:items-start lg:gap-12"
    >
      <div className="min-w-0">
        {/* The tool's own header: the landing page did the persuading, so
            this is a working screen, not a pitch. */}
        <header>
          {onHome ? (
            <button type="button" onClick={onHome} className="font-serif text-[22px] leading-none text-ink hover:text-focus">
              Receipts
            </button>
          ) : (
            <p className="font-serif text-[22px] leading-none text-ink">Receipts</p>
          )}
          <h1 className="mt-4 font-serif text-[30px] leading-tight text-ink sm:text-[36px]">Check the record</h1>
          <p className="mt-2 max-w-[46ch] text-[16px] leading-snug text-ink-soft sm:text-[17px]">
            Pick a lawmaker, then ask about a vote, a promise or a position.
          </p>
        </header>

        <section aria-label="Ask about a lawmaker" className="mt-5 rounded-card border border-rule bg-card p-4 shadow-soft sm:mt-6 sm:p-5">
          <label htmlFor="lawmaker" className="block text-[16px] font-semibold text-ink">
            Who do you want to check?
          </label>
          <div className="mt-2">
            <LawmakerSearch
              members={members}
              selected={member}
              onSelect={(id) => {
                onSelect(id);
                setBrowse(null);
              }}
              onClear={() => onSelect('')}
              onBrowse={openBrowse}
            />
          </div>

          <div className="mt-4 sm:mt-5">
            <PromiseInput
              compact
              memberName={member?.name ?? null}
              value={promise}
              onChange={onPromiseChange}
              kindEnabled={kindEnabled}
              kind={kind}
              onKindChange={onKindChange}
            />
          </div>

          <button
            type="submit"
            aria-disabled={blockedReason || busy ? 'true' : undefined}
            className={`mt-3 flex min-h-[56px] w-full items-center justify-center gap-2 rounded-card text-[18px] font-semibold transition-colors duration-150 ${
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
        </section>

        {onStart ? (
          <div className="mt-6">
            <Starters members={members} onStart={onStart} busy={busy} />
          </div>
        ) : null}

        <BetaNotice full={showScopeNote} />

        {browse ? (
          <section ref={browseRef} aria-labelledby="browse-heading" className="mt-10 scroll-mt-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="browse-heading" className="font-serif text-[26px] leading-tight text-ink">
                  Find a lawmaker
                </h2>
                <p className="mb-5 mt-1 text-[16px] text-ink-soft">
                  These are the members of Congress we’ve checked so far. More are being added.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setBrowse(null)}
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink-soft hover:text-ink"
                aria-label="Close"
              >
                <XIcon className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            <MemberPicker
              key={browse.n}
              members={members}
              selectedId={null}
              initialMode={browse.query ? 'name' : 'state'}
              initialQuery={browse.query}
              onSelect={(id) => {
                onSelect(id);
                setBrowse(null);
                window.scrollTo({ top: 0, behavior: 'smooth' });
                requestAnimationFrame(() => document.getElementById('promise')?.focus());
              }}
            />
          </section>
        ) : null}
      </div>

      {/* What an answer looks like, and why to trust it: beside the card on a
          wide screen, under everything on a phone. */}
      <aside aria-label="What you get" className="mt-10 space-y-6 lg:mt-[166px]">
        <ExampleAnswer />
        <Proof />
      </aside>
    </form>
  );
}
