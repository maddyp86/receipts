-- ============================================================================
-- Migration 014 — schema `core`: the v2 system of record
--
-- Run as `postgres`, AFTER 013. Idempotent. Purely additive: creates schema
-- `core` and enables pgvector. No table in `mirror` or `app` is touched, and
-- nothing in `core` references `app`.
--
-- SOURCE: docs/v2/plan.md, "Data model (schema core)" and Phase 1.
--
-- WHAT IT HOLDS
--   members            all 541 rows of the Politicians tab; in_scope, live,
--                      the congresses collected, Senate LIS id, roles
--   bills              Bills Master
--   bill_impacts       one row per bill and text version: the impact
--                      statement, its stakeholders, and the bill embedding
--   roll_calls         each roll call loaded whole from the vote file...
--   member_votes       ...with every member's position on it
--   sponsorships       bill and member, sponsor or cosponsor, true cosponsor date
--   donors, donor_alignments   copied as they are
--   action_uids        today's Action UIDs by member and bill, kept so stored
--                      queries and traces still line up after cutover
--   ingest_runs        one row per import or pipeline run
--
--   member_bill_actions        VIEW: one row per member and bill; cloture and
--                              passage votes DERIVED from the roll calls
--   match_member_bills(...)    one member's bills ranked by cosine similarity
--
-- DERIVE, DON'T COPY. No member's vote on a bill is stored twice. The view
-- works it out from roll_calls + member_votes using the rules tested on
-- 10 October 2026 (docs/v2/reference/vote-slot-rules.md):
--   - Senate, category passage or cloture, an allowed bill type
--   - Senate members matched by LIS id
--   - one cloture and one passage slot per bill and member; the latest vote
--     wins; the count is the number of distinct votes
--   - vote dates are the UTC date of the vote (today's convention); the real
--     timestamp is exposed alongside
--
-- ROLES
--   postgres        owner. The n8n "Postgres account" credential connects as
--                   postgres (pg_stat_statements shows every mirror upsert
--                   running as it), so the v2 imports need no extra grant.
--   receipts_sync   read/write on core, so the pipeline can move to the
--                   narrower role later. Still NOTHING on app.
--   receipts_app    SELECT only on core (the query tool).
--   receipts_trust  SELECT only on core.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 0. EXTENSION + SCHEMA
-- ---------------------------------------------------------------------------
-- Supabase keeps extensions in schema `extensions`. Every reference below is
-- qualified, so nothing depends on a role's search_path.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

CREATE SCHEMA IF NOT EXISTS core;

COMMENT ON SCHEMA core IS
  'v2 system of record for the legislative record. Written by the v2 imports '
  'and pipeline; read by the query tool. Never references the app schema.';


-- ---------------------------------------------------------------------------
-- 1. MEMBERS
--
-- Loading is not publishing: a member is collected when in_scope and shown
-- to voters only when live. live without in_scope is refused.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.members (
  member_id      text PRIMARY KEY,                 -- bioguide id
  full_name      text NOT NULL,
  chamber        text NOT NULL CHECK (chamber IN ('Senate', 'House')),
  state          text NOT NULL,
  district       text,                             -- House only; 'AL' at large
  party          text,
  senate_class   smallint,
  lis_id         text UNIQUE,                      -- Senate vote files key on this
  opensecrets_id text,
  -- [{"role": "MAJORITY_LEADER", "congress": 118}, ...] from the Politicians
  -- Role column, plus {"role": "PARTY_WHIP", ...} from the Party Whips tab.
  roles          jsonb NOT NULL DEFAULT '[]'::jsonb,
  term_start     date,
  term_end       date,
  website        text,
  in_scope       boolean NOT NULL DEFAULT false,
  live           boolean NOT NULL DEFAULT false,
  congresses     smallint[] NOT NULL DEFAULT '{}', -- congresses collected
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT members_live_needs_scope CHECK (NOT live OR in_scope)
);


-- ---------------------------------------------------------------------------
-- 2. BILLS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.bills (
  bill_id             text PRIMARY KEY,            -- e.g. hr5371-119
  congress            smallint NOT NULL,
  bill_type           text NOT NULL,
  bill_number         integer NOT NULL,
  -- Bills Master "Date": the date of the bill's current status (status_at in
  -- the bill file). It is NOT the introduction date, which Bills Master does
  -- not carry; the Phase 3 bill workflow reads that from the bill file.
  status_date         date,
  official_title      text,
  short_title         text,
  popular_title       text,
  subject             text,
  subjects            text,
  summary             text,
  status              text,
  active              boolean,
  primary_sponsor     text,
  bill_status_url     text,
  bill_text_url       text,
  status_changed_at   date,
  status_checked_at   timestamptz,
  progress_stage      text,
  progress_outcome    text,
  progress_stage_at   date,
  progress_checked_at timestamptz,
  last_action_at      date,
  last_action_text    text,
  committee_activity  text,
  referred_committees text[],
  cosponsor_count     integer,
  enacted_via         text,
  source_updated_at   timestamptz,
  source_changed      boolean,
  updated_at          timestamptz NOT NULL DEFAULT now()
);


-- ---------------------------------------------------------------------------
-- 3. BILL IMPACTS — one row per bill and text version
--
-- version_code IS NULL is the bill-level statement: the one the pipeline
-- embeds and the one the query tool searches. A row with a version_code is a
-- statement written for one text version of a bill whose text changed.
-- Stakeholders live on the row they describe, as a jsonb array.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.bill_impacts (
  impact_id                  text PRIMARY KEY,   -- Impact UID / Impact Version UID
  bill_id                    text NOT NULL REFERENCES core.bills (bill_id),
  version_code               text,               -- NULL = bill-level statement
  version_type               text,
  version_date               date,               -- blank for enrolled versions
  text_url                   text,
  summary_action_date        date,
  run_id                     text,
  generated_at               timestamptz,
  title                      text,
  policy_area                text,
  primary_issue              text,
  sub_issue                  text,
  keywords                   text,
  reviewed                   text,
  intended_effects           text,
  mechanisms                 text,
  summary                    text,
  reverses_existing_policy   boolean,
  target_type                text,
  target_name                text,
  target_source              text,
  target_effect              text,
  direction_confidence       numeric,
  flagged_for_review         boolean NOT NULL DEFAULT false,
  taxonomy_divergent         boolean,
  taxonomy_divergence_detail text,
  version_mismatch           boolean,
  version_title_source       text,
  -- [{"stakeholder_uid", "group", "positive", "negative"}, ...]
  stakeholders               jsonb NOT NULL DEFAULT '[]'::jsonb,
  embedding                  extensions.vector(1024),
  embedding_model            text,
  embedding_source           text,               -- where the vector came from
  embedded_at                timestamptz,
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS bill_impacts_one_bill_level
  ON core.bill_impacts (bill_id) WHERE version_code IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS bill_impacts_one_per_version
  ON core.bill_impacts (bill_id, version_code) WHERE version_code IS NOT NULL;


-- ---------------------------------------------------------------------------
-- 4. ROLL CALLS AND MEMBER VOTES
--
-- Loaded by source: one roll call, every member's position. A member added
-- later already has their votes. No foreign key to bills: a roll call can be
-- on a bill no in-scope member has touched yet.
--
-- voter_id is the id the vote file uses: LIS id in the Senate, bioguide id in
-- the House. Members are joined on it when read, so a senator who has left
-- (and so is not on the Politicians tab) still has their positions stored.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.roll_calls (
  vote_id         text PRIMARY KEY,               -- e.g. s618-119.2025
  chamber         text NOT NULL CHECK (chamber IN ('s', 'h')),
  congress        smallint NOT NULL,
  session         text,
  number          integer NOT NULL,
  voted_at        timestamptz NOT NULL,           -- the real timestamp
  category        text,
  question        text,
  vote_type       text,
  result          text,
  result_text     text,
  requires        text,
  bill_id         text,                           -- {type}{number}-{congress}
  bill_type       text,
  bill_number     integer,
  bill_congress   smallint,
  source_url      text,
  record_modified timestamptz,
  file_updated_at timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS roll_calls_bill ON core.roll_calls (bill_id);

CREATE TABLE IF NOT EXISTS core.member_votes (
  vote_id      text NOT NULL REFERENCES core.roll_calls (vote_id) ON DELETE CASCADE,
  voter_id     text NOT NULL,
  position     text NOT NULL CHECK (position IN ('Yea', 'Nay', 'Not Voting', 'Present')),
  display_name text,
  party        text,
  state        text,
  PRIMARY KEY (vote_id, voter_id)
);
CREATE INDEX IF NOT EXISTS member_votes_voter ON core.member_votes (voter_id);


-- ---------------------------------------------------------------------------
-- 5. SPONSORSHIPS
--
-- cosponsored_at is the TRUE join date. The sheet's Action Date is the bill's
-- introduction date for every cosponsor, which is wrong for late cosponsors.
-- The WF2c fields after withdrawn_at are kept as the pipeline recorded them.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.sponsorships (
  bill_id                 text NOT NULL REFERENCES core.bills (bill_id),
  member_id               text NOT NULL REFERENCES core.members (member_id),
  role                    text NOT NULL CHECK (role IN ('sponsor', 'cosponsor')),
  cosponsored_at          date,
  original_cosponsor      boolean,
  withdrawn_at            date,
  sponsor_tier            text,
  cosponsor_ordinal       integer,
  cosponsor_total         integer,
  days_after_introduction integer,
  committee_member        text,                   -- TRUE/FALSE or a marker
  committee_member_of     text[],
  progress_checked_at     timestamptz,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bill_id, member_id)
);
CREATE INDEX IF NOT EXISTS sponsorships_member ON core.sponsorships (member_id);


-- ---------------------------------------------------------------------------
-- 6. ACTION UIDS — today's ids, kept
--
-- Stored queries, traces and reused answers carry these ids. A pair with no
-- row here gets 'ACT-{bill}-{member}', today's convention for a new row.
--
-- legacy_action_date is the sheet's Action Date for the row, kept beside the
-- id it belongs to. It has no single rule that can be derived: depending on
-- which workflow created the row and what updated it later, it is the bill's
-- introduction date, the first vote, the last vote, or another vote. The
-- query tool's date-window gate reads it, so recomputing it would change
-- verdicts silently. A new pair derives its date instead (see the view).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.action_uids (
  action_uid         text PRIMARY KEY,
  member_id          text NOT NULL REFERENCES core.members (member_id),
  bill_id            text NOT NULL REFERENCES core.bills (bill_id),
  legacy_action_date date,
  UNIQUE (member_id, bill_id)
);


-- ---------------------------------------------------------------------------
-- 7. DONORS — copied as they are
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.donors (
  donor_uid         text PRIMARY KEY,
  member_id         text NOT NULL REFERENCES core.members (member_id),
  opensecrets_id    text,
  cycle             text,
  contributor       text,
  industry          text,
  pac_sector        text,
  policy_area       text,
  primary_issue     text,
  sub_issue         text,
  description       text,
  total_amount      numeric,
  pac_amount        numeric,
  individual_amount numeric,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- One row per member, bill and donor, as the sheet has it. The mirror's
-- per-bill rollup is a read shape, not a fact, so it is not stored.
CREATE TABLE IF NOT EXISTS core.donor_alignments (
  donor_alignment_uid text PRIMARY KEY,
  member_id           text NOT NULL REFERENCES core.members (member_id),
  bill_id             text NOT NULL,
  impact_uid          text,
  donor_uid           text,
  donor_name          text,
  donor_cycle         text,
  alignment           text,
  confidence          numeric,
  rationale           text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS donor_alignments_member_bill ON core.donor_alignments (member_id, bill_id);


-- ---------------------------------------------------------------------------
-- 8. INGEST RUNS — replaces the manifest and log tabs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.ingest_runs (
  run_id       bigserial PRIMARY KEY,
  workflow     text NOT NULL,
  execution_id text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text NOT NULL CHECK (status IN ('ok', 'failed')),
  counts       jsonb NOT NULL DEFAULT '{}'::jsonb,
  errors       jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes        text
);


-- ---------------------------------------------------------------------------
-- 9. VIEW member_bill_actions — one row per member and bill
--
-- The fields the query tool reads from Politician Bill Actions today, with
-- the votes worked out from the roll calls. Senate only until Phase 5 decides
-- which House categories count.
--
-- security_invoker: the caller's own grants and RLS apply, so receipts_app
-- reads through it exactly as it would read the tables.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW core.member_bill_actions
WITH (security_invoker = true) AS
WITH bill_votes AS (
  SELECT rc.vote_id, rc.bill_id, rc.category, rc.voted_at, rc.number,
         (rc.voted_at AT TIME ZONE 'UTC')::date AS vote_date,
         m.member_id, mv.position
    FROM core.roll_calls rc
    JOIN core.member_votes mv ON mv.vote_id = rc.vote_id
    JOIN core.members m       ON m.lis_id = mv.voter_id
   WHERE rc.chamber = 's'
     AND rc.category IN ('passage', 'cloture')
     AND rc.bill_type IN ('hr', 'hres', 'hjres', 'hconres', 's', 'sres', 'sjres', 'sconres')
     AND rc.bill_id IS NOT NULL
),
-- One slot per member, bill and category: the latest vote wins.
slots AS (
  SELECT DISTINCT ON (member_id, bill_id, category)
         member_id, bill_id, category, vote_id, position, vote_date, voted_at,
         count(*) OVER (PARTITION BY member_id, bill_id, category) AS vote_count
    FROM bill_votes
   ORDER BY member_id, bill_id, category, voted_at DESC, number DESC
),
votes AS (
  SELECT member_id, bill_id,
         max(position)   FILTER (WHERE category = 'cloture') AS cloture_vote,
         max(vote_id)    FILTER (WHERE category = 'cloture') AS cloture_vote_id,
         max(vote_date)  FILTER (WHERE category = 'cloture') AS cloture_vote_date,
         max(voted_at)   FILTER (WHERE category = 'cloture') AS cloture_voted_at,
         coalesce(max(vote_count) FILTER (WHERE category = 'cloture'), 0) AS cloture_vote_count,
         max(position)   FILTER (WHERE category = 'passage') AS passage_vote,
         max(vote_id)    FILTER (WHERE category = 'passage') AS passage_vote_id,
         max(vote_date)  FILTER (WHERE category = 'passage') AS passage_vote_date,
         max(voted_at)   FILTER (WHERE category = 'passage') AS passage_voted_at,
         coalesce(max(vote_count) FILTER (WHERE category = 'passage'), 0) AS passage_vote_count
    FROM slots
   GROUP BY member_id, bill_id
),
first_votes AS (
  SELECT member_id, bill_id, min(vote_date) AS first_vote_date
    FROM bill_votes
   GROUP BY member_id, bill_id
),
pairs AS (
  SELECT member_id, bill_id FROM core.sponsorships
  UNION
  SELECT member_id, bill_id FROM first_votes
)
SELECT
  coalesce(a.action_uid, 'ACT-' || p.bill_id || '-' || p.member_id) AS action_uid,
  p.member_id,
  p.bill_id,
  m.full_name,
  m.party,
  m.state,
  -- The sheet's single Vote / Vote ID: passage when there is one, else cloture.
  coalesce(v.passage_vote, v.cloture_vote)                         AS vote,
  CASE WHEN v.passage_vote IS NOT NULL THEN v.passage_vote_id
       ELSE v.cloture_vote_id END                                  AS vote_id,
  -- Today's Action Date where the row exists today. A new pair dates from
  -- the true cosponsor date, else its first vote.
  coalesce(a.legacy_action_date, s.cosponsored_at, fv.first_vote_date) AS action_date,
  v.cloture_vote,
  v.cloture_vote_id,
  v.cloture_vote_date,
  v.cloture_voted_at,
  coalesce(v.cloture_vote_count, 0)                                AS cloture_vote_count,
  v.passage_vote,
  v.passage_vote_id,
  v.passage_vote_date,
  v.passage_voted_at,
  coalesce(v.passage_vote_count, 0)                                AS passage_vote_count,
  coalesce(s.role = 'sponsor', false)                              AS is_sponsor,
  coalesce(s.role = 'cosponsor', false)                            AS is_cosponsor,
  CASE
    WHEN v.member_id IS NOT NULL AND s.role = 'sponsor'   THEN 'voted, sponsored'
    WHEN v.member_id IS NOT NULL AND s.role = 'cosponsor' THEN 'voted, co-sponsored'
    WHEN v.member_id IS NOT NULL                          THEN 'voted'
    WHEN s.role = 'sponsor'                               THEN 'sponsored'
    WHEN s.role = 'cosponsor'                             THEN 'co-sponsored'
  END                                                              AS action_type,
  coalesce(s.sponsor_tier, 'NA_VOTE_ONLY')                         AS sponsor_tier,
  s.cosponsored_at,
  s.original_cosponsor,
  s.cosponsor_ordinal,
  -- Bill-level facts the sheet also writes onto vote-only rows.
  coalesce(s.cosponsor_total, b.cosponsor_count)                   AS cosponsor_total,
  s.days_after_introduction,
  s.withdrawn_at,
  s.committee_member,
  s.committee_member_of,
  coalesce(s.progress_checked_at, b.progress_checked_at)           AS progress_checked_at,
  EXISTS (SELECT 1 FROM core.bill_impacts i
           WHERE i.bill_id = p.bill_id AND i.version_code IS NULL) AS impact_statement_created
FROM pairs p
JOIN core.members m          ON m.member_id = p.member_id
LEFT JOIN core.bills b       ON b.bill_id = p.bill_id
LEFT JOIN core.sponsorships s ON s.member_id = p.member_id AND s.bill_id = p.bill_id
LEFT JOIN votes v            ON v.member_id = p.member_id AND v.bill_id = p.bill_id
LEFT JOIN first_votes fv     ON fv.member_id = p.member_id AND fv.bill_id = p.bill_id
LEFT JOIN core.action_uids a ON a.member_id = p.member_id AND a.bill_id = p.bill_id;


-- ---------------------------------------------------------------------------
-- 10. SEARCH — one member's bills, ranked by cosine similarity
--
-- Exact, not approximate: a member has hundreds to a couple of thousand
-- bills, so there is no index to tune. similarity is cosine similarity
-- (1 - cosine distance), the same scale as Pinecone's cosine score.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.match_member_bills(
  p_member_id text,
  p_query     extensions.vector(1024),
  p_limit     integer DEFAULT 10
)
RETURNS TABLE (action_uid text, bill_id text, impact_id text, similarity double precision)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, extensions
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
-- 11. GRANTS
-- ---------------------------------------------------------------------------
REVOKE ALL ON SCHEMA core FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA core FROM PUBLIC;
REVOKE ALL ON FUNCTION core.match_member_bills(text, extensions.vector, integer) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA core FROM anon';
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA core FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA core FROM authenticated';
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA core FROM authenticated';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA core TO receipts_sync, receipts_app, receipts_trust;

-- The vector type and its operators live in `extensions`.
GRANT USAGE ON SCHEMA extensions TO receipts_sync, receipts_app, receipts_trust;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO receipts_sync;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA core TO receipts_sync;

GRANT SELECT ON ALL TABLES IN SCHEMA core TO receipts_app, receipts_trust;
GRANT EXECUTE ON FUNCTION core.match_member_bills(text, extensions.vector, integer)
  TO receipts_app, receipts_trust;

ALTER DEFAULT PRIVILEGES IN SCHEMA core
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO receipts_sync;
ALTER DEFAULT PRIVILEGES IN SCHEMA core
  GRANT USAGE, SELECT ON SEQUENCES TO receipts_sync;
ALTER DEFAULT PRIVILEGES IN SCHEMA core
  GRANT SELECT ON TABLES TO receipts_app, receipts_trust;


-- ---------------------------------------------------------------------------
-- 12. ROW LEVEL SECURITY — same posture as mirror (supabase-schema.sql §6)
--
-- The grants do the real work. RLS is on so the advisor stays quiet and so
-- an exposed API schema could never reach these rows. Owner (postgres)
-- bypasses it; FORCE is deliberately not used.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'members', 'bills', 'bill_impacts', 'roll_calls', 'member_votes',
    'sponsorships', 'action_uids', 'donors', 'donor_alignments', 'ingest_runs'
  ] LOOP
    EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON core.%I', t || '_sync', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON core.%I', t || '_read', t);
    EXECUTE format(
      'CREATE POLICY %I ON core.%I FOR ALL TO receipts_sync USING (true) WITH CHECK (true)',
      t || '_sync', t);
    EXECUTE format(
      'CREATE POLICY %I ON core.%I FOR SELECT TO receipts_app, receipts_trust USING (true)',
      t || '_read', t);
  END LOOP;
END
$$;


-- ---------------------------------------------------------------------------
-- 13. VERIFY — read the output.
-- ---------------------------------------------------------------------------

-- Expect: receipts_sync can write core; receipts_app and receipts_trust read
-- only; none of the three gains anything on app.
SELECT r.rolname,
       has_schema_privilege(r.rolname, 'core', 'USAGE')                   AS core_usage,
       has_table_privilege(r.rolname, 'core.members', 'SELECT')           AS core_select,
       has_table_privilege(r.rolname, 'core.members', 'INSERT')           AS core_insert,
       has_schema_privilege(r.rolname, 'app', 'USAGE')                    AS app_usage
  FROM pg_roles r
 WHERE r.rolname IN ('receipts_sync', 'receipts_app', 'receipts_trust')
 ORDER BY r.rolname;

-- Expect: no foreign key from core to any other schema.
SELECT conrelid::regclass AS from_table, confrelid::regclass AS to_table
  FROM pg_constraint
 WHERE contype = 'f'
   AND connamespace = 'core'::regnamespace
   AND confrelid::regclass::text NOT LIKE 'core.%';
