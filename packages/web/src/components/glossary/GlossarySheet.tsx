import { useEffect, useRef } from 'react';
import { BookOpenIcon } from 'lucide-react';
import { glossary, type GlossaryId } from '../../data/glossary.js';

interface Props {
  termId: GlossaryId | null;
  onClose: () => void;
}

/** A bottom sheet on phones, a small dialog on wider screens. */
export function GlossarySheet({ termId, onClose }: Props) {
  const entry = glossary.find((g) => g.id === termId);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!entry) return;
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [entry, onClose]);

  if (!entry) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <div className="absolute inset-0 animate-fade-in bg-ink/30" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="glossary-title"
        className="relative w-full animate-sheet-in rounded-t-2xl bg-card px-6 pb-8 pt-4 shadow-soft sm:max-w-md sm:rounded-card sm:pt-6"
      >
        <div className="mx-auto mb-5 h-1 w-10 rounded-full bg-rule sm:hidden" aria-hidden="true" />
        <p className="flex items-center gap-2 text-[15px] text-ink-soft">
          <BookOpenIcon className="h-4 w-4" aria-hidden="true" />
          What this means
        </p>
        <h2 id="glossary-title" className="mt-2 font-serif text-[26px] leading-tight text-ink">
          {entry.term}
        </h2>
        <p className="mt-3 text-[17px] leading-relaxed text-ink">{entry.definition}</p>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="mt-6 min-h-[48px] w-full rounded-card border border-rule bg-paper text-[17px] font-medium text-ink transition-colors duration-150 hover:bg-cantsay-wash"
        >
          Got it
        </button>
      </div>
    </div>
  );
}
