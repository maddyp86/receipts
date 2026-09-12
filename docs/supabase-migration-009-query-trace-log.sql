-- ============================================================================
-- Migration 009 — the query trace log: every gate, in order, with raw model I/O
--
-- Run in the Supabase SQL editor as `postgres`, AFTER 008. Idempotent; purely
-- additive — no existing table is altered.
--
-- WHY. app_queries holds the frozen result. app_query_matches and
-- app_query_alignments hold the PARSED outcome of the relevance and
-- fulfillment legs. app_verdict_audit_log holds every DECISION that changed a
-- verdict. None of them holds what actually went INTO a model call and what
-- came OUT of it, in sequence, with the decision each step took — so when a
-- verdict looks wrong on screen there is no way to say which gate bent it.
--
-- These two tables hold exactly that: one run per stream, one row per step.
-- A step is a model call (raw user message in, raw text out, parse beside it,
-- model + prompt version + prompt hash + token usage), a deterministic gate
-- (its inputs, its output, the rule that fired), an I/O step (retrieval
-- counts, the candidate list, persistence outcome), or a control event
-- (request, halt, error, result, done).
--
-- KEYED BY run_id, NOT query_id. A run that halts on scope, stops on an
-- uncached senator, or errors before interpretation never writes an
-- app_queries row — and those are exactly the runs most worth tracing. So the
-- trace hangs off its own id, and query_id is a nullable pointer filled in
-- when persistence produced a row.
--
-- WHAT IT IS NOT. Not evidence about a senator, and never read on the request
-- path. Reads are by run_id only (no list, no search), the same posture as
-- share links. The verdict audit log (004) stays the journalist's artefact;
-- this is the repair artefact. They complement each other.
--
-- SIZE. Strings are truncated at 32,000 chars server-side with a marker.
-- System prompts are NOT stored — their sha256 and version tag are, and the
-- text is in the repo at that version. A live query produces ~25–60 rows.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. RUNS — one per stream
-- ---------------------------------------------------------------------------
create table if not exists app.app_query_trace_runs (
  run_id        uuid primary key,
  created_at    timestamptz not null default now(),
  started_at    timestamptz not null,
  ended_at      timestamptz,
  -- running | result | halt | uncached | error | replay
  status        text not null,
  politician_id text not null,
  promise_text  text not null,
  -- The app_queries row this run was persisted as. NULL when persistence was
  -- skipped (halt, uncached, early error, no DATABASE_URL) or failed — and
  -- the PERSIST step in the trace says which.
  query_id      uuid references app.app_queries(id) on delete set null,
  -- Mode and model tags at the time of the run: demo_mode, fixture_mode,
  -- models {classify, fulfill, explain, judge}, query_store, session_scoped.
  meta          jsonb
);

create index if not exists idx_aqtr_created    on app.app_query_trace_runs (created_at desc);
create index if not exists idx_aqtr_query      on app.app_query_trace_runs (query_id);
create index if not exists idx_aqtr_politician on app.app_query_trace_runs (politician_id);
create index if not exists idx_aqtr_status     on app.app_query_trace_runs (status);

comment on table app.app_query_trace_runs is
  'One row per query stream. Keyed by its own run_id so a run that never '
  'produced an app_queries row (halt, uncached, early error) is still traced.';


-- ---------------------------------------------------------------------------
-- 2. STEPS — one per gate the context passed through
-- ---------------------------------------------------------------------------
create table if not exists app.app_query_trace_steps (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references app.app_query_trace_runs(run_id) on delete cascade,
  -- Order within the run. Supplied by the server, not inferred from `at`:
  -- wall-clock ties on sub-millisecond steps and the sequence is the point.
  seq            integer not null,
  at             timestamptz not null,
  duration_ms    integer,

  -- ---- where and what ----
  -- REQUEST | CACHE_REPLAY | SCOPE_MODEL | SCOPE_CLASSIFY | HALT |
  -- ORCHESTRATOR_TURN | CLASSIFY_MODEL | CLASSIFY | INTERPRET |
  -- RESOLVE_SENATOR | QUEUE_SENATOR | UNCACHED | EMBED | RETRIEVE |
  -- RELEVANCE | EVIDENCE_GATE | SEARCH | ENRICHMENT | PRE_EVALUATOR_GATE |
  -- FULFILLMENT | SCORE | EVALUATE_EFFECTS | JUDGE_GATES | JUDGE_MODEL |
  -- JUDGE | EXPLAIN_CHECK | EXPLAIN | RESULT | ERROR | PERSIST | DONE
  stage          text not null,
  -- model | deterministic | io | control
  kind           text not null,
  -- ok | error | skipped | rejected
  --   rejected = a model output the code refused and sent back (an
  --   explanation draft that failed the wording checks, an unparseable
  --   evaluator response). Not an error: the run continued.
  status         text not null,
  -- The action_uid or bill_id a per-candidate step is about.
  subject        text,
  -- The one-line decision: "admitted 3 of 10", "hr1234-118 GATED by G2".
  label          text not null,

  -- ---- provenance, for model steps ----
  model          text,
  prompt_version text,
  -- sha256 of the system prompt that ran. The text is in the repo at that
  -- version; storing 32 KB per row per call is not worth it.
  prompt_sha256  text,
  -- {input_tokens, output_tokens, cached_tokens, reasoning_tokens}
  usage          jsonb,

  -- ---- the payload ----
  -- What the step was given. For a model call: the full user message. For a
  -- gate: the row and the statement metadata it tested.
  input          jsonb,
  -- What the step produced. For a model call: raw_text AND parsed, side by
  -- side, so a parse that changed the meaning is visible as a change.
  output         jsonb,
  error          text,

  unique (run_id, seq)
);

create index if not exists idx_aqts_run     on app.app_query_trace_steps (run_id, seq);
create index if not exists idx_aqts_stage   on app.app_query_trace_steps (stage);
create index if not exists idx_aqts_status  on app.app_query_trace_steps (status);
create index if not exists idx_aqts_subject on app.app_query_trace_steps (subject);

comment on table app.app_query_trace_steps is
  'One row per step of one run, in order: what it was given, what it produced, '
  'and the decision it took. Model steps carry the raw text before the parse. '
  'The repair artefact; the verdict audit log (004) is the journalist''s.';


-- ---------------------------------------------------------------------------
-- 3. THE LOG SHEET — the view to open when a result looks wrong
--
-- One line per step, newest run first. Payloads are left out so the sheet is
-- scannable; open the step row for input/output. `npm run trace -- <run_id>`
-- renders the same thing with payloads as markdown.
-- ---------------------------------------------------------------------------
create or replace view app.v_query_trace_sheet as
  select r.started_at,
         r.run_id,
         r.status              as run_status,
         r.politician_id,
         left(r.promise_text, 60) as statement,
         r.query_id,
         s.seq,
         s.stage,
         s.kind,
         s.status,
         s.subject,
         s.label,
         s.duration_ms,
         s.model,
         s.prompt_version,
         (s.usage->>'input_tokens')::int  as tokens_in,
         (s.usage->>'output_tokens')::int as tokens_out,
         s.error
  from app.app_query_trace_runs r
  join app.app_query_trace_steps s on s.run_id = r.run_id
  order by r.started_at desc, s.seq;

comment on view app.v_query_trace_sheet is
  'The log sheet: every step of every run, one line each, newest run first. '
  'Filter by run_id to read one run top to bottom.';


-- ---------------------------------------------------------------------------
-- 4. GRANTS — same wall as the rest of the app schema
--
-- receipts_app: SELECT + INSERT only. No UPDATE, no DELETE: a trace you can
-- rewrite is not a trace. receipts_trust and receipts_sync get nothing — the
-- steps hold user query text joined to bill evaluations.
-- ---------------------------------------------------------------------------
revoke all on app.app_query_trace_runs  from public;
revoke all on app.app_query_trace_steps from public;

grant select, insert on app.app_query_trace_runs  to receipts_app;
grant select, insert on app.app_query_trace_steps to receipts_app;
revoke update, delete on app.app_query_trace_runs  from receipts_app;
revoke update, delete on app.app_query_trace_steps from receipts_app;

revoke all on app.app_query_trace_runs  from receipts_trust, receipts_sync;
revoke all on app.app_query_trace_steps from receipts_trust, receipts_sync;

grant select on app.v_query_trace_sheet to receipts_app;
revoke all on app.v_query_trace_sheet from receipts_trust, receipts_sync;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on app.app_query_trace_runs, app.app_query_trace_steps, app.v_query_trace_sheet from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on app.app_query_trace_runs, app.app_query_trace_steps, app.v_query_trace_sheet from authenticated';
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 5. RLS — enabled WITH a policy, so nothing lands in a deny-all state
-- ---------------------------------------------------------------------------
alter table app.app_query_trace_runs  enable row level security;
alter table app.app_query_trace_steps enable row level security;

drop policy if exists app_query_trace_runs_server  on app.app_query_trace_runs;
drop policy if exists app_query_trace_steps_server on app.app_query_trace_steps;

create policy app_query_trace_runs_server on app.app_query_trace_runs
  for all to receipts_app using (true) with check (true);
create policy app_query_trace_steps_server on app.app_query_trace_steps
  for all to receipts_app using (true) with check (true);


-- ---------------------------------------------------------------------------
-- 6. VERIFY
-- ---------------------------------------------------------------------------

-- Expect 2 rows, rls_enabled true, policy_count 1 each.
select c.relname as table_name,
       c.relrowsecurity as rls_enabled,
       (select count(*) from pg_policy p where p.polrelid = c.oid) as policy_count
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'app'
  and c.relname in ('app_query_trace_runs', 'app_query_trace_steps')
order by c.relname;

-- Expect receipts_app with INSERT, SELECT only on both tables.
select table_name, grantee, string_agg(privilege_type, ', ' order by privilege_type) as privs
from information_schema.table_privileges
where table_schema = 'app'
  and table_name in ('app_query_trace_runs', 'app_query_trace_steps')
group by table_name, grantee
order by table_name, grantee;
