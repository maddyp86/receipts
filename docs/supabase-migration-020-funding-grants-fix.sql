-- ============================================================================
-- Migration 020 — fix the funding grants, and make sure notified_at exists
--
-- Run in the Supabase SQL editor as `postgres`. Idempotent. Safe to run
-- whether or not 019 ran. No row changes.
--
-- WHY. Checked on 16 Oct 2026, receipts_app could SELECT every column of
-- app.member_funding, payer email included. Migration 018 granted five
-- columns, but the `app` schema's default privileges had already given the
-- role a TABLE-level SELECT, and 018 revoked only update and delete. A
-- column grant does not narrow a table grant, so the table grant won. (018 did
-- revoke select on member_requests, which is correctly insert-only.)
--
-- Revoking the table-level SELECT also drops every column grant (Postgres
-- revokes them together), so the columns the app needs are granted again
-- after it: 018's five plus 019's display_name and live_at. Never email,
-- amount, refunded_at or notified_at.
--
-- Also adds notified_at, which 019 should have added; it was missing on
-- 16 Oct, so the go-live email workflow could not run.
-- ============================================================================

begin;

alter table app.member_funding add column if not exists notified_at timestamptz;

comment on column app.member_funding.notified_at is
  'When the go-live email was sent to the payer. Set by the sender; NULL means not yet sent. Migrations 019/020.';

revoke select on app.member_funding from receipts_app;
grant select (member_id, stripe_session_id, status, paid_at, refund_due_at, display_name, live_at)
  on app.member_funding to receipts_app;

commit;

-- Verify 1. Expect member_funding: INSERT only at table level (no SELECT row);
-- member_requests: INSERT only.
select table_name, privilege_type
  from information_schema.role_table_grants
 where grantee = 'receipts_app' and table_schema = 'app'
   and table_name in ('member_funding', 'member_requests')
 order by 1, 2;

-- Verify 2. Expect exactly seven columns: display_name, live_at, member_id,
-- paid_at, refund_due_at, status, stripe_session_id.
select column_name
  from information_schema.column_privileges
 where grantee = 'receipts_app' and table_schema = 'app'
   and table_name = 'member_funding' and privilege_type = 'SELECT'
 order by 1;

-- Verify 3. Expect true.
select exists (
  select 1 from information_schema.columns
   where table_schema = 'app' and table_name = 'member_funding' and column_name = 'notified_at'
) as notified_at_exists;
