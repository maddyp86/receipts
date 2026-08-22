-- ============================================================================
-- Migration 002 — the query trace: matches, non-matches, and alignments
--
-- Run in the Supabase SQL editor as `postgres`, AFTER docs/supabase-schema.sql.
-- Idempotent: safe to re-run. Purely additive — no existing table is altered.
--
-- WHY. app_queries stored the frozen result and nothing else, so a run that
-- returned NOT_DETERMINABLE / NO_MATCHES left no way to tell whether retrieval
-- was thin or the relevance gate was too tight. The evidence existed in memory
-- and was discarded at the end of the request.
--
-- This mirrors the pipeline's two stages:
--
--   W7B   -> `Promise Matches` (54 cols) AND `Unmatched Promises` (54 cols)
--            ...becomes app_query_matches, with an `admitted` flag rather than
--            two tables. One retrieval produces one set; splitting it into two
--            tables would make "what did we retrieve" a UNION.
--
--   WF10A -> `Promise Alignment - Matches` (62 cols)
--            ...becomes app_query_alignments, for the admitted rows that went
--            through fulfillment.
--
-- SCOPE. This stores what the app ALREADY computes. Roughly a third of WF10A's
-- 62 columns are not here — donor alignment, party whip position, reversal
-- targets, stakeholder impacts — because the app does not fetch that data. Those
-- are enrichment reads the `mirror` schema exists to serve, and the mirror is
-- not synced yet. Adding empty columns for them now would suggest the data was
-- collected and found absent, which is not the same as never asked for.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. MATCHES + NON-MATCHES — one row per retrieved candidate
--
-- Every candidate retrieval returned, whether or not the evidence gate admitted
-- it. The rejected rows are the point: they are how you tell "retrieval found
-- nothing" from "retrieval found things the gate threw away", which look
-- identical from app_queries alone.
-- ---------------------------------------------------------------------------
create table if not exists app.app_query_matches (
  id                 uuid primary key default gen_random_uuid(),
  query_id           uuid not null references app.app_queries(id) on delete cascade,
  created_at         timestamptz not null default now(),

  -- ---- the candidate ----
  action_uid         text,
  bill_id            text,
  bill_title         text,
  bill_summary       text,
  bill_primary_issue text,
  bill_sub_issue     text,

  -- ---- retrieval ----
  similarity_score   numeric,
  match_strength     text,          -- STRONG | WEAK  (SIMILARITY floors)
  match_rank         integer,
  match_direction    text,

  -- ---- the senator's action on this bill ----
  vote               text,
  cloture_vote       text,
  passage_vote       text,
  is_sponsor         text,
  is_cosponsor       text,

  -- ---- the relevance evaluator's judgement (gpt-5.4-mini, W7b prompt) ----
  action_type        text,          -- VOTE | SPONSORSHIP | NONE | ERROR
  relevance_verdict  text,          -- TRUE_POSITIVE | PARTIAL | FALSE_POSITIVE | ERROR
  topic_relevant     text,          -- Yes | No | NA | ERROR
  action_relevant    text,
  effort_relevant    text,
  specificity_match  text,
  no_vote_available  boolean,
  confidence         numeric,
  composite_score    numeric,
  evaluation_status  text,
  terminal_status    text,
  llm_reasoning      text,

  -- ---- the evidence gate's decision ----
  -- DERIVED from the four axes above, never asked of the model.
  admitted           boolean not null,
  partial_subtype    text,          -- NA | AMBIGUOUS | DIRECTIONAL | SPECIFICITY | UNCLASSIFIED
  -- Why it was dropped, in the gate's own vocabulary, e.g. 'PARTIAL/DIRECTIONAL'
  -- or 'FALSE_POSITIVE'. Null when admitted.
  exclusion_reason   text
);

create index if not exists idx_aqm_query    on app.app_query_matches (query_id);
create index if not exists idx_aqm_admitted on app.app_query_matches (admitted);
create index if not exists idx_aqm_verdict  on app.app_query_matches (relevance_verdict);
create index if not exists idx_aqm_bill     on app.app_query_matches (bill_id);

comment on table app.app_query_matches is
  'One row per retrieved candidate, admitted or not. The non-matches are the '
  'point: without them, "retrieval found nothing" and "the gate rejected '
  'everything" are indistinguishable.';


-- ---------------------------------------------------------------------------
-- 2. ALIGNMENTS — one row per admitted match that went through fulfillment
--
-- The KEPT/BROKE half of the chain. bill_effect here is the EVALUATOR's
-- (gpt-5.4-mini on WF10A's 32,507-char prompt), not the orchestrating model's.
-- The orchestrator's own reading is stored alongside as a cross-check, which is
-- what WF10A records as Model Verdict / Model Agreed.
-- ---------------------------------------------------------------------------
create table if not exists app.app_query_alignments (
  id                      uuid primary key default gen_random_uuid(),
  query_id                uuid not null references app.app_queries(id) on delete cascade,
  match_id                uuid references app.app_query_matches(id) on delete set null,
  created_at              timestamptz not null default now(),

  action_uid              text,
  bill_id                 text,

  -- ---- fulfillment: the authoritative judgement ----
  bill_effect             text,     -- ADVANCE | HINDER | NEUTRAL | ERROR
  bill_effect_reasoning   text,
  promise_alignment       text,     -- KEPT|BROKE|CONSISTENT|INCONSISTENT|NOT_DETERMINABLE|ERROR
  alignment_confidence    numeric,
  alignment_reasoning     text,

  -- ---- cross-check: what the orchestrating model thought ----
  -- ERROR must never collapse to NEUTRAL. NEUTRAL is a finding ("this bill does
  -- not bear on the goal"); ERROR is the absence of one.
  model_bill_effect       text,
  model_agreed            boolean,

  -- ---- deterministic outputs (server-computed, never model-supplied) ----
  outcome                 text,     -- the internal AlignmentOutcome
  direction               text,     -- keeps | breaks | neutral
  evidence_type           text,     -- vote | sponsorship | procedural | associative
  action_tier             text,     -- VOTED | ABSTAIN | SPONSOR | CO_SPONSOR | NONE
  vote_pattern            text,
  weight                  numeric,
  scoring_flags           jsonb
);

create index if not exists idx_aqa_query   on app.app_query_alignments (query_id);
create index if not exists idx_aqa_match   on app.app_query_alignments (match_id);
create index if not exists idx_aqa_effect  on app.app_query_alignments (bill_effect);
create index if not exists idx_aqa_outcome on app.app_query_alignments (outcome);

comment on table app.app_query_alignments is
  'One row per admitted match that went through fulfillment. bill_effect is the '
  'evaluator''s; model_bill_effect is the orchestrating model''s cross-check. '
  'Where they disagree the evaluator governs and model_agreed is false.';


-- ---------------------------------------------------------------------------
-- 3. GRANTS — identical wall to the parent table
--
-- receipts_trust and receipts_sync get nothing. These tables hold a user's
-- query joined to bill evaluations; if the trust index could read them, the
-- firewall would have a hole shaped exactly like the thing it exists to stop.
-- ---------------------------------------------------------------------------
revoke all on app.app_query_matches    from public;
revoke all on app.app_query_alignments from public;

grant select, insert, update on app.app_query_matches    to receipts_app;
grant select, insert, update on app.app_query_alignments to receipts_app;

revoke all on app.app_query_matches    from receipts_trust, receipts_sync;
revoke all on app.app_query_alignments from receipts_trust, receipts_sync;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on app.app_query_matches, app.app_query_alignments from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on app.app_query_matches, app.app_query_alignments from authenticated';
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 4. RLS — enabled WITH a policy, so nothing lands in a deny-all state
-- ---------------------------------------------------------------------------
alter table app.app_query_matches    enable row level security;
alter table app.app_query_alignments enable row level security;

drop policy if exists app_query_matches_server    on app.app_query_matches;
drop policy if exists app_query_alignments_server on app.app_query_alignments;

create policy app_query_matches_server on app.app_query_matches
  for all to receipts_app using (true) with check (true);
create policy app_query_alignments_server on app.app_query_alignments
  for all to receipts_app using (true) with check (true);


-- ---------------------------------------------------------------------------
-- 5. VERIFY
-- ---------------------------------------------------------------------------

-- Expect 2 rows, rls_enabled true, policy_count 1 each.
select c.relname as table_name,
       c.relrowsecurity as rls_enabled,
       (select count(*) from pg_policy p where p.polrelid = c.oid) as policy_count
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'app'
  and c.relname in ('app_query_matches', 'app_query_alignments')
order by c.relname;

-- Expect exactly one grantee on each: receipts_app.
select table_name, grantee, string_agg(privilege_type, ', ' order by privilege_type) as privs
from information_schema.table_privileges
where table_schema = 'app'
  and table_name in ('app_query_matches', 'app_query_alignments')
group by table_name, grantee
order by table_name, grantee;
