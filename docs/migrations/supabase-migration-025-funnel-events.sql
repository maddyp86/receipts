-- ============================================================================
-- Migration 025 — funnel events: which steps of a visit happened
--
-- Run in the Supabase SQL editor as `postgres`. Idempotent. Creates one table;
-- touches no existing row.
--
-- WHY. The landing page exists to get a first-time visitor to a first answer
-- and then to a follow-up question. Neither step leaves a trace today:
-- follow-ups are deliberately not stored, and a visit that never asks writes
-- nothing. This table counts the steps, and only the steps:
--
--   landing_view     the page was opened
--   starter_used     a one-tap starter on the landing page was used
--   query_submitted  a question was asked     (source: starter | typed, nth)
--   result_shown     an answer was shown      (outcome: verdict / label / ND_reason)
--   followup_asked   a follow-up was asked    (written by the server, not the page)
--
-- NO TEXT, BY CONSTRUCTION. `props` holds ids from closed sets, enums and
-- counts; no run id, so a count cannot be joined to the stored question
-- (DECISIONS 2026-08-22, the corpus firewall). The server drops anything else
-- (packages/server/src/data/FunnelStore.ts). No IP, no user agent. The only
-- key is the per-tab session id, which dies with the tab.
--
-- Insert-only for the app, like app_feedback (012): no SELECT, so nothing the
-- app does can read it back. Read the funnel as postgres with
-- docs/queries/activation.sql.
--
-- AFTER RUNNING: set ENABLE_FUNNEL_EVENTS=true on the server.
-- ============================================================================

create table if not exists app.app_funnel_events (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  session_key text not null check (char_length(session_key) between 32 and 36),
  event       text not null check (event in
                ('landing_view', 'starter_used', 'query_submitted', 'result_shown', 'followup_asked')),
  props       jsonb not null default '{}'::jsonb check (jsonb_typeof(props) = 'object' and pg_column_size(props) < 1024)
);

create index if not exists app_funnel_events_created_at on app.app_funnel_events (created_at);
create index if not exists app_funnel_events_session on app.app_funnel_events (session_key);

comment on table app.app_funnel_events is
  'Anonymous funnel step counts (landed, asked, saw an answer, asked a follow-up). '
  'No question text, IP or user agent. Insert-only for the app.';

-- ---------------------------------------------------------------------------
-- GRANTS — insert only. An identity column needs no sequence grant.
-- ---------------------------------------------------------------------------
revoke all on app.app_funnel_events from public;
grant insert on app.app_funnel_events to receipts_app;
revoke select, update, delete on app.app_funnel_events from receipts_app;
revoke all on app.app_funnel_events from receipts_trust, receipts_sync;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on app.app_funnel_events from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on app.app_funnel_events from authenticated';
  end if;
end $$;

-- Check:
--   select grantee, string_agg(privilege_type, ', ' order by privilege_type)
--     from information_schema.role_table_grants
--    where table_schema = 'app' and table_name = 'app_funnel_events'
--    group by grantee;
