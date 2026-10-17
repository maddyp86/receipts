-- ============================================================================
-- Migration 022 — label every sponsorship and request as test or live
--
-- Run in the Supabase SQL editor as `postgres`, with nothing highlighted,
-- BEFORE merging the PR that reads these columns. Idempotent. Two columns
-- with defaults; no existing row changes meaning.
--
-- WHY. One server now takes both Stripe test and live payments: a checkout
-- started from a Vercel preview link uses the test keys, one from the
-- production site uses the live keys. Each row says which, so the production
-- site shows only real sponsorships and preview links show only test ones.
-- Test runs never need cleaning up off the live site.
--
--   app.member_funding.livemode   from Stripe's own event.livemode. Default
--                                 false: every row so far was a test-mode
--                                 payment (cs_test_), and an unlabelled row
--                                 must never show on the live site.
--   app.member_requests.livemode  free "request this record" signals. Default
--                                 true: every row so far came from the
--                                 production site.
--
-- GRANTS. receipts_app already has table-level INSERT on both tables, which
-- covers new columns. On member_funding it reads only named columns
-- (migration 020), so livemode is granted by name. Nothing else changes.
-- ============================================================================

begin;

alter table app.member_funding  add column if not exists livemode boolean not null default false;
alter table app.member_requests add column if not exists livemode boolean not null default true;

comment on column app.member_funding.livemode is
  'True for a real (Stripe live mode) payment, false for a test-mode one. The live site shows only true rows. Migration 022.';
comment on column app.member_requests.livemode is
  'False when the request came from a preview/test site. Migration 022.';

grant select (livemode) on app.member_funding to receipts_app;

commit;

-- Verify 1. Expect two rows, both boolean, NOT NULL.
select table_name, column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema = 'app' and column_name = 'livemode'
   and table_name in ('member_funding', 'member_requests')
 order by 1;

-- Verify 2. Expect eight columns now: display_name, live_at, livemode,
-- member_id, paid_at, refund_due_at, status, stripe_session_id. Never email.
select column_name
  from information_schema.column_privileges
 where grantee = 'receipts_app' and table_schema = 'app'
   and table_name = 'member_funding' and privilege_type = 'SELECT'
 order by 1;

-- Verify 3. Expect member_funding with INSERT only at table level.
select table_name, privilege_type
  from information_schema.role_table_grants
 where grantee = 'receipts_app' and table_schema = 'app'
   and table_name in ('member_funding', 'member_requests')
 order by 1, 2;
