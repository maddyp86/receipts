-- ============================================================================
-- Migration 015 — schema `compat`: `core` in the exact shape of the mirror
--
-- Run as `postgres`, AFTER 014. Idempotent. Views, plus one function made
-- inlinable (see the end): no table is created, altered or written.
--
-- SOURCE: docs/v2/plan.md, Phase 2, task 2.
--
-- WHY. The query tool reads seven mirror tables by name, and reads almost
-- every field from the jsonb `row`, which holds the Sheets row verbatim. With
-- RECORD_SCHEMA=compat the tool reads these views instead, and nothing else in
-- it changes: same table names, same columns, same keys inside `row`, same
-- value formats. So the switch changes where the record comes from, not how it
-- is read.
--
-- FORMATS ARE PART OF THE CONTRACT. The readers parse what the sheet wrote:
--   - vote dates and Action Date as M/D/YYYY ('4/26/2023'), as the sheet has
--     them; Cosponsored At and the bill dates as YYYY-MM-DD
--   - booleans as JSON true/false; absent votes and dates as 'NA'
--   - Committee lists joined with '; '
-- A different but "equivalent" format would be parsed differently: new Date()
-- reads M/D/YYYY as local midnight and YYYY-MM-DD as UTC midnight.
--
-- WHAT DIFFERS FROM THE MIRROR, ON PURPOSE
--   - Votes are derived from the roll calls (core.member_bill_actions), so the
--     five sheet errors in docs/v2/reference/vote-slot-rules.md are corrected.
--   - mirror_politicians carries `Live` and `Coverage Congresses`, from
--     core.members. The picker lists a member only when `Live` is true.
--   - mirror_politician_bill_actions holds rows for in-scope members only,
--     which is what the mirror holds: the pipeline collects nobody else.
--   - synced_at is the latest finished ingest run, the moment `core` last
--     changed. The tool reads it only as a version stamp for answer reuse.
--
-- WHIP VOTES. mirror_party_vote_positions has one row per roll call and whip.
-- The enrichment reader looks the whip vote up by roll call alone, so when
-- both whips' rows come back, the last one wins. Today that is the whip with
-- the higher Politician ID (Thune over Durbin in the 118th, Durbin over
-- Barrasso in the 119th). This view is ordered by Politician ID within each
-- roll call to reproduce that exactly; fixing the reader is a separate change.
-- A whip needs an LIS id in core.members for their votes to appear here.
--
-- receipts_app and receipts_trust: SELECT only. The views are
-- security_invoker, so the caller's own grants on `core` apply.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS compat;

COMMENT ON SCHEMA compat IS
  'Views over core in the exact shape of the mirror tables the query tool reads. '
  'Read-only. Selected by RECORD_SCHEMA=compat.';


-- ---------------------------------------------------------------------------
-- mirror_politicians
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW compat.mirror_politicians
WITH (security_invoker = true) AS
SELECT m.member_id AS politician_id,
       m.full_name,
       jsonb_build_object(
         'Politician ID', m.member_id,
         'Full Name', m.full_name,
         'In Scope', m.in_scope,
         'Live', m.live,
         'Coverage Congresses', array_to_string(m.congresses, ', '),
         'Chamber', m.chamber,
         'LIS ID', coalesce(m.lis_id, ''),
         'openSecretsID', coalesce(m.opensecrets_id, ''),
         'Party', m.party,
         'State', m.state,
         'Class', coalesce(m.senate_class::text, ''),
         -- 'MINORITY_WHIP:118;MAJORITY_LEADER:119', as the Role column is
         -- written. PARTY_WHIP entries come from the Party Whips tab, not
         -- from this column, so they are left out.
         'Role', coalesce((
           SELECT string_agg((r->>'role') || ':' || (r->>'congress'), ';' ORDER BY o)
             FROM jsonb_array_elements(m.roles) WITH ORDINALITY AS x(r, o)
            WHERE r->>'role' <> 'PARTY_WHIP'), ''),
         'District', coalesce(m.district, ''),
         'Term Start', coalesce(m.term_start::text, ''),
         'Term End', coalesce(m.term_end::text, ''),
         'Website', coalesce(m.website, '')
       ) AS row,
       NULL::integer AS source_row_number,
       (SELECT max(finished_at) FROM core.ingest_runs) AS synced_at
  FROM core.members m;


-- ---------------------------------------------------------------------------
-- mirror_politician_bill_actions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW compat.mirror_politician_bill_actions
WITH (security_invoker = true) AS
WITH a AS (
  SELECT x.*,
         -- Sheet formats: M/D/YYYY for these dates, 'NA' when absent.
         CASE WHEN x.action_date IS NULL THEN 'NA' ELSE to_char(x.action_date, 'FMMM/FMDD/YYYY') END AS action_date_s,
         CASE WHEN x.cloture_vote_date IS NULL THEN 'NA' ELSE to_char(x.cloture_vote_date, 'FMMM/FMDD/YYYY') END AS cloture_date_s,
         CASE WHEN x.passage_vote_date IS NULL THEN 'NA' ELSE to_char(x.passage_vote_date, 'FMMM/FMDD/YYYY') END AS passage_date_s
    FROM core.member_bill_actions x
    JOIN core.members m ON m.member_id = x.member_id AND m.in_scope
)
SELECT a.action_uid,
       a.member_id AS politician_id,
       a.bill_id,
       coalesce(a.vote, 'NA') AS vote,
       coalesce(a.cloture_vote, 'NA') AS cloture_vote,
       coalesce(a.passage_vote, 'NA') AS passage_vote,
       a.is_sponsor::text AS is_sponsor,
       a.is_cosponsor::text AS is_cosponsor,
       jsonb_build_object(
         'Action UID', a.action_uid,
         'Bill ID', a.bill_id,
         'Politician ID', a.member_id,
         'Full Name', a.full_name,
         'Party', a.party,
         'State', a.state,
         'Vote', coalesce(a.vote, 'NA'),
         'Vote ID', coalesce(a.vote_id, 'NA'),
         'Action Date', a.action_date_s,
         'Cloture Vote', coalesce(a.cloture_vote, 'NA'),
         'Cloture Vote Date', a.cloture_date_s,
         'Cloture Vote ID', coalesce(a.cloture_vote_id, 'NA'),
         'Cloture Vote Count', a.cloture_vote_count,
         'Passage Vote', coalesce(a.passage_vote, 'NA'),
         'Passage Vote ID', coalesce(a.passage_vote_id, 'NA'),
         'Passage Vote Count', a.passage_vote_count,
         'Passage Vote Date', a.passage_date_s,
         'Is Sponsor', a.is_sponsor,
         'Is Co-Sponsor', a.is_cosponsor,
         'Action Type', coalesce(a.action_type, 'NA'),
         'Sponsor Tier', a.sponsor_tier,
         'Cosponsored At', coalesce(a.cosponsored_at::text, 'NA'),
         'Original Cosponsor', coalesce(to_jsonb(a.original_cosponsor), '"NA"'::jsonb),
         'Cosponsor Ordinal', coalesce(to_jsonb(a.cosponsor_ordinal), '"NA"'::jsonb),
         'Cosponsor Total', coalesce(to_jsonb(a.cosponsor_total), '"NA"'::jsonb),
         'Days After Introduction', coalesce(to_jsonb(a.days_after_introduction), '"NA"'::jsonb),
         'Withdrawn At', coalesce(a.withdrawn_at::text, 'NA'),
         'Committee Member', coalesce(a.committee_member, 'NA'),
         'Committee Member Of', coalesce(array_to_string(a.committee_member_of, '; '), 'NA'),
         'Progress Checked At', coalesce(to_char(a.progress_checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'NA'),
         'Impact Statement Created', a.impact_statement_created
       ) AS row,
       NULL::integer AS source_row_number,
       (SELECT max(finished_at) FROM core.ingest_runs) AS synced_at
  FROM a;


-- ---------------------------------------------------------------------------
-- mirror_roll_call_votes — one row per roll call, as the Roll Call Votes tab
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW compat.mirror_roll_call_votes
WITH (security_invoker = true) AS
SELECT row_number() OVER (ORDER BY rc.voted_at, rc.number)::bigint AS id,
       rc.vote_id,
       NULL::text AS politician_id,
       rc.bill_id,
       NULL::text AS vote,
       jsonb_build_object(
         'Vote ID', rc.vote_id,
         'Session', rc.session,
         'Chamber', rc.chamber,
         'Roll Call No', rc.number,
         'Bill Type', rc.bill_type,
         'Bill No', rc.bill_number,
         'Congress', rc.congress,
         'Bill Base', rc.bill_type || rc.bill_number,
         'Bill ID', rc.bill_id,
         'Date', to_char((rc.voted_at AT TIME ZONE 'UTC')::date, 'FMMM/FMDD/YYYY'),
         'Category', rc.category,
         'Question', rc.question,
         'Type', rc.vote_type,
         'Result', rc.result,
         'URL', rc.source_url
       ) AS row,
       NULL::integer AS source_row_number,
       (SELECT max(finished_at) FROM core.ingest_runs) AS synced_at
  FROM core.roll_calls rc;


-- ---------------------------------------------------------------------------
-- mirror_party_vote_positions — each whip's vote on each roll call
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW compat.mirror_party_vote_positions
WITH (security_invoker = true) AS
SELECT row_number() OVER (ORDER BY rc.vote_id, w.member_id)::bigint AS id,
       rc.vote_id,
       w.member_id AS politician_id,
       NULL::text AS party_alignment,
       jsonb_build_object(
         'UID', 'WHIP-' || rc.vote_id || '-' || w.member_id,
         'Politician ID', w.member_id,
         'Vote ID', rc.vote_id,
         'Name', w.full_name,
         'Party', left(w.party, 1),
         'State', w.state,
         'Vote', mv.position,
         'Bill Type', rc.bill_type,
         'Bill No', rc.bill_number,
         'Congress', rc.congress,
         'Bill ID', rc.bill_id
       ) AS row,
       NULL::integer AS source_row_number,
       (SELECT max(finished_at) FROM core.ingest_runs) AS synced_at
  FROM core.roll_calls rc
  JOIN core.members w
    ON EXISTS (SELECT 1 FROM jsonb_array_elements(w.roles) r
                WHERE r->>'role' = 'PARTY_WHIP' AND (r->>'congress')::int = rc.congress)
  JOIN core.member_votes mv ON mv.vote_id = rc.vote_id AND mv.voter_id = w.lis_id
 ORDER BY rc.vote_id, w.member_id;


-- ---------------------------------------------------------------------------
-- mirror_bills_master
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW compat.mirror_bills_master
WITH (security_invoker = true) AS
SELECT b.bill_id,
       jsonb_build_object(
         'Bill ID', b.bill_id,
         'Congress', b.congress,
         'Bill Type', b.bill_type,
         'Bill Number', b.bill_number,
         'Bill Base', b.bill_type || b.bill_number,
         'Date', coalesce(b.status_date::text, ''),
         'Official Title', coalesce(b.official_title, ''),
         'Short Title', coalesce(b.short_title, ''),
         'Popular Title', coalesce(b.popular_title, ''),
         'Subject', coalesce(b.subject, ''),
         'Subjects', coalesce(b.subjects, ''),
         'Summary', coalesce(b.summary, ''),
         'Status', coalesce(b.status, ''),
         'Active', b.active,
         'Primary Sponsor', coalesce(b.primary_sponsor, ''),
         'Bill Status URL', coalesce(b.bill_status_url, ''),
         'Bill Text URL', coalesce(b.bill_text_url, ''),
         'Status Changed At', coalesce(b.status_changed_at::text, ''),
         'Status Checked At', coalesce(to_char(b.status_checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''),
         'Progress Stage', coalesce(b.progress_stage, 'NA'),
         'Progress Outcome', coalesce(b.progress_outcome, 'NA'),
         'Progress Stage At', coalesce(b.progress_stage_at::text, 'NA'),
         'Progress Checked At', coalesce(to_char(b.progress_checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'NA'),
         'Last Action At', coalesce(b.last_action_at::text, 'NA'),
         'Last Action Text', coalesce(b.last_action_text, 'NA'),
         'Committee Activity', coalesce(b.committee_activity, 'NA'),
         'Referred Committees', coalesce(array_to_string(b.referred_committees, '; '), 'NA'),
         'Cosponsor Count', coalesce(to_jsonb(b.cosponsor_count), '"NA"'::jsonb),
         'Enacted Via', coalesce(b.enacted_via, 'NA'),
         'Source Updated At', coalesce(to_char(b.source_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), ''),
         'Source Changed', b.source_changed
       ) AS row,
       NULL::integer AS source_row_number,
       (SELECT max(finished_at) FROM core.ingest_runs) AS synced_at
  FROM core.bills b;


-- ---------------------------------------------------------------------------
-- mirror_impact_statements — the bill-level statement
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW compat.mirror_impact_statements
WITH (security_invoker = true) AS
SELECT i.impact_id AS bill_impact_uid,
       i.bill_id,
       jsonb_build_object(
         'Impact UID', i.impact_id,
         'Bill ID', i.bill_id,
         'Congress', b.congress,
         'Title', i.title,
         'Policy Area', i.policy_area,
         'Primary Issue', i.primary_issue,
         'Sub Issue', i.sub_issue,
         'Bill Keywords', i.keywords,
         'Reviewed', i.reviewed,
         'Intended Effects', i.intended_effects,
         'Mechanisms', i.mechanisms,
         'Summary', i.summary,
         'Reverses Existing Policy', i.reverses_existing_policy,
         'Target Type', coalesce(i.target_type, 'N/A'),
         'Target Name', coalesce(i.target_name, 'N/A'),
         'Target Source', coalesce(i.target_source, 'N/A'),
         'Target Effect', coalesce(i.target_effect, 'N/A'),
         'Direction Confidence', i.direction_confidence,
         'Flagged For Review', i.flagged_for_review
       ) AS row,
       NULL::integer AS source_row_number,
       (SELECT max(finished_at) FROM core.ingest_runs) AS synced_at
  FROM core.bill_impacts i
  JOIN core.bills b ON b.bill_id = i.bill_id
 WHERE i.version_code IS NULL;


-- ---------------------------------------------------------------------------
-- mirror_impact_statement_versions — one statement per text version
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW compat.mirror_impact_statement_versions
WITH (security_invoker = true) AS
SELECT i.impact_id AS impact_version_uid,
       i.bill_id,
       i.version_code AS text_version_code,
       i.version_date::text AS text_version_date,
       jsonb_build_object(
         'Impact Version UID', i.impact_id,
         'Run ID', i.run_id,
         'Bill ID', i.bill_id,
         'Congress', b.congress,
         'Text Version Code', i.version_code,
         'Text Version Type', i.version_type,
         'Text Version Date', coalesce(i.version_date::text, ''),
         'Text URL', i.text_url,
         'Summary Action Date', coalesce(i.summary_action_date::text, ''),
         'Title', i.title,
         'Policy Area', i.policy_area,
         'Primary Issue', i.primary_issue,
         'Sub Issue', i.sub_issue,
         'Taxonomy Divergent', i.taxonomy_divergent,
         'Taxonomy Divergence Detail', coalesce(i.taxonomy_divergence_detail, 'NA'),
         'Bill Keywords', i.keywords,
         'Intended Effects', i.intended_effects,
         'Mechanisms', i.mechanisms,
         'Summary', i.summary,
         -- WF5's shape: [{impact_statement_uid, stakeholder_group,
         -- positive_impact, negative_impact}]
         'Affected Stakeholders JSON', (
           SELECT coalesce(jsonb_agg(jsonb_build_object(
                    'impact_statement_uid', left(i.impact_id, 6),
                    'stakeholder_group', s->>'group',
                    'positive_impact', s->>'positive',
                    'negative_impact', s->>'negative') ORDER BY o), '[]'::jsonb)::text
             FROM jsonb_array_elements(i.stakeholders) WITH ORDINALITY AS x(s, o)),
         'Reverses Existing Policy', i.reverses_existing_policy,
         'Target Type', coalesce(i.target_type, 'N/A'),
         'Target Name', coalesce(i.target_name, 'N/A'),
         'Target Source', coalesce(i.target_source, 'N/A'),
         'Target Effect', coalesce(i.target_effect, 'N/A'),
         'Direction Confidence', i.direction_confidence,
         'Flagged For Review', i.flagged_for_review,
         'Version Mismatch', i.version_mismatch,
         'Version Title Source', i.version_title_source,
         'Generated At', coalesce(to_char(i.generated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), '')
       ) AS row,
       NULL::integer AS source_row_number,
       (SELECT max(finished_at) FROM core.ingest_runs) AS synced_at
  FROM core.bill_impacts i
  JOIN core.bills b ON b.bill_id = i.bill_id
 WHERE i.version_code IS NOT NULL;


-- ---------------------------------------------------------------------------
-- core.match_member_bills — same body as migration 014, without the
-- function's own search_path.
--
-- A SQL function that sets a configuration parameter is never inlined, so
-- the member filter could not reach core.member_bill_actions and the view
-- was worked out for every member on every search: about 460 ms. Inlined, a
-- search with bound parameters takes 20 to 45 ms. Every name in the body is
-- schema-qualified, so the setting was never needed. RESET clears the one
-- 014 created; grants are kept by CREATE OR REPLACE.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.match_member_bills(
  p_member_id text,
  p_query     extensions.vector(1024),
  p_limit     integer DEFAULT 10
)
RETURNS TABLE (action_uid text, bill_id text, impact_id text, similarity double precision)
LANGUAGE sql
STABLE
RESET search_path
AS $$
  SELECT a.action_uid,
         i.bill_id,
         i.impact_id,
         1 - (i.embedding OPERATOR(extensions.<=>) p_query) AS similarity
    FROM core.member_bill_actions a
    JOIN core.bill_impacts i
      ON i.bill_id = a.bill_id AND i.version_code IS NULL
   WHERE a.member_id = p_member_id
     AND i.embedding IS NOT NULL
   ORDER BY i.embedding OPERATOR(extensions.<=>) p_query
   LIMIT p_limit
$$;


-- ---------------------------------------------------------------------------
-- GRANTS — read only. The firewall is unchanged: nothing here reaches `app`.
-- ---------------------------------------------------------------------------
REVOKE ALL ON SCHEMA compat FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA compat FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA compat FROM anon';
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA compat FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA compat FROM authenticated';
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA compat FROM authenticated';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA compat TO receipts_app, receipts_trust;
GRANT SELECT ON ALL TABLES IN SCHEMA compat TO receipts_app, receipts_trust;


-- ---------------------------------------------------------------------------
-- VERIFY — read the output.
-- ---------------------------------------------------------------------------

-- Expect seven views; receipts_app and receipts_trust can select, cannot insert.
SELECT c.relname AS view,
       has_table_privilege('receipts_app', c.oid, 'SELECT')   AS app_select,
       has_table_privilege('receipts_app', c.oid, 'INSERT')   AS app_insert,
       has_table_privilege('receipts_trust', c.oid, 'SELECT') AS trust_select
  FROM pg_class c
 WHERE c.relnamespace = 'compat'::regnamespace AND c.relkind = 'v'
 ORDER BY c.relname;
