// ===========================================================================
// A per-TAB session id.
//
// Its only job is to scope the server's replay cache so a cached answer can
// never cross users. It is not authentication, it carries no identity, and it
// is never sent anywhere but this app's own API.
//
// `sessionStorage`, not `localStorage`, deliberately: the id should live as
// long as the tab and no longer. A persistent id would follow someone across
// days and start to look like a tracking identifier, which is a different thing
// with different obligations — and the cache it scopes is measured in minutes
// anyway.
//
// High entropy matters. Knowing an id is what lets a caller replay that
// session's answers, which is the same posture the app already takes with share
// links (`/api/query/:id` serves a stored result to anyone holding the id). A
// guessable id would widen that; a 128-bit random one does not.
// ===========================================================================

const KEY = 'receipts.session';

/** `crypto.randomUUID` where available, falling back to `getRandomValues`. */
function mint(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  if (c?.getRandomValues) {
    const bytes = c.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  // No crypto at all. Return empty rather than something weak: the server
  // treats a missing id as "do not cache", which is the correct outcome. A
  // low-entropy id would be worse than none, because it would be USED.
  return '';
}

/**
 * The id for this tab, minted on first use.
 *
 * Returns empty when storage is unavailable — a private window, disabled site
 * data, or a context where the accessor itself throws. Every one of those means
 * "no caching", never "cache under a shared key".
 */
export function sessionId(): string {
  try {
    const existing = window.sessionStorage.getItem(KEY);
    if (existing) return existing;
    const fresh = mint();
    if (fresh) window.sessionStorage.setItem(KEY, fresh);
    return fresh;
  } catch {
    // Storage threw. Degrade to no caching rather than to a constant.
    return '';
  }
}
