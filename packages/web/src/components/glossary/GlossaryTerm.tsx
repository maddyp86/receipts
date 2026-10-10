import type { ReactNode } from 'react';
import type { GlossaryId } from '../../data/glossary.js';
import { useGlossary } from './GlossaryContext.js';

interface Props {
  id: GlossaryId;
  children: ReactNode;
  className?: string;
}

/** Inline tap-to-define term. The dotted underline signals “tap for meaning”. */
export function GlossaryTerm({ id, children, className = '' }: Props) {
  const { openTerm } = useGlossary();
  // Without a provider there is nothing to open, so do not draw a control that does nothing.
  if (!openTerm) return <span className={className}>{children}</span>;
  return (
    <button
      type="button"
      onClick={() => openTerm(id)}
      aria-haspopup="dialog"
      className={`inline cursor-help rounded-sm -my-1 py-2 text-left underline decoration-ink-faint decoration-dotted decoration-[1.5px] underline-offset-[5px] transition-colors duration-150 hover:decoration-ink ${className}`}
    >
      {children}
    </button>
  );
}
