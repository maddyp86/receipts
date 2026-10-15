-- ============================================================================
-- Migration 018 — readers fund a member's record, and free requests are kept
--
-- Run in the Supabase SQL editor as `postgres`, AFTER 017. Idempotent. Purely
-- additive: two new tables in `app`. Nothing in `core` or `compat` changes,
-- and nothing the query tool reads changes shape.
--
-- WHY. Adding a member costs real money (Ossoff ~$12.90, Collins ~$18.77, mostly
-- impact statements). To test whether readers want a member enough to pay for
-- it, a reader can pay once to have a not-yet-checked senator added. The
-- record then goes live for EVERYONE; the payment buys the work, never a
-- finding. Same pipeline, same hand review.
--
-- A payment does NOT add the member. The webhook writes a row here and nothing
-- else; an operator runs the Phase 4 steps as before (plan.md, "Funded
-- members"). A row not live by refund_due_at is refunded in the Stripe
-- dashboard and marked 'refunded'.
--
-- app.member_requests replaces the local .data/queue.log as the free demand
-- signal ("a reader asked about a member we have not checked"). The log file
-- was lost on every Render deploy.
--
-- GRANTS. receipts_app may INSERT both tables. On member_funding it may SELECT
-- only the columns the "Funded — live by …" label needs; never email or the
-- credit name. On requests it has no SELECT at all. Both are for a person to
-- read, as postgres.
--
-- AFTER RUNNING: set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and
-- ENABLE_FUNDING=true on the server (see .env.example).
--
-- Review, as postgres:
--
--   -- paid, by member, with how long is left
--   select member_id, status, amount_cents, display_name, paid_at, refund_due_at
--     from app.member_funding order by paid_at desc;
--
--   -- free requests vs paid, per member
--   select r.member_id, count(*) as requests,
--          (select count(*) from app.member_funding s where s.member_id = r.member_id) as paid
--     from app.member_requests r group by r.member_id order by requests desc;
--
--   -- owed a refund
--   select * from app.member_funding
--    where status in ('paid', 'processing') and refund_due_at < now();
-- ============================================================================

begin;

create table if not exists app.member_funding (
  id                 bigint generated always as identity primary key,
  member_id          text not null references core.members (member_id),
  stripe_session_id  text not null unique,
  amount_cents       integer not null check (amount_cents > 0),
  currency           text not null,
  email              text,
  -- Opt-in: the name the payer asked to be credited with, if any.
  display_name       text check (display_name is null or length(display_name) <= 80),
  status             text not null default 'paid'
                       check (status in ('paid', 'processing', 'live', 'refunded')),
  paid_at            timestamptz not null default now(),
  refund_due_at      timestamptz not null,
  live_at            timestamptz,
  refunded_at        timestamptz
);

create index if not exists member_funding_member_idx on app.member_funding (member_id);

comment on table app.member_funding is
  'One row per paid Stripe Checkout session funding a member''s record. Written by the webhook; status moved by an operator. Migration 018.';

create table if not exists app.member_requests (
  id            bigint generated always as identity primary key,
  member_id     text not null,
  member_name   text not null,
  promise_text  text not null check (length(promise_text) <= 2000),
  requested_at  timestamptz not null default now()
);

create index if not exists member_requests_member_idx on app.member_requests (member_id);

comment on table app.member_requests is
  'A reader asked about a member who is not live. Free demand signal; replaces .data/queue.log. Migration 018.';

-- receipts_app: insert both; read only the non-personal columns of member_funding.
grant insert on app.member_funding to receipts_app;
grant select (member_id, stripe_session_id, status, paid_at, refund_due_at) on app.member_funding to receipts_app;
revoke update, delete on app.member_funding from receipts_app;

grant insert on app.member_requests to receipts_app;
revoke select, update, delete on app.member_requests from receipts_app;

alter table app.member_funding enable row level security;
alter table app.member_requests enable row level security;

drop policy if exists member_funding_app_insert on app.member_funding;
create policy member_funding_app_insert on app.member_funding
  for insert to receipts_app with check (true);
drop policy if exists member_funding_app_select on app.member_funding;
create policy member_funding_app_select on app.member_funding
  for select to receipts_app using (true);

drop policy if exists member_requests_app_insert on app.member_requests;
create policy member_requests_app_insert on app.member_requests
  for insert to receipts_app with check (true);

commit;

-- Verify. Expect receipts_app: INSERT on both, SELECT on five member_funding columns only.
select table_name, privilege_type
  from information_schema.role_table_grants
 where grantee = 'receipts_app' and table_schema = 'app'
   and table_name in ('member_funding', 'member_requests')
 order by 1, 2;

select column_name
  from information_schema.column_privileges
 where grantee = 'receipts_app' and table_schema = 'app'
   and table_name = 'member_funding' and privilege_type = 'SELECT'
 order by 1;
