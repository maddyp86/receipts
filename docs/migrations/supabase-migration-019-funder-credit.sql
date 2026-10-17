-- ============================================================================
-- Migration 019 — credit the funder by name, and record the go-live email
--
-- Run as `postgres`, AFTER 018. Idempotent. One nullable column and two
-- column grants on app.member_funding; no row changes.
--
-- CREDIT. A payer may enter a name at checkout to be credited publicly on the
-- record ("Record funded by …"). The app now reads display_name and live_at,
-- but shows a name only on a row whose status is 'live'. The operator sets
-- that status at go-live and looks at the name then: a name not fit to
-- publish is cleared first. Email is still never readable by the app.
--
-- EMAIL. notified_at is set when the "it's live, come and check it" email has
-- been sent to the payer, so it goes once. The sender (run as postgres) sets
-- it; the app neither reads nor writes it.
--
-- Clear a name before go-live, as postgres:
--   update app.member_funding set display_name = null where id = <id>;
-- ============================================================================

begin;

alter table app.member_funding add column if not exists notified_at timestamptz;

comment on column app.member_funding.notified_at is
  'When the go-live email was sent to the payer. Set by the sender; NULL means not yet sent. Migration 019.';

grant select (display_name, live_at) on app.member_funding to receipts_app;

commit;

-- Verify. Expect seven columns: display_name, live_at, member_id, paid_at,
-- refund_due_at, status, stripe_session_id. Never email or notified_at.
select column_name
  from information_schema.column_privileges
 where grantee = 'receipts_app' and table_schema = 'app'
   and table_name = 'member_funding' and privilege_type = 'SELECT'
 order by 1;
