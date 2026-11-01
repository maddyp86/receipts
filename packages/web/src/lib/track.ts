import { CLIENT_FUNNEL_EVENTS, type FunnelEvent, type FunnelProps } from '@receipts/shared';
import { apiUrl } from './api.js';
import { sessionId } from './session.js';

// ===========================================================================
// Funnel counts: which steps of a first visit happened, never what was asked.
//
// Fire-and-forget. A count that fails to send is a lost count, not an error
// the reader should see, so nothing here throws or awaits. `keepalive` lets
// the request finish when the page is navigating away; it is a plain fetch,
// not sendBeacon, because a JSON beacon is refused cross-origin and the API
// can be on another origin (VITE_API_BASE).
//
// With no session id (storage blocked) nothing is sent: an event that cannot
// be tied to the rest of its visit cannot be part of a funnel.
// ===========================================================================

export function track(event: FunnelEvent, props: FunnelProps = {}): void {
  if (!CLIENT_FUNNEL_EVENTS.includes(event)) return;
  const session = sessionId();
  if (!session) return;
  try {
    void fetch(apiUrl('/api/event'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session, event, props }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* No fetch, or it threw synchronously: the count is lost, nothing else. */
  }
}
