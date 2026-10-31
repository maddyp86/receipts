import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { MapIcon, SearchIcon, XIcon } from 'lucide-react';
import type { Member } from '../../data/roster.js';
import { memberTitle, stateName } from '../../lib/members.js';
import { MemberPortrait } from '../members/MemberPortrait.js';

// ===========================================================================
// "Who?" — find a lawmaker by typing their name or state.
//
// The first field of the query card on the landing page. Empty and focused,
// it lists the members we can check now, so a visitor sees who is covered
// without having to guess a name. Typing filters the whole directory with
// the same rule as the browse panel's name search (name + state name).
//
// Coverage stays honest: a member we have not analysed is listed, greyed
// out and labeled "Not checked yet", and is never selectable. Picking one
// opens the browse panel at them, where their request / sponsor card lives.
// ===========================================================================

export const SEARCH_LIMIT = 8;

/**
 * The dropdown's rows for a query. Pure, for the test.
 *
 * Empty query: covered members only. With a query: every match, covered
 * first, then members whose surname or first name starts with the query
 * before those that merely contain it, then alphabetical.
 */
export function rankMatches(members: readonly Member[], query: string, limit = SEARCH_LIMIT): Member[] {
  const q = query.trim().toLowerCase();
  if (!q) return members.filter((m) => m.cached).slice(0, limit);
  const startsWord = (m: Member) => m.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q));
  return members
    .filter((m) => `${m.name} ${stateName(m.state)} ${m.state ?? ''}`.toLowerCase().includes(q))
    .sort(
      (a, b) =>
        Number(b.cached) - Number(a.cached) ||
        Number(startsWord(b)) - Number(startsWord(a)) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, limit);
}

/** "John Thune (R-SD)". */
export function shortLabel(m: Pick<Member, 'name' | 'party' | 'state'>): string {
  return m.party && m.state ? `${m.name} (${m.party}-${m.state})` : m.name;
}

interface Props {
  members: readonly Member[];
  /** The picked member, shown as a chip in place of the input. */
  selected: Member | null;
  onSelect: (id: string) => void;
  onClear: () => void;
  /** Open the browse panel, at this name if one was given (an unchecked member). */
  onBrowse: (name?: string) => void;
}

export function LawmakerSearch({ members, selected, onSelect, onClear, onBrowse }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const rows = useMemo(() => rankMatches(members, query), [members, query]);

  // Close when focus or a click leaves the field and its list.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => setActive(0), [query]);

  function choose(m: Member) {
    setOpen(false);
    setQuery('');
    if (m.cached) {
      onSelect(m.politician_id);
      // Straight on to the question.
      requestAnimationFrame(() => document.getElementById('promise')?.focus());
    } else {
      onBrowse(m.name);
    }
  }

  if (selected) {
    return (
      <div className="flex min-h-[56px] items-center gap-3 rounded-card border border-ink bg-card px-3 py-2 ring-1 ring-ink">
        <MemberPortrait politicianId={selected.politician_id} name={selected.name} />
        <span className="min-w-0 flex-1">
          <span className="block text-[17px] font-semibold leading-snug text-ink">{selected.name}</span>
          <span className="block text-[14px] leading-snug text-ink-soft">{memberTitle(selected)}</span>
        </span>
        <button
          type="button"
          onClick={() => {
            onClear();
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink-soft hover:text-ink"
          aria-label={`Change from ${selected.name}`}
        >
          <XIcon className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
    );
  }

  const showList = open && (rows.length > 0 || query.trim().length > 0);

  return (
    <div ref={boxRef} className="relative">
      <div className="flex items-center rounded-card border border-rule bg-card focus-within:border-focus focus-within:ring-1 focus-within:ring-focus">
        <SearchIcon className="ml-4 h-5 w-5 shrink-0 text-ink-soft" aria-hidden="true" />
        <input
          ref={inputRef}
          id="lawmaker"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && rows[active] ? `${listId}-${active}` : undefined}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
              setActive((i) => Math.min(i + 1, rows.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter') {
              // Enter picks; it never submits the form from this field.
              e.preventDefault();
              if (showList && rows[active]) choose(rows[active]!);
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
          placeholder="Type a name or state"
          autoComplete="off"
          className="min-h-[56px] w-full bg-transparent px-3 text-[17px] text-ink placeholder:text-ink-faint focus:outline-none"
        />
      </div>

      {showList ? (
        <div className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-card border border-rule bg-card shadow-soft">
          {!query.trim() ? (
            <p className="border-b border-rule px-4 py-2 text-[13px] font-medium uppercase tracking-wide text-ink-faint">
              Ready to check now
            </p>
          ) : null}
          <ul id={listId} role="listbox" aria-label="Lawmakers" className="max-h-[320px] overflow-y-auto">
            {rows.map((m, i) => (
              <li
                key={m.politician_id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                data-covered={m.cached ? 'true' : 'false'}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(m)}
                onMouseEnter={() => setActive(i)}
                className={`flex cursor-pointer items-center gap-3 px-3 py-2.5 ${i === active ? 'bg-paper' : ''}`}
              >
                <MemberPortrait politicianId={m.politician_id} name={m.name} muted={!m.cached} />
                <span className="min-w-0 flex-1">
                  <span className={`block text-[16px] font-medium leading-snug ${m.cached ? 'text-ink' : 'text-ink-soft'}`}>
                    {shortLabel(m)}
                  </span>
                  <span className="block text-[14px] leading-snug text-ink-soft">
                    {m.cached ? memberTitle(m) : 'Not checked yet · request their record'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {query.trim() && rows.length === 0 ? (
            <p className="px-4 py-3 text-[15px] text-ink-soft">Nobody by that name yet. More members are being added.</p>
          ) : null}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setOpen(false);
              onBrowse();
            }}
            className="flex w-full items-center gap-2 border-t border-rule px-4 py-3 text-left text-[15px] font-medium text-focus hover:bg-paper"
          >
            <MapIcon className="h-4 w-4" aria-hidden="true" />
            Browse by state, or find your House district
          </button>
        </div>
      ) : null}
    </div>
  );
}
