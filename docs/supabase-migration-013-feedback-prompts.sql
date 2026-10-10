-- ============================================================================
-- Migration 013 — feedback prompts: answers a reader is ASKED for
--
-- Run in the Supabase SQL editor as `postgres`, AFTER 012. Idempotent. Alters
-- one CHECK constraint on app.app_feedback; no column, grant or policy
-- changes, and no existing row is touched.
--
-- WHY. Migration 012 stores "something looks wrong", which only hears from
-- readers who go looking. Silence is unreadable: a reader who agreed and a
-- reader who left look the same. Two prompts ask every reader:
--
--   under the answer   "Did this answer what you asked?"   Yes / Partly / No
--   under each bill    "Is this bill about what you asked?" Yes / No
--
-- NEW KINDS
--   ANSWERED_YES      the answer addressed what they asked   (result)
--   ANSWERED_PARTLY   partly                                 (result)
--   ANSWERED_NO       it did not                             (result)
--   BILL_RELEVANT     this bill is about what they asked     (evidence card)
-- A bill's "No" is BILL_NOT_RELEVANT, which 012 already has.
--
-- Both prompts ask about FIT, not agreement with the verdict: agreement
-- mostly measures whether the reader likes the member.
--
-- Still insert-only for the app, still never read back by it, still no IP,
-- user agent or session id. Nothing here changes a verdict.
--
-- AFTER RUNNING: set ENABLE_FEEDBACK_PROMPTS=true on the server. Until then
-- the prompts are not shown, so the order cannot go wrong the harmful way
-- round (a prompt shown whose answer the table refuses).
--
-- Review, as postgres:
--
--   -- how many answers said yes / partly / no
--   select kind, count(*) from app.app_feedback
--    where kind like 'ANSWERED_%' group by kind order by kind;
--
--   -- share of bills readers called relevant, per answer
--   select run_id,
--          count(*) filter (where kind = 'BILL_RELEVANT')     as relevant,
--          count(*) filter (where kind = 'BILL_NOT_RELEVANT') as not_relevant
--     from app.app_feedback where level = 'evidence'
--    group by run_id order by max(created_at) desc;
-- ============================================================================

begin;

do $$
declare
  c record;
begin
  -- 012 declared the kind check inline, so Postgres named it. Find it by what
  -- it constrains rather than by a guessed name.
  for c in
    select con.conname
      from pg_constraint con
      join pg_class cls on cls.oid = con.conrelid
      join pg_namespace n on n.oid = cls.relnamespace
     where n.nspname = 'app' and cls.relname = 'app_feedback'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) ilike '%kind%'
       and pg_get_constraintdef(con.oid) ilike '%QUESTION_MISREAD%'
  loop
    execute format('alter table app.app_feedback drop constraint %I', c.conname);
  end loop;
end
$$;

alter table app.app_feedback
  add constraint app_feedback_kind_check check (kind in (
    'QUESTION_MISREAD', 'VERDICT_WRONG', 'BILL_NOT_RELEVANT', 'BILL_READ_BACKWARDS',
    'ANSWERED_YES', 'ANSWERED_PARTLY', 'ANSWERED_NO', 'BILL_RELEVANT'
  ));

commit;


-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------

-- Expect exactly 1 row, naming all eight kinds.
select con.conname, pg_get_constraintdef(con.oid) as definition
  from pg_constraint con
  join pg_class cls on cls.oid = con.conrelid
  join pg_namespace n on n.oid = cls.relnamespace
 where n.nspname = 'app' and cls.relname = 'app_feedback'
   and con.contype = 'c' and pg_get_constraintdef(con.oid) ilike '%QUESTION_MISREAD%';

-- Expect receipts_app with INSERT only — unchanged from 012.
select grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
  from information_schema.role_table_grants
 where table_schema = 'app' and table_name = 'app_feedback'
 group by grantee order by grantee;
