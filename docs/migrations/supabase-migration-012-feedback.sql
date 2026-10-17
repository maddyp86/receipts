-- ============================================================================
-- Migration 012 — reader feedback: "something looks wrong"
--
-- Run in the Supabase SQL editor as `postgres`, AFTER 011. Idempotent; purely
-- additive — no existing table is altered.
--
-- WHAT. One row per piece of feedback a reader sends from a result or an
-- evidence card, saying what it is about:
--   QUESTION_MISREAD     we misread what they asked          (result)
--   VERDICT_WRONG        the verdict is wrong                 (result)
--   BILL_NOT_RELEVANT    this bill isn't relevant             (evidence card)
--   BILL_READ_BACKWARDS  this bill is read backwards          (evidence card)
-- with the trace run id it was sent from, what was on screen, and an
-- optional comment.
--
-- FEEDBACK NEVER CHANGES A VERDICT, structurally: the app role may INSERT
-- and nothing else. There is no SELECT grant, so no code path in the app can
-- read feedback back into a computation, whatever a future change attempts.
-- Review happens here, as postgres:
--
--   select created_at, kind, politician_id, promise_text, bill_id, comment, run_id
--     from app.app_feedback order by created_at desc;
--
-- NO IP ADDRESS, no user agent, no session id. The run id links to the
-- trace, which is all a review needs.
-- ============================================================================

create table if not exists app.app_feedback (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  run_id        text not null,
  kind          text not null
                check (kind in ('QUESTION_MISREAD', 'VERDICT_WRONG', 'BILL_NOT_RELEVANT', 'BILL_READ_BACKWARDS')),
  level         text not null check (level in ('result', 'evidence')),
  politician_id text not null,
  promise_text  text not null check (char_length(promise_text) <= 2000),
  verdict_shown text not null check (char_length(verdict_shown) <= 64),
  action_uid    text,
  bill_id       text,
  comment       text check (comment is null or char_length(comment) <= 1000),
  -- Card-level feedback names its bill; result-level feedback does not.
  constraint app_feedback_level_bill check (
    (level = 'evidence' and action_uid is not null and bill_id is not null)
    or (level = 'result' and action_uid is null and bill_id is null)
  )
);

create index if not exists idx_afb_created on app.app_feedback (created_at desc);
create index if not exists idx_afb_kind    on app.app_feedback (kind);

comment on table app.app_feedback is
  'Reader feedback from results and evidence cards. Insert-only for the app: '
  'never read by it, never changes a verdict. Reviewed by an operator.';


-- ---------------------------------------------------------------------------
-- GRANTS — insert only. No SELECT, UPDATE or DELETE for the app.
-- ---------------------------------------------------------------------------
revoke all on app.app_feedback from public;

grant insert on app.app_feedback to receipts_app;
revoke select, update, delete on app.app_feedback from receipts_app;

revoke all on app.app_feedback from receipts_trust, receipts_sync;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on app.app_feedback from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on app.app_feedback from authenticated';
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- RLS — enabled WITH an insert policy, so nothing lands in a deny-all state
-- ---------------------------------------------------------------------------
alter table app.app_feedback enable row level security;

drop policy if exists app_feedback_insert on app.app_feedback;

create policy app_feedback_insert on app.app_feedback
  for insert to receipts_app with check (true);


-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------

-- Expect 1 row, rls_enabled true, policy_count 1.
select c.relname as table_name,
       c.relrowsecurity as rls_enabled,
       (select count(*) from pg_policy p where p.polrelid = c.oid) as policy_count
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'app' and c.relname = 'app_feedback';

-- Expect receipts_app with INSERT only.
select grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'app' and table_name = 'app_feedback'
group by grantee
order by grantee;
