import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

// ===========================================================================
// The result's three tabs: Why, Receipts, How we checked.
//
// Every panel is in the page whether or not its tab is open — an inactive
// one is `hidden`, not unmounted — so nothing is lost on a switch (a half-
// written feedback note, an open drill-down), and a test or the eval harness
// reading the markup sees the whole answer. Keyboard: the arrow keys, Home
// and End move between tabs, per the WAI-ARIA tabs pattern.
// ===========================================================================

export interface ResultTab {
  id: string;
  label: ReactNode;
  content: ReactNode;
}

export function ResultTabs({ tabs, initial }: { tabs: ResultTab[]; initial?: string }) {
  const [active, setActive] = useState(initial ?? tabs[0]?.id);
  const base = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const move = (e: KeyboardEvent, i: number) => {
    const last = tabs.length - 1;
    const to =
      e.key === 'ArrowRight' ? (i === last ? 0 : i + 1)
      : e.key === 'ArrowLeft' ? (i === 0 ? last : i - 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : null;
    if (to === null) return;
    e.preventDefault();
    setActive(tabs[to]!.id);
    refs.current[to]?.focus();
  };

  return (
    <div className="result-tabs">
      <div role="tablist" aria-label="About this answer" className="flex gap-1 overflow-x-auto border-b border-rule">
        {tabs.map((t, i) => {
          const on = t.id === active;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${t.id}`}
              aria-selected={on}
              aria-controls={`${base}-panel-${t.id}`}
              tabIndex={on ? 0 : -1}
              onClick={() => setActive(t.id)}
              onKeyDown={(e) => move(e, i)}
              className={`-mb-px min-h-[44px] shrink-0 whitespace-nowrap border-b-2 px-3.5 text-[16px] transition-colors duration-150 ${
                on ? 'border-ink font-semibold text-ink' : 'border-transparent text-ink-soft hover:text-ink'
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {tabs.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`${base}-panel-${t.id}`}
          aria-labelledby={`${base}-tab-${t.id}`}
          hidden={t.id !== active}
          className="pt-5"
        >
          {t.content}
        </div>
      ))}
    </div>
  );
}
