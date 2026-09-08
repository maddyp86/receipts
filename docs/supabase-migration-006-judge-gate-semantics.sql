-- ============================================================================
-- Migration 006 — align the judge gate with WF11's live semantics
--
-- Run as `postgres` AFTER 005. Idempotent; replaces one view.
--
-- WF11 gained a `Drop Unjudged Rows` node on 2026-09-07T17:43. Reading it
-- showed migration 004's `v_alignments_awaiting_judgement` diverges from the
-- pipeline in two ways — one of which made the view useless.
--
-- WF11's rule, verbatim from the node:
--     const BLOCKED = new Set(['PENDING', 'REVIEW_REQUIRED']);
--     ...
--     // Blank Grade passes. Rows written before WF13 existed, and WF10a rows
--     // that were never accusations, legitimately carry no grade.
--
-- 1. NULL GRADE PASSES — 004 had it backwards.
--    The judge only ever runs on BROKE/INCONSISTENT. Every KEPT, every
--    NOT_DETERMINABLE, every gated row is legitimately ungraded. Treating null
--    as "awaiting judgement" put essentially every row in the view, which makes
--    a review queue that nobody can use — the failure mode of a check that
--    fires on everything is the same as one that never fires.
--
-- 2. JUDGE_ERROR STAYS BLOCKED HERE — a deliberate divergence, not a drift.
--    WF11 does not list it, because handoff v2 §5 has an errored judge leave
--    the row at PENDING, which WF11 blocks anyway. The query tool has no WF11
--    and no requeue: it renders once, now. So an infrastructure failure must
--    withhold rather than fall through, and JUDGE_ERROR is blocking here on
--    purpose. Same reasoning the other thread applied on the code side.
--
-- Not adopted: WF11 DROPS blocked rows so a later run picks them up via the
-- anti-join, and freezing would write a null-score row that blocks the real
-- score forever. The query tool has no later run — nothing to requeue into —
-- so it withholds in place instead.
-- ============================================================================

create or replace view app.v_alignments_awaiting_judgement as
  select a.*,
         q.created_at   as query_created_at,
         q.promise_text
  from app.app_query_alignments a
  join app.app_queries q on q.id = a.query_id
  where a.grade in ('PENDING', 'REVIEW_REQUIRED', 'JUDGE_ERROR');

comment on view app.v_alignments_awaiting_judgement is
  'Alignments no judge has cleared, matching WF11 Drop Unjudged Rows plus '
  'JUDGE_ERROR. A NULL grade is NOT here: the judge only runs on accusations, so '
  'every KEPT and every gated row is legitimately ungraded, and including them '
  'would put the whole table in a review queue. JUDGE_ERROR blocks here though '
  'it does not in WF11 - the query tool renders once and cannot requeue, so an '
  'infrastructure failure has to withhold rather than fall through.';

grant select on app.v_alignments_awaiting_judgement to receipts_app;
revoke all on app.v_alignments_awaiting_judgement from receipts_trust, receipts_sync;


-- A companion the pipeline has no need for: what actually reached the reader.
-- An accusation shown to a user with no PASS behind it is the thing this whole
-- layer exists to prevent, so it is queryable rather than inferred.
create or replace view app.v_accusations_rendered as
  select q.created_at,
         q.politician_id,
         left(q.promise_text, 80) as statement,
         a.action_uid,
         a.promise_alignment,
         a.alignment_confidence,
         a.grade,
         a.vote_governing,
         a.vote_flags
  from app.app_query_alignments a
  join app.app_queries q on q.id = a.query_id
  where a.promise_alignment in ('BROKE', 'INCONSISTENT')
    and (a.grade is null or a.grade not in ('PASS', 'PASS_ON_RETRY',
                                            'REVIEW_REQUIRED_JUDGE_CORRECTED'))
  order by q.created_at desc;

comment on view app.v_accusations_rendered is
  'Accusations that were stored without a passing judge grade. Should be empty '
  'once the judge is wired. Non-empty means the tool published a BROKE that no '
  'second opinion cleared - the failure the judge layer exists to prevent, and '
  'the one worth alerting on.';

grant select on app.v_accusations_rendered to receipts_app;
revoke all on app.v_accusations_rendered from receipts_trust, receipts_sync;


-- ---------------------------------------------------------------------------
-- VERIFY — both views exist and are readable only by receipts_app.
-- ---------------------------------------------------------------------------
select table_name, grantee, privilege_type
from information_schema.table_privileges
where table_schema = 'app'
  and table_name in ('v_alignments_awaiting_judgement', 'v_accusations_rendered')
order by table_name, grantee;
