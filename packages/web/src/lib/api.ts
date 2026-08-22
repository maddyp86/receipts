// ===========================================================================
// Where the API lives.
//
// Default is EMPTY, meaning same-origin `/api/...`. That is correct in dev
// (Vite proxies /api to the server) and correct in production IF the frontend
// host rewrites /api/* to the backend — which is the deployment shape worth
// preferring, because same-origin means no CORS surface at all.
//
// Set VITE_API_BASE at BUILD time to point at an absolute backend origin
// instead. It is a build-time value baked into the bundle, so it must never
// hold anything secret — it is a public URL and nothing more.
// ===========================================================================

const BASE = (import.meta.env?.VITE_API_BASE ?? '').replace(/\/+$/, '');

/** Build an API URL. Pass a leading-slash path: apiUrl('/api/senators'). */
export function apiUrl(path: string): string {
  return `${BASE}${path}`;
}

/** True when the frontend is talking cross-origin, so CORS must be configured. */
export const IS_CROSS_ORIGIN = BASE !== '';
