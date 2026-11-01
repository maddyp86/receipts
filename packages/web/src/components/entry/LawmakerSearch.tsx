import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { MapIcon, SearchIcon, XIcon } from 'lucide-react';
import type { Member } from '../../data/roster.js';
import { initials, memberTitle, stateName } from '../../lib/members.js';
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
  /** Light for the tool; dark for the landing page's navy composer. */
  tone?: 'light' | 'dark';
  /**
   * A member we have not checked was picked. Given: the caller shows their
   * sponsor / request panel in place (the landing page). Omitted: the browse
   * panel opens at their card (the tool).
   */
  onPickUnchecked?: (id: string) => void;
}

/** Class sets per tone. Light is the tool's look, unchanged; dark is the landing page's. */
const TONES = {
  light: {
    chip: 'flex min-h-[56px] items-center gap-3 rounded-card border border-ink bg-card px-3 py-2 ring-1 ring-ink',
    chipName: 'block text-[17px] font-semibold leading-snug text-ink',
    chipSub: 'block text-[14px] leading-snug text-ink-soft',
    clear: 'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink-soft hover:text-ink',
    field: 'flex items-center rounded-card border border-rule bg-card focus-within:border-focus focus-within:ring-1 focus-within:ring-focus',
    searchIcon: 'ml-4 h-5 w-5 shrink-0 text-ink-soft',
    input: 'min-h-[56px] w-full bg-transparent px-3 text-[17px] text-ink placeholder:text-ink-faint focus:outline-none',
    list: 'absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-card border border-rule bg-card shadow-soft',
    overline: 'border-b border-rule px-4 py-2 text-[13px] font-medium uppercase tracking-wide text-ink-faint',
    rowActive: 'bg-paper',
    name: 'text-ink',
    nameOff: 'text-ink-soft',
    sub: 'block text-[14px] leading-snug text-ink-soft',
    empty: 'px-4 py-3 text-[15px] text-ink-soft',
    browse: 'flex w-full items-center gap-2 border-t border-rule px-4 py-3 text-left text-[15px] font-medium text-focus hover:bg-paper',
  },
  dark: {
    chip: 'flex min-h-[56px] items-center gap-3 rounded-xl border border-white/10 bg-lp-navy px-3 py-2.5',
    chipName: 'block truncate text-[15px] font-medium text-white',
    chipSub: 'block text-xs text-white/55',
    clear: 'shrink-0 rounded-md px-2 py-1 text-sm font-medium text-lp-signal hover:bg-white/10',
    field: 'flex items-center rounded-xl border border-white/15 bg-lp-navy transition-[border-color,box-shadow] duration-150 focus-within:border-lp-signal focus-within:ring-4 focus-within:ring-lp-signal/20',
    searchIcon: 'ml-3.5 h-4 w-4 shrink-0 text-white/50',
    input: 'min-h-[48px] w-full bg-transparent px-3 text-[15px] text-white placeholder:text-white/40 focus:outline-none',
    list: 'absolute inset-x-0 top-full z-20 mt-2 overflow-hidden rounded-xl bg-lp-navy2 shadow-2xl ring-1 ring-white/15',
    overline: 'border-b border-white/10 px-4 py-2 text-[12px] font-medium uppercase tracking-wide text-white/50',
    rowActive: 'bg-white/10',
    name: 'text-white',
    nameOff: 'text-white/55',
    sub: 'block text-xs text-white/55',
    empty: 'px-4 py-3 text-sm text-white/60',
    browse: 'flex w-full items-center gap-2 border-t border-white/10 px-4 py-3 text-left text-sm font-medium text-lp-signal hover:bg-white/5',
  },
} as const;

/** The landing page's avatar: initials in a neutral circle, the same for every party. */
function DarkAvatar({ name, muted }: { name: string; muted?: boolean }) {
  const ini = initials(name);
  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-lp-signal/15 text-xs font-semibold text-lp-signal ${muted ? 'opacity-50' : ''}`}
    >
      {ini}
    </span>
  );
}

export function LawmakerSearch({ members, selected, onSelect, onClear, onBrowse, tone = 'light', onPickUnchecked }: Props) {
  const t = TONES[tone];
  const dark = tone === 'dark';
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
    } else if (onPickUnchecked) {
      onPickUnchecked(m.politician_id);
    } else {
      onBrowse(m.name);
    }
  }

  if (selected) {
    return (
      <div className={t.chip}>
        {dark ? <DarkAvatar name={selected.name} /> : <MemberPortrait politicianId={selected.politician_id} name={selected.name} />}
        <span className="min-w-0 flex-1">
          <span className={t.chipName}>{selected.name}</span>
          <span className={t.chipSub}>{memberTitle(selected)}</span>
        </span>
        <button
          type="button"
          onClick={() => {
            onClear();
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
          className={t.clear}
          aria-label={`Change from ${selected.name}`}
        >
          {dark ? 'Change' : <XIcon className="h-5 w-5" aria-hidden="true" />}
        </button>
      </div>
    );
  }

  const showList = open && (rows.length > 0 || query.trim().length > 0);

  return (
    <div ref={boxRef} className="relative">
      <div className={t.field}>
        <SearchIcon className={t.searchIcon} aria-hidden="true" />
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
          className={t.input}
        />
      </div>

      {showList ? (
        <div className={t.list}>
          {!query.trim() ? (
            <p className={t.overline}>
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
                className={`flex cursor-pointer items-center gap-3 px-3 py-2.5 ${i === active ? t.rowActive : ''}`}
              >
                {dark ? (
                  <DarkAvatar name={m.name} muted={!m.cached} />
                ) : (
                  <MemberPortrait politicianId={m.politician_id} name={m.name} muted={!m.cached} />
                )}
                <span className="min-w-0 flex-1">
                  <span className={`block font-medium leading-snug ${dark ? 'text-sm' : 'text-[16px]'} ${m.cached ? t.name : t.nameOff}`}>
                    {shortLabel(m)}
                  </span>
                  <span className={t.sub}>
                    {m.cached ? memberTitle(m) : dark ? 'Not checked yet' : 'Not checked yet · request their record'}
                  </span>
                </span>
                {dark ? (
                  m.cached ? (
                    <span className="shrink-0 rounded-full bg-lp-verified/25 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-lp-verified-bright">
                      Ready
                    </span>
                  ) : (
                    <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-white/55">
                      Not checked
                    </span>
                  )
                ) : null}
              </li>
            ))}
          </ul>
          {!query.trim() ? (
            // Open and empty, only the checked are listed: say plainly that
            // everyone else is one search away, so nobody concludes their
            // senator is missing.
            <p className={dark ? 'border-t border-white/10 px-4 py-2.5 text-[13px] text-white/60' : 'border-t border-rule px-4 py-2.5 text-[14px] text-ink-soft'}>
              Not listed? Type any member of Congress. If we haven’t checked them yet, you can request their record.
            </p>
          ) : null}
          {query.trim() && rows.length === 0 ? (
            <p className={t.empty}>Nobody by that name yet. More members are being added.</p>
          ) : null}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setOpen(false);
              onBrowse();
            }}
            className={t.browse}
          >
            <MapIcon className="h-4 w-4" aria-hidden="true" />
            Browse by state, or find your House district
          </button>
        </div>
      ) : null}
    </div>
  );
}
