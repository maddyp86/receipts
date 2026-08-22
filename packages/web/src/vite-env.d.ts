/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Absolute backend origin, baked in at BUILD time. Empty means same-origin
   * `/api/...` — correct in dev and correct in production when the frontend
   * host rewrites /api/* to the backend.
   *
   * PUBLIC by construction: it ends up in the shipped bundle. Never put a
   * secret here.
   */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
