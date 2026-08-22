import { useCallback, useRef, useState } from 'react';
import type {
  Interpretation,
  QueryResult,
  Senator,
  StepEvent,
  StepId,
  StreamEvent,
  ToolError,
} from '@receipts/shared';
import type { Corrections } from '@receipts/shared';
import { apiUrl } from './api.js';

// ===========================================================================
// The query stream.
//
// Steps are rendered as they resolve rather than buffered — the visible
// reasoning is the traceability, so a progress bar that hides it would be worse
// than no progress indicator at all.
// ===========================================================================

export type Phase = 'idle' | 'streaming' | 'done';

export interface StreamState {
  phase: Phase;
  steps: StepEvent[];
  interpretation: Interpretation | null;
  result: QueryResult | null;
  uncached: { senator: Senator; queued: boolean } | null;
  error: ToolError | null;
}

const EMPTY: StreamState = {
  phase: 'idle',
  steps: [],
  interpretation: null,
  result: null,
  uncached: null,
  error: null,
};

export function useReceiptStream() {
  const [state, setState] = useState<StreamState>(EMPTY);
  const sourceRef = useRef<EventSource | null>(null);

  const close = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  const reset = useCallback(() => {
    close();
    setState(EMPTY);
  }, [close]);

  const run = useCallback(
    (politicianId: string, promise: string, corrections?: Corrections) => {
      close();
      // FULL RESET, including the previous result and interpretation.
      //
      // Load-bearing on a correction re-run: the old verdict was computed from
      // the classification the user just told us was wrong, and showing it
      // beside the corrected values — even for the moment the new query takes —
      // presents a verdict as if it belonged to those values. Clearing first is
      // what makes that impossible rather than merely unlikely.
      setState({ ...EMPTY, phase: 'streaming' });

      const query = new URLSearchParams({ senator: politicianId, promise });
      if (corrections && Object.keys(corrections).length) {
        query.set('corrections', JSON.stringify(corrections));
      }
      const url = apiUrl(`/api/query?${query.toString()}`);
      const source = new EventSource(url);
      sourceRef.current = source;

      source.onmessage = (message) => {
        let event: StreamEvent;
        try {
          event = JSON.parse(message.data) as StreamEvent;
        } catch {
          return;
        }

        setState((prev) => {
          switch (event.type) {
            case 'step': {
              // One row per step id; later events update it in place so the
              // panel reads as a sequence, not a log.
              const seen = prev.steps.findIndex((s) => s.id === event.id);
              const steps =
                seen === -1
                  ? [...prev.steps, event]
                  : prev.steps.map((s, i) => (i === seen ? event : s));
              return { ...prev, steps };
            }
            case 'interpretation':
              return { ...prev, interpretation: event.interpretation };
            case 'uncached':
              return { ...prev, uncached: { senator: event.senator, queued: event.queued } };
            case 'result':
              return { ...prev, result: event.result };
            case 'error':
              return { ...prev, error: event.error };
            case 'done':
              return { ...prev, phase: 'done' };
            default:
              return prev;
          }
        });

        if (event.type === 'done') close();
      };

      source.onerror = () => {
        setState((prev) =>
          // A drop after the result landed is just the server closing the
          // stream; only surface a connection failure that cost us an answer.
          prev.result || prev.uncached || prev.error || prev.phase === 'done'
            ? { ...prev, phase: 'done' }
            : {
                ...prev,
                phase: 'done',
                error: {
                  code: 'UPSTREAM_UNAVAILABLE',
                  message: 'The connection dropped before we finished checking.',
                  recoverable: true,
                },
              },
        );
        close();
      };
    },
    [close],
  );

  return { ...state, run, reset };
}

export const STEP_ORDER: StepId[] = [
  'interpret',
  'resolve_senator',
  'embed',
  'search',
  'score',
  'explain',
];
