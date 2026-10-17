-- ============================================================================
-- Migration 017 — mark members who have left office
--
-- Run as `postgres`, AFTER 016, and BEFORE the members workflow that writes
-- left_at is published (it names the column). Idempotent. Purely additive: one
-- nullable column on core.members. No existing row changes and nothing the
-- query tool reads changes shape.
--
-- WHY. core.members held only who is serving now, so a member who left kept a
-- stale term_end and nothing said they were gone. Two senators who left during
-- the 119th Congress (Graham G000359, Mullin M001190) are still rows, but with
-- no LIS id: the Politicians tab had none, and the Phase 2 fill (ingest run 9)
-- read legislators-current, where they no longer are. member_bill_actions joins
-- votes to members on lis_id, so their 410 Senate positions join to no one.
--
-- The members workflow now also reads legislators-historical. For a member in
-- core.members whose last term ended inside the record, it sets left_at and
-- term_end from that file and fills a blank LIS id. A member back in
-- legislators-current gets left_at cleared. NULL means serving.
-- ============================================================================

ALTER TABLE core.members ADD COLUMN IF NOT EXISTS left_at date;

COMMENT ON COLUMN core.members.left_at IS
  'Day the member''s last term ended early or ran out, from congress-legislators legislators-historical. NULL: in legislators-current, i.e. serving. Set by the v2 members workflow.';
