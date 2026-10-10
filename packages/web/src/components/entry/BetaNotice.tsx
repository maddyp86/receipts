import { ChevronDownIcon } from 'lucide-react';
import { SCOPE_NOTE } from '@receipts/shared';

// ===========================================================================
// The beta scope note, on the entry page above the picker.
//
// The wording is the approved SCOPE_NOTE from shared, unchanged. It sits in a
// native <details>: one line by default, the full note one tap away, and the
// full text is in the page either way (it is not fetched or built on open).
//
// It points at the "Something look wrong?" control, so the full note shows
// only where that control exists.
// ===========================================================================

export function BetaNotice({ full }: { full: boolean }) {
  if (!full) {
    return (
      <p className="mt-5 text-[15px] leading-relaxed text-ink-soft">
        Beta · Senate record since January 2023 · Answers can miss bills or be wrong.
      </p>
    );
  }

  return (
    <details className="group mt-5">
      <summary className="cursor-pointer list-none text-[15px] leading-relaxed text-ink-soft [&::-webkit-details-marker]:hidden">
        Beta · Senate record since January 2023 · Answers can miss bills or be wrong.{' '}
        <span className="inline-flex min-h-[44px] items-center gap-1 font-medium text-focus underline underline-offset-4">
          About this beta
          <ChevronDownIcon
            className="h-4 w-4 transition-transform duration-200 group-open:rotate-180"
            aria-hidden="true"
          />
        </span>
      </summary>
      <aside
        aria-label="About this beta"
        className="mt-2 space-y-3 rounded-card border border-rule bg-card p-5 text-[16px] leading-relaxed text-ink-soft"
      >
        {SCOPE_NOTE.map((p) => (
          <p key={p}>{p}</p>
        ))}
      </aside>
    </details>
  );
}
