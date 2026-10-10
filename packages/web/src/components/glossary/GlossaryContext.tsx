import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import type { GlossaryId } from '../../data/glossary.js';
import { GlossarySheet } from './GlossarySheet.js';

interface GlossaryContextValue {
  /** Null when no provider is mounted (a static render, a test): terms then render as plain text. */
  openTerm: ((id: GlossaryId) => void) | null;
}

const GlossaryContext = createContext<GlossaryContextValue>({ openTerm: null });

export function GlossaryProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<GlossaryId | null>(null);
  const openTerm = useCallback((id: GlossaryId) => setActive(id), []);
  const close = useCallback(() => setActive(null), []);

  return (
    <GlossaryContext.Provider value={{ openTerm }}>
      {children}
      <GlossarySheet termId={active} onClose={close} />
    </GlossaryContext.Provider>
  );
}

export function useGlossary(): GlossaryContextValue {
  return useContext(GlossaryContext);
}
