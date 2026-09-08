-- ============================================================================
-- Migration 003 — v7 field set: scope, gates, disclosure, grade
--
-- Run as `postgres` AFTER migration 002. Idempotent; purely additive.
--
-- WHY NOW. PR #2 ported the WF10a v7 fixes into the app: statement scope
-- classification, pre-evaluator gates, the symmetric split-vote rule, and the
-- disclosure fields. The application computes all of it. `SupabaseQueryStore`
-- writes an explicit column list that predates it, so every one of those values
-- is currently DROPPED on write — silently, because an unlisted field is not an
-- error. This migration is the database half of that catch-up.
--
-- Field list from handoff v2 §2 and §4, cross-checked against the live WF10A
-- `Promise Alignment - Matches` node (74 columns as of 2026-09-07T23:11, up
-- from the 62 the original port was built against).
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. STATEMENT SCOPE — on app_queries
--
-- The pipeline stores these per statement on `Evaluable Statements`. The query
-- tool has no statements table: the user's typed text IS the statement, and it
-- is classified live per request. So they belong on the query row.
--
-- handoff v2 §1: model tag is 'claude-haiku-4-5 / scope-classifier-v1.1'. It is
-- stored per row rather than assumed, because a reclassification under a later
-- prompt must be distinguishable from an original.
-- ---------------------------------------------------------------------------
alter table app.app_queries add column if not exists speech_act       text;
alter table app.app_queries add column if not exists scope            text;
alter table app.app_queries add column if not exists valid_until      text;
alter table app.app_queries add column if not exists anchor_entity    text;
alter table app.app_queries add column if not exists role_condition   text;
alter table app.app_queries add column if not exists scope_confidence numeric;
alter table app.app_queries add column if not exists scope_reasoning  text;
alter table app.app_queries add column if not exists scope_model      text;

comment on column app.app_queries.valid_until is
  'Window close for a BOUNDED statement, or the literal UNKNOWN. Text, not date: '
  'UNKNOWN is a real value the classifier returns and a date column cannot hold it.';

comment on column app.app_queries.speech_act is
  'COMMITMENT | POSITION | OPERATIONAL | CREDIT_CLAIM | RHETORIC. The last three '
  'halt before retrieval (handoff v2 §1) and are excluded from any omission '
  'denominator (§7) - a scheduling remark cannot be broken by inaction.';

create index if not exists idx_aq_speech_act on app.app_queries (speech_act);
create index if not exists idx_aq_scope      on app.app_queries (scope);


-- ---------------------------------------------------------------------------
-- 2. THE v7 COLUMNS — on app_query_alignments
-- ---------------------------------------------------------------------------
alter table app.app_query_alignments add column if not exists grade           text;
alter table app.app_query_alignments add column if not exists vote_governing  text;
alter table app.app_query_alignments add column if not exists vote_flags      text;
alter table app.app_query_alignments add column if not exists promise_date    text;
alter table app.app_query_alignments add column if not exists gate_hits       text;
alter table app.app_query_alignments add column if not exists senator_role    text;
alter table app.app_query_alignments add column if not exists cloture_result  text;
alter table app.app_query_alignments add column if not exists scope           text;
alter table app.app_query_alignments add column if not exists valid_until     text;
alter table app.app_query_alignments add column if not exists anchor_entity   text;
alter table app.app_query_alignments add column if not exists role_condition  text;
alter table app.app_query_alignments add column if not exists bill_class      text;

-- The model's own promise_alignment. NEVER the verdict (behavioural contract 1)
-- - kept only for agreement tracking, alongside model_bill_effect from 002.
alter table app.app_query_alignments add column if not exists model_verdict   text;

comment on column app.app_query_alignments.vote_governing is
  'Which vote decided the outcome, in words. A DISCLOSURE field: a row reading '
  '"voted NAY -> BROKE" while hiding a cloture YEA is the claim a senator''s '
  'office knocks down. Anything rendering the outcome must render this beside it.';

comment on column app.app_query_alignments.vote_flags is
  'Semicolon-joined: SPLIT_VOTE, FLOOR_LEADER. Pipeline writes '';''-joined text, '
  'so this mirrors that rather than using an array - one wire format, not two.';

comment on column app.app_query_alignments.model_verdict is
  'The evaluator model''s promise_alignment. Behavioural contract 1: this is '
  'NEVER the verdict. deriveAlignment decides; this exists for agreement '
  'tracking only.';


-- ---------------------------------------------------------------------------
-- 3. THE MARKER PROBLEM — NOT_EVALUATED cannot live in a numeric column
--
-- handoff v2 §3: `Alignment Confidence` can legitimately hold the string
-- NOT_EVALUATED on a gated row, and a marker must NEVER be replaced with a
-- value from the column's own vocabulary - 0 is a value, and it asserts
-- "no confidence", which is a finding nobody made.
--
-- migration 002 declared alignment_confidence numeric. Inserting NOT_EVALUATED
-- into it does not degrade - it RAISES, which rolls back the whole
-- transaction and loses the parent query row too.
--
-- Resolved the same way the app resolved it (packages/shared DirectedAction):
-- the number stays numeric and the marker gets its own column. The two can
-- never overwrite each other, and "not evaluated" stays distinguishable from
-- "evaluated at zero confidence".
-- ---------------------------------------------------------------------------
alter table app.app_query_alignments
  add column if not exists confidence_marker text;

alter table app.app_query_alignments
  add column if not exists effect_marker text;

comment on column app.app_query_alignments.confidence_marker is
  'NOT_EVALUATED on a gated row, else null. Never write a number here and never '
  'write this into alignment_confidence: a marker replaced by a value from the '
  'column''s own vocabulary is a fabricated finding (handoff v2 §3).';

comment on column app.app_query_alignments.effect_marker is
  'NOT_EVALUATED when the row was gated before the evaluator ran. bill_effect '
  'stays null in that case - NEUTRAL would assert "the bill does not move this '
  'promise", which nobody determined.';

-- Enforce the distinction rather than trusting it. A gated row must carry the
-- marker and no number; an evaluated row must carry a number and no marker.
alter table app.app_query_alignments
  drop constraint if exists app_query_alignments_marker_chk;
alter table app.app_query_alignments
  add constraint app_query_alignments_marker_chk
  check (confidence_marker is null or alignment_confidence is null);


-- ---------------------------------------------------------------------------
-- 4. GRADE — the judge gate (handoff v2 §5)
--
-- WF11 refuses to score PENDING or REVIEW_REQUIRED. The same refusal has to
-- hold here, or the query tool prints an accusation the judge has not cleared.
--
-- Not a CHECK constraint: grade is written before judging completes, so a
-- constraint would reject the initial insert. It is a documented contract plus
-- a view that makes the unscored set visible rather than implicit.
-- ---------------------------------------------------------------------------
comment on column app.app_query_alignments.grade is
  'PENDING | PASS | PASS_ON_RETRY | REVIEW_REQUIRED | '
  'REVIEW_REQUIRED_JUDGE_CORRECTED | GATED_* | JUDGE_ERROR. '
  'PENDING and REVIEW_REQUIRED must NOT reach scoring or display as findings.';

create index if not exists idx_aqa_grade on app.app_query_alignments (grade);

create or replace view app.v_alignments_awaiting_judgement as
  select a.*, q.created_at as query_created_at, q.promise_text
  from app.app_query_alignments a
  join app.app_queries q on q.id = a.query_id
  where a.grade in ('PENDING', 'REVIEW_REQUIRED', 'JUDGE_ERROR')
     or a.grade is null;

comment on view app.v_alignments_awaiting_judgement is
  'Alignments no judge has cleared. An accusation in here has not earned the '
  'right to be shown. JUDGE_ERROR is included deliberately: an infrastructure '
  'failure is not a pass.';


-- ---------------------------------------------------------------------------
-- 5. KNOWN-BAD BILL IMPACTS (handoff v2 §8)
--
-- Six bills have inverted or wrong-text-version impact summaries. Any reading
-- built on them is unreliable until regenerated. A table rather than a constant
-- so the list is updatable without a deploy, and so a suppression is auditable
-- after the fact.
-- ---------------------------------------------------------------------------
create table if not exists app.app_suppressed_bill_impacts (
  bill_id     text primary key,
  reason      text not null,
  added_at    timestamptz not null default now(),
  resolved_at timestamptz
);

insert into app.app_suppressed_bill_impacts (bill_id, reason) values
  ('s208-118',    'inverted or wrong-text-version impact summary'),
  ('s997-118',    'inverted or wrong-text-version impact summary'),
  ('sjres71-119', 'inverted or wrong-text-version impact summary'),
  ('hr3746-118',  'inverted or wrong-text-version impact summary'),
  ('s3386-119',   'contested direction — the bill''s direction IS the partisan dispute; CONTESTED -> NOT_DETERMINABLE'),
  ('hjres104-119','inverted or wrong-text-version impact summary')
on conflict (bill_id) do nothing;

comment on table app.app_suppressed_bill_impacts is
  'Bills whose impact analysis is known unreliable. Evidence built on these must '
  'be suppressed or flagged, never shown as a clean finding. Set resolved_at '
  'when the impact is regenerated rather than deleting the row - the fact that '
  'it was once wrong is part of the audit trail.';


-- ---------------------------------------------------------------------------
-- 6. GRANTS + RLS — same wall, extended to the new objects
-- ---------------------------------------------------------------------------
revoke all on app.app_suppressed_bill_impacts from public;
grant select, insert, update on app.app_suppressed_bill_impacts to receipts_app;
revoke all on app.app_suppressed_bill_impacts from receipts_trust, receipts_sync;

grant select on app.v_alignments_awaiting_judgement to receipts_app;
revoke all on app.v_alignments_awaiting_judgement from receipts_trust, receipts_sync;

alter table app.app_suppressed_bill_impacts enable row level security;
drop policy if exists app_suppressed_server on app.app_suppressed_bill_impacts;
create policy app_suppressed_server on app.app_suppressed_bill_impacts
  for all to receipts_app using (true) with check (true);


-- ---------------------------------------------------------------------------
-- 7. VERIFY
-- ---------------------------------------------------------------------------

-- Expect 8 scope columns on app_queries.
select column_name, data_type
from information_schema.columns
where table_schema = 'app' and table_name = 'app_queries'
  and column_name in ('speech_act','scope','valid_until','anchor_entity',
                      'role_condition','scope_confidence','scope_reasoning','scope_model')
order by column_name;

-- Expect 15 new columns on app_query_alignments, and alignment_confidence
-- still numeric with confidence_marker text beside it.
select column_name, data_type
from information_schema.columns
where table_schema = 'app' and table_name = 'app_query_alignments'
  and column_name in ('grade','vote_governing','vote_flags','promise_date','gate_hits',
                      'senator_role','cloture_result','scope','valid_until','anchor_entity',
                      'role_condition','bill_class','model_verdict','confidence_marker',
                      'effect_marker','alignment_confidence')
order by column_name;

-- Expect 6 suppressed bills.
select count(*) as suppressed_bills from app.app_suppressed_bill_impacts;
