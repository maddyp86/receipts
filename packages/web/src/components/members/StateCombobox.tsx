import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { ChevronDownIcon, MapPinIcon } from 'lucide-react';
import { usStates } from '../../data/states.js';

interface Props {
  onPick: (code: string) => void;
  /** How many members we can check now, by state code. Shown beside the state. */
  coveredCountByState: Record<string, number>;
}

export function StateCombobox({ onPick, coveredCountByState }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return usStates;
    const starts = usStates.filter((s) => s.name.toLowerCase().startsWith(q) || s.code.toLowerCase() === q);
    return starts.length ? starts : usStates.filter((s) => s.name.toLowerCase().includes(q));
  }, [query]);

  function choose(code: string) {
    setOpen(false);
    setQuery('');
    onPick(code);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter' && open && matches[active]) {
      e.preventDefault();
      choose(matches[active].code);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  const activeMatch = open ? matches[active] : undefined;

  return (
    <div className="relative">
      <label htmlFor="state-input" className="sr-only">
        Your state
      </label>
      <div className="flex items-center rounded-card border border-rule bg-card shadow-soft focus-within:border-focus focus-within:ring-1 focus-within:ring-focus">
        <MapPinIcon className="ml-4 h-5 w-5 shrink-0 text-ink-soft" aria-hidden="true" />
        <input
          id="state-input"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeMatch ? `${listId}-${activeMatch.code}` : undefined}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
          placeholder="Type your state"
          autoComplete="off"
          className="min-h-[56px] w-full bg-transparent px-3 text-[17px] text-ink placeholder:text-ink-soft focus:outline-none"
        />
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen((o) => !o)}
          aria-label="Show all states"
          className="mr-1 flex h-12 w-12 items-center justify-center text-ink-soft"
        >
          <ChevronDownIcon className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>

      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="States"
          className="absolute left-0 right-0 z-20 mt-2 max-h-72 overflow-auto rounded-card border border-rule bg-card py-1 shadow-soft"
        >
          {matches.length === 0 ? (
            <li className="px-4 py-3 text-[16px] text-ink-soft">No state matches “{query}”.</li>
          ) : null}
          {matches.map((s, i) => {
            const checked = coveredCountByState[s.code] ?? 0;
            return (
              <li
                key={s.code}
                id={`${listId}-${s.code}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(s.code)}
                onMouseEnter={() => setActive(i)}
                className={`flex min-h-[48px] cursor-pointer items-center justify-between px-4 text-[17px] ${
                  i === active ? 'bg-cantsay-wash' : ''
                }`}
              >
                <span className="text-ink">{s.name}</span>
                {checked > 0 ? <span className="text-[14px] text-ink-soft">{checked} checked</span> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
