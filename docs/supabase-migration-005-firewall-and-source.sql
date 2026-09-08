-- ============================================================================
-- Migration 005 — restore the firewall structurally, and tag audit provenance
--
-- Run as `postgres` AFTER 004. Idempotent; purely additive except two REVOKEs.
--
-- TWO CHANGES, both from the 2026-09-07 cross-thread review.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. THE FIREWALL GAP — corpus verdicts became reachable from receipts_app
--
-- The original guarantee was directional: the trust index must never read a
-- user's query. Migration 002 enforced that by revoking receipts_trust on the
-- `app` schema, and that half still holds.
--
-- The OTHER half was only ever enforced in code. The query tool is a FRESH
-- evaluation: it must not look up a pre-computed verdict from
-- `Promise Alignment - Matches` or `Decision Scores` and present it as its own
-- reasoning. Nothing structural stopped it, because receipts_app holds SELECT
-- on all of `mirror`.
--
-- That was tolerable while the mirror was empty. It no longer is: the sync now
-- populates mirror_promise_alignment_matches and mirror_decision_scores, so
-- corpus verdicts are one JOIN away from the request path, and the only thing
-- preventing that JOIN is that nobody has written it yet.
--
-- Fix: receipts_app loses SELECT on exactly those two tables. It needs the
-- mirror for ENRICHMENT — donor alignment, party whip position, impact
-- statements, roll call results — and none of that lives here. A query that
-- reaches for a stored verdict now fails on privilege rather than succeeding
-- quietly, which is the same standard the other direction already meets.
-- ---------------------------------------------------------------------------
-- Guarded: the mirror sync is parked at 5 tables, so these two may not exist
-- yet. A missing table here is not a problem — there is nothing to revoke — but
-- an unguarded REVOKE would abort the whole migration.
do $firewall$
begin
  if to_regclass('mirror.mirror_promise_alignment_matches') is not null then
    execute 'revoke select on mirror.mirror_promise_alignment_matches from receipts_app';
    execute $c$comment on table mirror.mirror_promise_alignment_matches is
      'Corpus verdicts. receipts_app is REVOKED here by design (migration 005): the query tool evaluates fresh and must never read a pre-computed verdict back as its own finding. receipts_trust keeps SELECT - this is its table.'$c$;
  else
    raise notice 'mirror.mirror_promise_alignment_matches does not exist yet — nothing to revoke. Re-run 005 after the sync creates it.';
  end if;

  if to_regclass('mirror.mirror_decision_scores') is not null then
    execute 'revoke select on mirror.mirror_decision_scores from receipts_app';
    execute $c$comment on table mirror.mirror_decision_scores is
      'Corpus decision scores. receipts_app is REVOKED here by design (migration 005) for the same reason as mirror_promise_alignment_matches.'$c$;
  else
    raise notice 'mirror.mirror_decision_scores does not exist yet — nothing to revoke. Re-run 005 after the sync creates it.';
  end if;
end
$firewall$;

-- Future tables in `mirror` still default to SELECT for receipts_app (set in
-- 002); these two are the deliberate exceptions and are re-revoked here so a
-- re-run of 002's grants does not silently reopen them.



-- ---------------------------------------------------------------------------
-- 2. AUDIT PROVENANCE — a source discriminator
--
-- Requested in cross-thread review: if query-tool audit rows are ever UNIONed
-- with WF13's `Verdict Audit Log` sheet, nothing currently distinguishes them.
-- A pipeline row and a user-query row look identical, and they are not
-- comparable evidence — one has a gold row behind it, the other never can.
--
-- Defaulted rather than nullable: an untagged row is exactly the ambiguity this
-- prevents, so there is no way to write one.
-- ---------------------------------------------------------------------------
alter table app.app_verdict_audit_log
  add column if not exists source text not null default 'QUERY_TOOL';

alter table app.app_verdict_audit_log
  drop constraint if exists app_verdict_audit_source_chk;
alter table app.app_verdict_audit_log
  add constraint app_verdict_audit_source_chk
  check (source in ('QUERY_TOOL', 'PIPELINE_WF13'));

comment on column app.app_verdict_audit_log.source is
  'QUERY_TOOL | PIPELINE_WF13. Query-tool rows have no gold row to join, so '
  'gold_agreement is always NO_GOLD for them - reading a query row as a pipeline '
  'row would misreport agreement as absent rather than inapplicable.';

create index if not exists idx_aval_source on app.app_verdict_audit_log (source);

-- The view carries it through, so nobody reads a trace without knowing which
-- product produced it.
--
-- DROP then CREATE, not CREATE OR REPLACE: adding `source` in position 2 shifts
-- every later column, and Postgres reads a positional shift as RENAMING column 2
-- (42P16). Dropping is safe — a view holds no data — but it also drops the
-- grants, so they are re-applied below.
drop view if exists app.v_verdict_trace;

create view app.v_verdict_trace as
  select q.created_at            as query_at,
         l.source,
         q.politician_id,
         left(q.promise_text, 80) as statement,
         q.verdict               as final_verdict,
         l.seq,
         l.stage,
         l.rule,
         l.disposition,
         l.verdict_before,
         l.verdict_after,
         l.reason,
         l.senator_counterargument
  from app.app_queries q
  join app.app_verdict_audit_log l on l.query_id = q.id
  order by q.created_at desc, l.seq;

-- Re-applied after the drop above.
grant select on app.v_verdict_trace to receipts_app;
revoke all on app.v_verdict_trace from receipts_trust, receipts_sync;


-- ---------------------------------------------------------------------------
-- 3. VERIFY
-- ---------------------------------------------------------------------------

-- Expect receipts_app ABSENT for both corpus tables, receipts_trust present.
select table_name, grantee
from information_schema.table_privileges
where table_schema = 'mirror'
  and table_name in ('mirror_promise_alignment_matches', 'mirror_decision_scores')
  and privilege_type = 'SELECT'
order by table_name, grantee;

-- Expect receipts_app still reading the enrichment tables it legitimately needs.
select table_name, grantee
from information_schema.table_privileges
where table_schema = 'mirror'
  and grantee = 'receipts_app'
  and privilege_type = 'SELECT'
order by table_name;
