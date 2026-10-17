-- ============================================================================
-- Receipts — Supabase schema
--
-- Run in the Supabase SQL editor as the `postgres` role.
-- Idempotent: safe to re-run.
--
-- TWO SCHEMAS, THREE ROLES, ONE WALL.
--
--   mirror  — read replica of the Google Sheets pipeline tables. Sheets stays
--             the system of record. Exists to move enrichment reads off the
--             ~300 req/min Sheets quota.
--   app     — product data: sessions, queries (including the user's typed
--             promise_text), demand signals.
--
-- THE CORPUS FIREWALL. A user's typed query must never become evidence about a
-- senator. That is enforced by PRIVILEGES, not naming: `receipts_trust` holds
-- no grant on the `app` schema at all, so a scorer query that touches
-- app_queries ERRORS rather than silently returning rows. Storing promise_text
-- is fine precisely because it lives behind that wall.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 0. ROLES + PASSWORDS
--
-- Edit the three passwords below, then run. The script REFUSES to proceed while
-- the placeholders are unchanged: a schema that installs with a known password
-- is worse than one that fails to install.
--
-- Pure SQL - no psql \set, because the Supabase SQL editor is not psql.
-- ---------------------------------------------------------------------------
-- gen_random_uuid() is core in the Postgres version Supabase runs; this line is
-- belt-and-braces and harmless if the extension is already present.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $roles$
DECLARE
  sync_password  text := 'CHANGE_ME_sync';
  app_password   text := 'CHANGE_ME_app';
  trust_password text := 'CHANGE_ME_trust';
BEGIN
  IF sync_password  LIKE 'CHANGE\_ME%' ESCAPE '\'
  OR app_password   LIKE 'CHANGE\_ME%' ESCAPE '\'
  OR trust_password LIKE 'CHANGE\_ME%' ESCAPE '\' THEN
    RAISE EXCEPTION
      'Refusing to run: replace the three CHANGE_ME passwords at the top of this script first.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'receipts_sync') THEN
    EXECUTE format('CREATE ROLE receipts_sync LOGIN PASSWORD %L', sync_password);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'receipts_app') THEN
    EXECUTE format('CREATE ROLE receipts_app LOGIN PASSWORD %L', app_password);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'receipts_trust') THEN
    EXECUTE format('CREATE ROLE receipts_trust LOGIN PASSWORD %L', trust_password);
  END IF;
END
$roles$;

-- Role intent (kept as comments, not COMMENT ON ROLE, which needs superuser
-- and would abort the paste on Supabase):
--   receipts_sync  - Sheets -> Postgres sync job. Writes mirror. NO grant on app.
--   receipts_app   - the Receipts server. Reads mirror, read/writes app.
--   receipts_trust - trust index / pipeline reads. Reads mirror. REVOKED from app.





-- ---------------------------------------------------------------------------
-- 1. SCHEMAS
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS mirror;
CREATE SCHEMA IF NOT EXISTS app;

COMMENT ON SCHEMA mirror IS
  'Read replica of the Google Sheets pipeline tables. Sheets remains the system '
  'of record. Written only by receipts_sync. Never references the app schema.';

COMMENT ON SCHEMA app IS
  'Product data: sessions, queries, demand signals. NEVER an input to the trust '
  'index. receipts_trust holds no privilege here by design - a join from a trust '
  'query fails rather than silently returning user data as evidence.';


-- ---------------------------------------------------------------------------
-- 2. MIRROR TABLES
--
-- Wide and jsonb-bodied on purpose: Sheets columns move, and a strict column
-- list turns a harmless upstream addition into a sync outage. Typed columns
-- exist only where something is indexed or joined.
--
-- Every table carries source_row_number + synced_at so a divergence from Sheets
-- is diagnosable rather than assumed.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mirror.mirror_politicians (
  politician_id     text PRIMARY KEY,
  full_name         text,
  row               jsonb NOT NULL,
  source_row_number integer,
  synced_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mirror.mirror_promise_alignment_matches (
  match_uid         text PRIMARY KEY,
  politician_id     text NOT NULL,
  promise_uid       text,
  bill_id           text,
  action_uid        text,
  promise_alignment text,
  statement_type    text,
  row               jsonb NOT NULL,
  source_row_number integer,
  synced_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mpam_politician ON mirror.mirror_promise_alignment_matches (politician_id);
CREATE INDEX IF NOT EXISTS idx_mpam_promise    ON mirror.mirror_promise_alignment_matches (promise_uid);
CREATE INDEX IF NOT EXISTS idx_mpam_action     ON mirror.mirror_promise_alignment_matches (action_uid);

CREATE TABLE IF NOT EXISTS mirror.mirror_decision_scores (
  score_uid         text PRIMARY KEY,
  match_uid         text,
  politician_id     text NOT NULL,
  decision_score    numeric,          -- NULL for frozen rows. Never 0.0.
  scorable          boolean,
  index_bucket      text,             -- TRUST | CONSISTENCY
  statement_type    text,
  row               jsonb NOT NULL,
  source_row_number integer,
  synced_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mds_politician ON mirror.mirror_decision_scores (politician_id);
CREATE INDEX IF NOT EXISTS idx_mds_match      ON mirror.mirror_decision_scores (match_uid);
COMMENT ON COLUMN mirror.mirror_decision_scores.decision_score IS
  'NULL means frozen/not scorable - never 0.0. Excluded from means; a zero would '
  'enter the denominator and drag every average toward zero.';

CREATE TABLE IF NOT EXISTS mirror.mirror_platform_matches (
  platform_match_uid text PRIMARY KEY,
  politician_id      text,
  bill_id            text,
  row                jsonb NOT NULL,
  source_row_number  integer,
  synced_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mpm_politician ON mirror.mirror_platform_matches (politician_id);

CREATE TABLE IF NOT EXISTS mirror.mirror_affected_stakeholders (
  id                bigserial PRIMARY KEY,
  bill_impact_uid   text,
  bill_id           text,
  stakeholder_group text,
  row               jsonb NOT NULL,
  source_row_number integer,
  synced_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mas_impact ON mirror.mirror_affected_stakeholders (bill_impact_uid);
CREATE INDEX IF NOT EXISTS idx_mas_bill   ON mirror.mirror_affected_stakeholders (bill_id);

CREATE TABLE IF NOT EXISTS mirror.mirror_impact_statements (
  bill_impact_uid   text PRIMARY KEY,
  bill_id           text,
  row               jsonb NOT NULL,
  source_row_number integer,
  synced_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mis_bill ON mirror.mirror_impact_statements (bill_id);

CREATE TABLE IF NOT EXISTS mirror.mirror_party_vote_positions (
  id                bigserial PRIMARY KEY,
  vote_id           text,
  politician_id     text,
  party_alignment   text,
  row               jsonb NOT NULL,
  source_row_number integer,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vote_id, politician_id)
);

CREATE TABLE IF NOT EXISTS mirror.mirror_donor_alignments (
  id                bigserial PRIMARY KEY,
  politician_id     text,
  bill_id           text,
  donor_alignment   text,
  donor_pro_count   integer,
  row               jsonb NOT NULL,
  source_row_number integer,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (politician_id, bill_id)
);

CREATE TABLE IF NOT EXISTS mirror.mirror_donors (
  id                bigserial PRIMARY KEY,
  politician_id     text,
  donor_name        text,
  row               jsonb NOT NULL,
  source_row_number integer,
  synced_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_md_politician ON mirror.mirror_donors (politician_id);

CREATE TABLE IF NOT EXISTS mirror.mirror_politician_bill_actions (
  action_uid        text PRIMARY KEY,
  politician_id     text NOT NULL,
  bill_id           text,
  vote              text,
  cloture_vote      text,
  passage_vote      text,
  is_sponsor        text,
  is_cosponsor      text,
  row               jsonb NOT NULL,
  source_row_number integer,
  synced_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mpba_politician ON mirror.mirror_politician_bill_actions (politician_id);
CREATE INDEX IF NOT EXISTS idx_mpba_bill       ON mirror.mirror_politician_bill_actions (bill_id);

CREATE TABLE IF NOT EXISTS mirror.mirror_promise_matches (
  promise_match_uid text PRIMARY KEY,
  promise_uid       text,
  bill_id           text,
  politician_id     text,
  match_strength    text,
  similarity_score  numeric,
  row               jsonb NOT NULL,
  source_row_number integer,
  synced_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mpmatch_promise ON mirror.mirror_promise_matches (promise_uid);

CREATE TABLE IF NOT EXISTS mirror.mirror_roll_call_votes (
  id                bigserial PRIMARY KEY,
  vote_id           text,
  politician_id     text,
  bill_id           text,
  vote              text,
  row               jsonb NOT NULL,
  source_row_number integer,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vote_id, politician_id)
);
CREATE INDEX IF NOT EXISTS idx_mrcv_bill ON mirror.mirror_roll_call_votes (bill_id);

CREATE TABLE IF NOT EXISTS mirror.mirror_approved_taxonomy (
  id                bigserial PRIMARY KEY,
  primary_issue     text NOT NULL,
  sub_issue         text NOT NULL,
  taxonomy_keywords text,             -- VERBATIM cell. Never split/re-joined.
  source_row_number integer,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (primary_issue, sub_issue)
);
COMMENT ON TABLE mirror.mirror_approved_taxonomy IS
  'REPORTING ONLY. taxonomy.json (generated by tools/export-taxonomy.mjs) is what '
  'the query path reads. If this table ever fed retrieval there would be two '
  'sources that can disagree - the exact failure the exporter exists to prevent.';


-- ---------------------------------------------------------------------------
-- 3. APP TABLES
--
-- NO USER-IDENTITY COLUMN ANYWHERE. No user_id, no anonymous_id, no PostHog
-- distinct_id. Analytics lives in PostHog; adding an identity column here to
-- "join analytics to queries" would rebuild an attributed political-interest
-- dataset. That join should be impossible, not merely undone.
--
-- session_id groups a single visit's queries. It identifies a SESSION, not a
-- person, and does not survive the session.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS app.app_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  -- Kept for debugging ("which browser broke"). Deliberately no IP, no
  -- fingerprint, no client hash.
  user_agent   text
);

CREATE TABLE IF NOT EXISTS app.app_queries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id            uuid NOT NULL REFERENCES app.app_sessions(id) ON DELETE CASCADE,
  created_at            timestamptz NOT NULL DEFAULT now(),

  -- TEXT, deliberately not a FK into mirror. A user's query must never be
  -- referentially entangled with the senator record it asked about.
  politician_id         text NOT NULL,

  -- THE TRAINING / ANALYSIS COLUMN.
  -- Joined to the classification, retrieval outcome and verdict, this is the
  -- only dataset that answers "what do people actually ask, and did we answer
  -- it well". It sits BEHIND the corpus firewall: receipts_trust cannot read
  -- this column because it cannot read this table because it holds no
  -- privilege on this schema.
  promise_text          text NOT NULL,

  classification        jsonb NOT NULL,   -- the Interpretation
  corrections_applied   jsonb,            -- CorrectionDelta[]
  statement_type        text NOT NULL,    -- 'Policy Position' | 'Campaign Promise'
  provenance            text NOT NULL,    -- 'default' | 'corpus' | 'asserted'

  -- Attribution, persisted. When Campaign Promise vocabulary came from the USER
  -- asserting the premise, that must survive every read-back - a share link
  -- that drops it silently converts their claim into ours.
  user_asserted_premise boolean NOT NULL DEFAULT false,

  -- The frozen result, stored whole so a shared link renders exactly what the
  -- user saw rather than being recomputed against a record that has moved.
  result                jsonb,
  verdict               text,
  band                  text,

  -- Operational, not evidentiary.
  models_used           jsonb,            -- {classify, fulfill, explain}
  degraded              jsonb,            -- {relevance_applied, effect_source}

  CONSTRAINT app_queries_statement_type_chk
    CHECK (statement_type IN ('Policy Position', 'Campaign Promise')),
  CONSTRAINT app_queries_provenance_chk
    CHECK (provenance IN ('default', 'corpus', 'asserted')),
  -- Campaign Promise vocabulary is only ever earned by corpus evidence or an
  -- explicit user assertion. Enforced here so no write path can produce
  -- "BROKE" against a commitment with no stated provenance.
  CONSTRAINT app_queries_promise_needs_provenance_chk
    CHECK (statement_type <> 'Campaign Promise' OR provenance IN ('corpus', 'asserted'))
);
CREATE INDEX IF NOT EXISTS idx_aq_created    ON app.app_queries (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aq_politician ON app.app_queries (politician_id);
CREATE INDEX IF NOT EXISTS idx_aq_session    ON app.app_queries (session_id);
CREATE INDEX IF NOT EXISTS idx_aq_verdict    ON app.app_queries (verdict);

CREATE TABLE IF NOT EXISTS app.app_senator_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  politician_id text NOT NULL,
  promise_text  text,
  session_id    uuid REFERENCES app.app_sessions(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_asr_politician ON app.app_senator_requests (politician_id);


-- ---------------------------------------------------------------------------
-- 4. GRANTS — the firewall
-- ---------------------------------------------------------------------------

-- Nothing is public. Supabase's anon/authenticated roles get nothing either;
-- the browser never talks to Postgres directly.
REVOKE ALL ON SCHEMA app    FROM PUBLIC;
REVOKE ALL ON SCHEMA mirror FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA app    FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA mirror FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA app, mirror FROM anon';
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA app FROM anon';
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA mirror FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA app, mirror FROM authenticated';
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA app FROM authenticated';
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA mirror FROM authenticated';
  END IF;
END
$$;

-- ---- mirror ----------------------------------------------------------------
GRANT USAGE ON SCHEMA mirror TO receipts_sync, receipts_app, receipts_trust;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mirror TO receipts_sync;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mirror TO receipts_sync;

GRANT SELECT ON ALL TABLES IN SCHEMA mirror TO receipts_app, receipts_trust;

-- ---- app -------------------------------------------------------------------
GRANT USAGE ON SCHEMA app TO receipts_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA app TO receipts_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO receipts_app;

-- ============================================================================
-- THE WALL. receipts_trust and receipts_sync get NOTHING on app - not SELECT,
-- not even USAGE on the schema, so they cannot resolve the table names at all.
-- A trust query that touches app_queries fails with "permission denied for
-- schema app" instead of returning a user's typed text as evidence.
--
-- These REVOKEs are belt-and-braces (no grant was ever made) and are stated
-- explicitly so the intent survives someone later running a broad GRANT.
-- ============================================================================
REVOKE ALL ON SCHEMA app             FROM receipts_trust, receipts_sync;
REVOKE ALL ON ALL TABLES IN SCHEMA app    FROM receipts_trust, receipts_sync;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA app FROM receipts_trust, receipts_sync;


-- ---------------------------------------------------------------------------
-- 5. DEFAULT PRIVILEGES — so a table added tomorrow inherits the same wall.
--
-- Without these, a new mirror table is invisible to receipts_app and a new app
-- table might be readable by whoever created it. The wall has to hold for
-- tables that do not exist yet.
-- ---------------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES IN SCHEMA mirror
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO receipts_sync;
ALTER DEFAULT PRIVILEGES IN SCHEMA mirror
  GRANT SELECT ON TABLES TO receipts_app, receipts_trust;
ALTER DEFAULT PRIVILEGES IN SCHEMA mirror
  GRANT USAGE, SELECT ON SEQUENCES TO receipts_sync;

ALTER DEFAULT PRIVILEGES IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE ON TABLES TO receipts_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA app
  GRANT USAGE, SELECT ON SEQUENCES TO receipts_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA app
  REVOKE ALL ON TABLES FROM receipts_trust, receipts_sync;


-- ---------------------------------------------------------------------------
-- 6. ROW LEVEL SECURITY — on every table, each with a policy.
--
-- WHY ALL 16, when the grants already do the real work:
--
--   1. Supabase's advisor flags any table without RLS. A permanently-warning
--      advisor trains people to ignore it, and the next warning is the one
--      that mattered.
--   2. If anyone ever adds `app` or `mirror` to the API's exposed schemas,
--      PostgREST reaches them and RLS becomes the only thing standing between
--      an anon key and this data.
--   3. It costs nothing here: access is via three named roles, so the policies
--      are simple and permissive rather than per-user predicates.
--
-- WHAT RLS IS NOT: it is not the corpus firewall. RLS filters rows for a role
-- that can already reach the table. `receipts_trust` cannot reach app at all -
-- no USAGE on the schema - which is strictly stronger. Do not let RLS being
-- present tempt anyone into loosening the grants.
--
-- NOTE ON `FORCE ROW LEVEL SECURITY`: deliberately NOT used. The table owner
-- (postgres) bypasses RLS, and FORCE would apply policies to the owner too -
-- which would make the Supabase SQL editor return zero rows from your own
-- tables and read exactly like data loss. Owner-bypass is the safer default.
-- ---------------------------------------------------------------------------

ALTER TABLE mirror.mirror_politicians ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.mirror_promise_alignment_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.mirror_decision_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.mirror_platform_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.mirror_affected_stakeholders ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.mirror_impact_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.mirror_party_vote_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.mirror_donor_alignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.mirror_donors ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.mirror_politician_bill_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.mirror_promise_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.mirror_roll_call_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.mirror_approved_taxonomy ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mirror_politicians_sync ON mirror.mirror_politicians;
DROP POLICY IF EXISTS mirror_politicians_read ON mirror.mirror_politicians;
DROP POLICY IF EXISTS mirror_promise_alignment_matches_sync ON mirror.mirror_promise_alignment_matches;
DROP POLICY IF EXISTS mirror_promise_alignment_matches_read ON mirror.mirror_promise_alignment_matches;
DROP POLICY IF EXISTS mirror_decision_scores_sync ON mirror.mirror_decision_scores;
DROP POLICY IF EXISTS mirror_decision_scores_read ON mirror.mirror_decision_scores;
DROP POLICY IF EXISTS mirror_platform_matches_sync ON mirror.mirror_platform_matches;
DROP POLICY IF EXISTS mirror_platform_matches_read ON mirror.mirror_platform_matches;
DROP POLICY IF EXISTS mirror_affected_stakeholders_sync ON mirror.mirror_affected_stakeholders;
DROP POLICY IF EXISTS mirror_affected_stakeholders_read ON mirror.mirror_affected_stakeholders;
DROP POLICY IF EXISTS mirror_impact_statements_sync ON mirror.mirror_impact_statements;
DROP POLICY IF EXISTS mirror_impact_statements_read ON mirror.mirror_impact_statements;
DROP POLICY IF EXISTS mirror_party_vote_positions_sync ON mirror.mirror_party_vote_positions;
DROP POLICY IF EXISTS mirror_party_vote_positions_read ON mirror.mirror_party_vote_positions;
DROP POLICY IF EXISTS mirror_donor_alignments_sync ON mirror.mirror_donor_alignments;
DROP POLICY IF EXISTS mirror_donor_alignments_read ON mirror.mirror_donor_alignments;
DROP POLICY IF EXISTS mirror_donors_sync ON mirror.mirror_donors;
DROP POLICY IF EXISTS mirror_donors_read ON mirror.mirror_donors;
DROP POLICY IF EXISTS mirror_politician_bill_actions_sync ON mirror.mirror_politician_bill_actions;
DROP POLICY IF EXISTS mirror_politician_bill_actions_read ON mirror.mirror_politician_bill_actions;
DROP POLICY IF EXISTS mirror_promise_matches_sync ON mirror.mirror_promise_matches;
DROP POLICY IF EXISTS mirror_promise_matches_read ON mirror.mirror_promise_matches;
DROP POLICY IF EXISTS mirror_roll_call_votes_sync ON mirror.mirror_roll_call_votes;
DROP POLICY IF EXISTS mirror_roll_call_votes_read ON mirror.mirror_roll_call_votes;
DROP POLICY IF EXISTS mirror_approved_taxonomy_sync ON mirror.mirror_approved_taxonomy;
DROP POLICY IF EXISTS mirror_approved_taxonomy_read ON mirror.mirror_approved_taxonomy;

-- receipts_sync writes the mirror; receipts_app and receipts_trust read it.
CREATE POLICY mirror_politicians_sync ON mirror.mirror_politicians
  FOR ALL TO receipts_sync USING (true) WITH CHECK (true);
CREATE POLICY mirror_politicians_read ON mirror.mirror_politicians
  FOR SELECT TO receipts_app, receipts_trust USING (true);
CREATE POLICY mirror_promise_alignment_matches_sync ON mirror.mirror_promise_alignment_matches
  FOR ALL TO receipts_sync USING (true) WITH CHECK (true);
CREATE POLICY mirror_promise_alignment_matches_read ON mirror.mirror_promise_alignment_matches
  FOR SELECT TO receipts_app, receipts_trust USING (true);
CREATE POLICY mirror_decision_scores_sync ON mirror.mirror_decision_scores
  FOR ALL TO receipts_sync USING (true) WITH CHECK (true);
CREATE POLICY mirror_decision_scores_read ON mirror.mirror_decision_scores
  FOR SELECT TO receipts_app, receipts_trust USING (true);
CREATE POLICY mirror_platform_matches_sync ON mirror.mirror_platform_matches
  FOR ALL TO receipts_sync USING (true) WITH CHECK (true);
CREATE POLICY mirror_platform_matches_read ON mirror.mirror_platform_matches
  FOR SELECT TO receipts_app, receipts_trust USING (true);
CREATE POLICY mirror_affected_stakeholders_sync ON mirror.mirror_affected_stakeholders
  FOR ALL TO receipts_sync USING (true) WITH CHECK (true);
CREATE POLICY mirror_affected_stakeholders_read ON mirror.mirror_affected_stakeholders
  FOR SELECT TO receipts_app, receipts_trust USING (true);
CREATE POLICY mirror_impact_statements_sync ON mirror.mirror_impact_statements
  FOR ALL TO receipts_sync USING (true) WITH CHECK (true);
CREATE POLICY mirror_impact_statements_read ON mirror.mirror_impact_statements
  FOR SELECT TO receipts_app, receipts_trust USING (true);
CREATE POLICY mirror_party_vote_positions_sync ON mirror.mirror_party_vote_positions
  FOR ALL TO receipts_sync USING (true) WITH CHECK (true);
CREATE POLICY mirror_party_vote_positions_read ON mirror.mirror_party_vote_positions
  FOR SELECT TO receipts_app, receipts_trust USING (true);
CREATE POLICY mirror_donor_alignments_sync ON mirror.mirror_donor_alignments
  FOR ALL TO receipts_sync USING (true) WITH CHECK (true);
CREATE POLICY mirror_donor_alignments_read ON mirror.mirror_donor_alignments
  FOR SELECT TO receipts_app, receipts_trust USING (true);
CREATE POLICY mirror_donors_sync ON mirror.mirror_donors
  FOR ALL TO receipts_sync USING (true) WITH CHECK (true);
CREATE POLICY mirror_donors_read ON mirror.mirror_donors
  FOR SELECT TO receipts_app, receipts_trust USING (true);
CREATE POLICY mirror_politician_bill_actions_sync ON mirror.mirror_politician_bill_actions
  FOR ALL TO receipts_sync USING (true) WITH CHECK (true);
CREATE POLICY mirror_politician_bill_actions_read ON mirror.mirror_politician_bill_actions
  FOR SELECT TO receipts_app, receipts_trust USING (true);
CREATE POLICY mirror_promise_matches_sync ON mirror.mirror_promise_matches
  FOR ALL TO receipts_sync USING (true) WITH CHECK (true);
CREATE POLICY mirror_promise_matches_read ON mirror.mirror_promise_matches
  FOR SELECT TO receipts_app, receipts_trust USING (true);
CREATE POLICY mirror_roll_call_votes_sync ON mirror.mirror_roll_call_votes
  FOR ALL TO receipts_sync USING (true) WITH CHECK (true);
CREATE POLICY mirror_roll_call_votes_read ON mirror.mirror_roll_call_votes
  FOR SELECT TO receipts_app, receipts_trust USING (true);
CREATE POLICY mirror_approved_taxonomy_sync ON mirror.mirror_approved_taxonomy
  FOR ALL TO receipts_sync USING (true) WITH CHECK (true);
CREATE POLICY mirror_approved_taxonomy_read ON mirror.mirror_approved_taxonomy
  FOR SELECT TO receipts_app, receipts_trust USING (true);

-- app: receipts_app only. No policy exists for receipts_trust or receipts_sync,
-- and none should - they cannot reach these tables anyway. The absence is the
-- point, and is load-bearing rather than an omission.
ALTER TABLE app.app_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.app_queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.app_senator_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_sessions_server ON app.app_sessions;
DROP POLICY IF EXISTS app_queries_server ON app.app_queries;
DROP POLICY IF EXISTS app_senator_requests_server ON app.app_senator_requests;

CREATE POLICY app_sessions_server ON app.app_sessions
  FOR ALL TO receipts_app USING (true) WITH CHECK (true);
CREATE POLICY app_queries_server ON app.app_queries
  FOR ALL TO receipts_app USING (true) WITH CHECK (true);
CREATE POLICY app_senator_requests_server ON app.app_senator_requests
  FOR ALL TO receipts_app USING (true) WITH CHECK (true);


-- ---------------------------------------------------------------------------
-- 7. VERIFY THE WALL — read the output of these two queries.
-- ---------------------------------------------------------------------------

-- Expect: receipts_trust and receipts_sync -> false on app; true on mirror.
SELECT
  r.rolname                                              AS role,
  has_schema_privilege(r.rolname, 'app',    'USAGE')     AS can_see_app,
  has_schema_privilege(r.rolname, 'mirror', 'USAGE')     AS can_see_mirror
FROM pg_roles r
WHERE r.rolname IN ('receipts_sync', 'receipts_app', 'receipts_trust')
ORDER BY r.rolname;

-- Expect exactly one row: receipts_app. Anything else can read the user's
-- typed promise_text and the wall is not holding.
SELECT grantee, privilege_type
FROM information_schema.table_privileges
WHERE table_schema = 'app' AND table_name = 'app_queries'
ORDER BY grantee, privilege_type;

-- Expect: 16 rows, rls_enabled = true on every one, policy_count > 0.
-- A table with RLS on and zero policies is deny-all for non-owners.
SELECT
  n.nspname                                                  AS schema,
  c.relname                                                  AS table_name,
  c.relrowsecurity                                           AS rls_enabled,
  (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('app', 'mirror') AND c.relkind = 'r'
ORDER BY n.nspname, c.relname;


-- ===========================================================================
-- 8. IF YOUR BACKEND USES THE service_role KEY — READ THIS.
--
-- service_role ALWAYS bypasses RLS (Supabase docs). So on any code path using
-- that key, every policy above is inert. That is expected, and fine on its own.
--
-- The part that is NOT fine if left unexamined: service_role also leaves the
-- three custom roles unused, and the corpus firewall is built out of those
-- roles. A connection as service_role is not receipts_trust, so "receipts_trust
-- cannot see schema app" protects nothing on that path.
--
-- Note service_role has NO grant on these custom schemas by default — Supabase
-- only auto-grants on `public`. A service_role client will therefore get
-- "permission denied for schema app" until you grant it. That error is the wall
-- working, not a bug to route around.
--
-- THE RULE: the app server may use service_role if you grant it. The TRUST /
-- PIPELINE reader must NOT — it must connect directly as receipts_trust, or the
-- firewall is decorative.
--
-- Uncomment ONLY the block you mean:

-- Safe: lets a service_role client read the mirror replica.
-- GRANT USAGE ON SCHEMA mirror TO service_role;
-- GRANT SELECT ON ALL TABLES IN SCHEMA mirror TO service_role;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA mirror GRANT SELECT ON TABLES TO service_role;

-- Collapses the wall for anything holding the service_role key. Only do this if
-- the app server uses service_role AND the trust reader provably does not.
-- GRANT USAGE ON SCHEMA app TO service_role;
-- GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA app TO service_role;
-- ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT, INSERT, UPDATE ON TABLES TO service_role;
-- ===========================================================================
