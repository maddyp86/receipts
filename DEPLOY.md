# Deploy

Two targets. The split is not incidental — the server is a stateful Express tool
loop that holds every secret, caches the taxonomy, and will hold a Supabase
pool. The frontend is a static bundle that holds nothing.

**Nothing here is wired.** Do not push until the GitHub remote exists and each
host's secret store is populated.

| | Target | What it is |
|---|---|---|
| `packages/web` | **Vercel** | static build (`vite build` → `dist/`) |
| `packages/server` | **Render or Railway** | persistent Node container |

---

## Before the first push

- [x] `.env.example` scrubbed — placeholders only, enforced by `config.env.test.ts`
- [x] No real Pinecone host/index, Sheets doc id, or local path in the tree
- [x] Full-history scan: no secret ever committed, no remote, nothing to rotate
- [x] **Sheets confirmed private** (Matt, 2026-08-21) — the doc ids in history
      were never link-exposed, so this is no longer a security gate.
- [ ] **Squash history before the public push** — cleanliness only now, not
      urgency. The scrubbed identifiers remain in earlier commits; a squash
      removes them and tidies the build-log commits at the same time.

---

## Frontend — Vercel

Static, ideal fit. Reads no secrets; the one build-time variable is a public URL.

**These now live in `vercel.json`, not the dashboard.** Auto-detect cannot get
this repo right: the root `package.json` has no Vite dependency (it is in
`packages/web`), so Vercel reads the framework as "Other" and defaults the
output directory to `public/`, which does not exist. The build would succeed and
serve nothing.

Committing them also means the settings move with the branch and cannot drift
away from the repo in a dashboard nobody is reading.

| Setting | Value | Where |
|---|---|---|
| Framework preset | Vite | `vercel.json` |
| Root directory | repo root (monorepo workspaces) | dashboard — leave blank |
| Build command | `npm run build` | `vercel.json` |
| Output directory | `packages/web/dist` | `vercel.json` |
| Install command | `npm ci` | `vercel.json` |

**Prerequisite, and the first thing that will stop you:** Vercel needs a GitHub
Login Connection on the account before it can link this repository. Without it,
project creation fails with *"You need to add a Login Connection to your GitHub
account first."* Add it under Vercel account settings, then link the repo.

### Env (build-time, PUBLIC — never a secret)

| Var | Value |
|---|---|
| `VITE_API_BASE` | **leave unset** — see the decision below |

Empty means same-origin `/api/...`, which is correct in dev and correct in
production under the committed `vercel.json` rewrite. Set it only if you switch
to Option B.

### How the frontend reaches the backend — DECIDED (2026-09-08): Option A

**Option A — rewrite. CHOSEN, and `vercel.json` is committed at the repo root.**
`VITE_API_BASE` must stay **UNSET** on Vercel: `lib/api.ts` defaults to an empty
base, which produces same-origin `/api/...`, and Vercel forwards those to Render
server-side.

The browser therefore never makes a cross-origin request, **so there is no CORS
surface at all** and `CORS_ORIGIN` on the backend is never consulted for normal
traffic. That is why this option is preferred, and why a placeholder value there
is harmless under this shape.

Setting `VITE_API_BASE` would silently defeat this: the bundle would call Render
directly, the requests would become cross-origin, and they would then be judged
against `CORS_ORIGIN`.

**Option B — direct cross-origin. NOT in use.** Set `VITE_API_BASE` to the
backend origin and set `CORS_ORIGIN` to the Vercel domain. Remember preview
deployments get their own `*.vercel.app` subdomains — each one you want working
must be in the allowlist. Only relevant if Option A is abandoned.

---

## Backend — Render / Railway (persistent container)

| Setting | Value |
|---|---|
| Root directory | repo root |
| Install | `npm ci` |
| Start | `npm start --workspace @receipts/server` |
| Health check | `GET /api/health` |

**Health check: `/api/health`.** Deliberately dependency-free — it returns 200
without touching Anthropic, OpenAI, Pinecone or Supabase, so a vendor blip
cannot mark the whole service unhealthy. It is a liveness probe, not a
readiness one: `ok` is always true if the process is up. The payload carries
`demo_mode` / `fixture_mode` / `store` / `embedder` as diagnostics, which is how
you spot "running, but serving fixtures because a secret is missing" without
the probe itself failing.

`start` runs `tsx src/index.ts` — TypeScript directly, no build step. `tsx` is a
**runtime dependency** for exactly this reason; a `--omit=dev` install would
otherwise leave the server unable to boot. The server binds
`API_PORT ?? PORT ?? 8787`, so the host's injected `PORT` works as-is.

### Env — every secret lives here and nowhere else

**Secrets:**

| Var | Notes |
|---|---|
| `ANTHROPIC_API_KEY` | absent → DEMO mode (stubbed interpret/explain) |
| `OPENAI_API_KEY` | absent → relevance + fulfillment legs skip and say so |
| `PINECONE_API_KEY` | absent → FIXTURE mode (canned matches) |

**Config:**

| Var | Value |
|---|---|
| `PINECONE_HOST` | real index host, no trailing slash |
| `PINECONE_NAMESPACE_TEMPLATE` | `{politician_id}_bills` |
| `PINECONE_EMBEDDING_VERSION` | **leave blank** unless pinning a run |
| `EMBEDDING_MODEL` / `EMBEDDING_DIMENSIONS` | `text-embedding-3-small` / `1024` — must match the pipeline |
| `CLASSIFY_MODEL` / `FULFILL_MODEL` / `EXPLAIN_MODEL` | `claude-haiku-4-5` / `gpt-5.4-mini` / `claude-sonnet-5` |
| `ANTHROPIC_MAX_TOKENS` | `64000` |
| `RETRIEVAL_TOP_K` | `10` |
| `CORS_ORIGIN` | the Vercel frontend origin(s), comma-separated |
| `ENABLE_CAMPAIGN_PROMISE_OVERRIDE` | `false` until copy review |

⚠️ **`CORS_ORIGIN` blank means any origin.** Every request spends money at three
vendors, so an open policy is an open invoice as much as a data question. The
startup banner warns when it is unset.

⚠️ **`PINECONE_EMBEDDING_VERSION` is the one config typo that used to lie.** A
stale pin returns zero vectors from a full namespace, which would render as "no
relevant bills". The store now fails loudly instead — but leave it blank unless
you mean it.

### Verify the deploy from the banner

```
mode: llm=live (claude-sonnet-5)  data=live (Pinecone)
models: classify=claude-haiku-4-5  fulfill=gpt-5.4-mini  explain=claude-sonnet-5
credentials: anthropic=present  openai=present  pinecone=present  pinecone_host=present
cors: allowlist [https://receipts.vercel.app]
```

`ABSENT` anywhere, or `DEMO`/`FIXTURE`, means a secret did not reach the
service — and the app will serve sample data as if it were real. Values are
never printed, only presence.

---

## If Matt wants single-platform (Vercel backend)

Viable, but **only with explicit configuration** — and it will look like a loop
bug if deployed on defaults.

The old 10s cap is gone: Fluid Compute allows up to **800s** on paid and ~**60s**
on free, and the Node runtime's `maxDuration` extends to **900s**. The query loop
runs ~10–15s, which fits comfortably — but only once configured.

**Required, both:**

1. **Fluid Compute enabled** on the project.
2. **`maxDuration` set on the query route** (~60s is ample for a 10–15s loop):

```js
export const maxDuration = 60;
```

**On default serverless settings the function hard-cuts at 5–10s.** The SSE
stream dies mid-loop, the browser sees a truncated stream, and it presents as a
bug in the tool loop rather than as a platform timeout. Never deploy the backend
to Vercel without both settings.

Two further reasons the persistent container is still preferred: serverless
rebuilds per request, so the taxonomy cache and the coming Supabase pool are
re-created on every invocation; and SSE plus per-request cold starts is a worse
fit than a process that simply stays up.
