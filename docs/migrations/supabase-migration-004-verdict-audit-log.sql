-- ============================================================================
-- Migration 004 — verdict audit log
--
-- Run as `postgres` AFTER 003. Idempotent; purely additive.
--
-- WHY. "This is the artefact you hand a journalist who asks how do you know"
-- (handoff v2 §5). Every step that could change a verdict writes a row here:
-- the deterministic gates, contract 3's withholding, and — if the judge is
-- wired — the judge and any retry.
--
-- The trace is the product. A verdict without a record of how it was reached is
-- an assertion; with one it is a finding. That distinction is the whole basis
-- of the tool's claim to be auditable rather than a black box.
--
-- One row per DECISION EVENT, not per query. A single query can produce several
-- (gate fired, then withheld, then judged), and collapsing them would lose the
-- order in which the reasoning actually happened.
-- ============================================================================

create table if not exists app.app_verdict_audit_log (
  id            uuid primary key default gen_random_uuid(),
  query_id      uuid not null references app.app_queries(id) on delete cascade,
  -- Null for query-level events (contract 3 acts on the whole result).
  alignment_id  uuid references app.app_query_alignments(id) on delete cascade,
  created_at    timestamptz not null default now(),

  -- Ordering within a query. Wall-clock ties on sub-millisecond steps, so the
  -- sequence is explicit rather than inferred from created_at.
  seq           integer not null,

  -- ---- what happened ----
  -- GATE | WITHHOLDING | JUDGE | RETRY | SUPPRESSED_IMPACT
  stage         text not null,
  -- The rule that fired, in its own vocabulary: 'G1_SCOPE', 'CONTRACT_3',
  -- 'T4_BILL_DIRECTION', 'PROMISE_TYPE'.
  rule          text,
  -- PASS | FAIL | WITHHELD | CORRECTED | ERROR | SKIPPED
  disposition   text not null,

  -- ---- what it did to the verdict ----
  verdict_before      text,
  verdict_after       text,
  confidence_before   numeric,
  confidence_after    numeric,
  /** NOT_EVALUATED etc. Never a value from the verdict vocabulary. */
  marker              text,

  -- ---- the reasoning, kept verbatim ----
  reason              text,
  -- A PASS is invalid without one (handoff v2 §5). Stored so the claim that a
  -- counterargument existed is checkable rather than asserted.
  senator_counterargument text,
  critique            text,

  -- ---- provenance ----
  model               text,
  prompt_version      text,
  -- Full payload for anything not modelled above. The columns are what we
  -- query; this is what we keep so a future question does not need a migration.
  detail              jsonb
);

create index if not exists idx_aval_query  on app.app_verdict_audit_log (query_id, seq);
create index if not exists idx_aval_stage  on app.app_verdict_audit_log (stage);
create index if not exists idx_aval_disp   on app.app_verdict_audit_log (disposition);
create index if not exists idx_aval_align  on app.app_verdict_audit_log (alignment_id);

comment on table app.app_verdict_audit_log is
  'One row per decision event that could change a verdict. The artefact you hand '
  'someone who asks "how do you know". Append-only by convention: a correction '
  'is a NEW row, never an edit - rewriting the trace defeats its purpose.';

comment on column app.app_verdict_audit_log.senator_counterargument is
  'The strongest reply the senator''s office could make. Contract 3 releases a '
  'sub-0.7 accusation only when this is present, so it is stored rather than '
  'assumed - the claim that a counterargument existed must be checkable.';

comment on column app.app_verdict_audit_log.disposition is
  'ERROR is never a content verdict. A judge or gate that failed to produce '
  'output logs ERROR and leaves the verdict untouched (handoff v2 §5).';


-- ---------------------------------------------------------------------------
-- A readable trace, newest query first. This is the view to open when someone
-- asks how a specific verdict was reached.
-- ---------------------------------------------------------------------------
create or replace view app.v_verdict_trace as
  select q.created_at            as query_at,
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

comment on view app.v_verdict_trace is
  'Chronological reasoning for each query, newest first. A verdict with no rows '
  'here was never audited - which is itself the finding.';


-- ---------------------------------------------------------------------------
-- GRANTS + RLS — same wall
-- ---------------------------------------------------------------------------
revoke all on app.app_verdict_audit_log from public;
grant select, insert on app.app_verdict_audit_log to receipts_app;
-- No UPDATE and no DELETE, deliberately: append-only is enforced by privilege
-- rather than trusted. A trace that can be edited is not a trace.
revoke update, delete on app.app_verdict_audit_log from receipts_app;
revoke all on app.app_verdict_audit_log from receipts_trust, receipts_sync;

grant select on app.v_verdict_trace to receipts_app;
revoke all on app.v_verdict_trace from receipts_trust, receipts_sync;

alter table app.app_verdict_audit_log enable row level security;
drop policy if exists app_verdict_audit_server on app.app_verdict_audit_log;
create policy app_verdict_audit_server on app.app_verdict_audit_log
  for all to receipts_app using (true) with check (true);


-- ---------------------------------------------------------------------------
-- VERIFY — expect receipts_app with INSERT and SELECT only, no UPDATE/DELETE.
-- ---------------------------------------------------------------------------
select grantee, string_agg(privilege_type, ', ' order by privilege_type) as privs
from information_schema.table_privileges
where table_schema = 'app' and table_name = 'app_verdict_audit_log'
group by grantee order by grantee;
