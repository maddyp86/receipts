-- ============================================================================
-- Migration 011 — the global daily query count, for the spend cap
--
-- Run in the Supabase SQL editor as `postgres`, AFTER 010. Idempotent; purely
-- additive — no existing table is altered.
--
-- WHY. The per-IP limits (rateLimit.ts) bound one caller. Nothing bounds the
-- total: ten testers at their per-IP cap, or one script on rotating addresses,
-- spends without limit. The global cap is a circuit breaker on the bill — N
-- paid requests per UTC day across everyone, then a clear "come back
-- tomorrow".
--
-- WHY A TABLE AND NOT A COUNTER IN MEMORY. Render's free tier sleeps an idle
-- service and restarts it on the next request, and every deploy restarts it.
-- An in-memory count resets each time, so the cap would bound spend per
-- process lifetime, not per day. One row per day, incremented atomically
-- (`insert … on conflict … do update … returning`), survives restarts and
-- would survive a second instance.
--
-- The server falls back to an in-memory count if this table is missing or
-- unreachable — the cap degrades to per-process rather than disappearing —
-- and says so in its log.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. THE COUNT — one row per UTC day
-- ---------------------------------------------------------------------------
create table if not exists app.app_usage_daily (
  day        date primary key,
  queries    integer not null default 0,
  updated_at timestamptz not null default now()
);

comment on table app.app_usage_daily is
  'Paid requests (/api/query and /api/followup) admitted past the per-IP limits, '
  'per UTC day. Read and incremented by the global daily cap. Holds no user data.';


-- ---------------------------------------------------------------------------
-- 2. GRANTS — the app increments; nobody else touches it
--
-- receipts_app: SELECT + INSERT + UPDATE (the upsert needs all three). No
-- DELETE: resetting the count is an operator's decision, made as postgres.
-- ---------------------------------------------------------------------------
revoke all on app.app_usage_daily from public;

grant select, insert, update on app.app_usage_daily to receipts_app;
revoke delete on app.app_usage_daily from receipts_app;

revoke all on app.app_usage_daily from receipts_trust, receipts_sync;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on app.app_usage_daily from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on app.app_usage_daily from authenticated';
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 3. RLS — enabled WITH a policy, so nothing lands in a deny-all state
-- ---------------------------------------------------------------------------
alter table app.app_usage_daily enable row level security;

drop policy if exists app_usage_daily_server on app.app_usage_daily;

create policy app_usage_daily_server on app.app_usage_daily
  for all to receipts_app using (true) with check (true);


-- ---------------------------------------------------------------------------
-- 4. VERIFY
-- ---------------------------------------------------------------------------

-- Expect 1 row, rls_enabled true, policy_count 1.
select c.relname as table_name,
       c.relrowsecurity as rls_enabled,
       (select count(*) from pg_policy p where p.polrelid = c.oid) as policy_count
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'app' and c.relname = 'app_usage_daily';

-- Expect receipts_app with INSERT, SELECT, UPDATE only.
select grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'app' and table_name = 'app_usage_daily'
group by grantee
order by grantee;
