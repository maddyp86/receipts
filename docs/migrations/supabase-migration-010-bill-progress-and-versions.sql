-- ============================================================================
-- Migration 010 — two new mirror tables: bill progress, and impact statements
--                 per text version
--
-- Run in the Supabase SQL editor as `postgres`, AFTER 009. Idempotent; purely
-- additive — no existing table is altered.
--
-- SOURCE: docs/fix/receipts-brief-3-progress-effort-versions.md, Task 1.
--
-- WHY. The query tool evaluates every action against ONE summary per bill —
-- the latest, from Pinecone metadata. Congress rewrites bills under the same
-- number ("gut and amend"), so a senator who cosponsored the introduced text
-- is judged against text written months later that they never signed. Two
-- confirmed cases in the corpus:
--
--   s1071-119   introduced as a VA bill to disinter one veteran's remains;
--               enrolled as the FY2026 NDAA.
--   hr5334-119  introduced as a tax deduction for early-childhood educators;
--               enrolled as a Russia sanctions act.
--
-- That is a correctness defect, not a presentation gap. The pipeline now
-- writes one impact statement per TEXT VERSION of each bill whose text
-- changed, plus how far each bill got and how it ended. Neither sheet is
-- mirrored yet. These two tables are where they land.
--
-- THE COLUMN LISTS ARE FIXED. The n8n Mirror Sync sub-workflow declares the
-- same list and introspects the live table before writing, dropping any
-- declared column the table lacks and reporting it as schema drift. Do not
-- rename or add to them here without changing the sync in the same sitting.
--
-- THE PRIMARY KEYS MATTER. The sync upserts on them. Without a unique
-- constraint it falls back to delete-and-reload on every run and reports that
-- as drift — the trap migration 008 closed on mirror_roll_call_votes.
--
-- WHAT THIS IS NOT. Not a corpus verdict mirror. Both tables are ENRICHMENT —
-- what a bill's text said on a given date, and where the bill got to — which
-- is exactly the class of data migration 007 kept. receipts_app reads them;
-- the query tool still evaluates fresh and never reads a stored verdict.
--
-- Pattern copied from mirror_impact_statements (supabase-schema.sql §2, §4,
-- §6): jsonb-bodied with typed columns only where indexed or joined, RLS on,
-- `<table>_sync` / `<table>_read` policies, receipts_sync writes and
-- receipts_app / receipts_trust read. Every other field is read from `row`
-- with the same `pickRow` helper enrichment.ts already uses.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. mirror_bills_master — Bills Master: how far each bill got, how it ended
--
-- Fields read from `row`: Progress Stage, Progress Outcome, Progress Stage At,
-- Last Action At, Last Action Text, Committee Activity, Referred Committees,
-- Cosponsor Count, Enacted Via. One row per bill; bill_id is the key.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mirror.mirror_bills_master (
  bill_id           text PRIMARY KEY,
  row               jsonb NOT NULL,
  source_row_number integer,
  synced_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE mirror.mirror_bills_master IS
  'Bills Master, one row per bill. Progress stage / outcome, last action, '
  'committee activity, referred committees, cosponsor count, Enacted Via. '
  'ENRICHMENT for presentation only: progress may change how a finding is '
  'worded, never flip a verdict and never enter a numeric score (brief 3). '
  'Written only by receipts_sync; upserts on bill_id.';


-- ---------------------------------------------------------------------------
-- 2. mirror_impact_statement_versions — one impact statement per text version
--
-- Only versions whose OPERATIVE TEXT differs are present, so the earliest
-- version carrying a given text is the one stored. Not every bill has rows
-- here — only multi-version bills with changed text. Absence is normal, and
-- a bill with no rows must behave exactly as it does today.
--
-- Every read is by bill, then ordered by date in code, so bill_id is the one
-- index. text_version_date is TEXT, not DATE: congress.gov does not date
-- enrolled (`enr`) versions, so the cell is blank for them and blank must
-- sort LAST, never first. A DATE column would either reject the blank or
-- need a sentinel the sync does not write.
--
-- Rows with `Version Mismatch` = TRUE (the model cited a different version
-- than it was given) must never be selected. That rule lives in code, not
-- here: the sync writes what the sheet holds and the reader filters.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mirror.mirror_impact_statement_versions (
  impact_version_uid text PRIMARY KEY,
  bill_id            text,
  text_version_code  text,
  text_version_date  text,
  row                jsonb NOT NULL,
  source_row_number  integer,
  synced_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_misv_bill
  ON mirror.mirror_impact_statement_versions (bill_id);

COMMENT ON TABLE mirror.mirror_impact_statement_versions IS
  'Impact Statements - Versions: one impact statement per bill per text '
  'version, keyed Impact Version UID. Lets the query tool evaluate an action '
  'against the text that existed on the action''s date rather than the latest '
  'summary. Written only by receipts_sync; upserts on impact_version_uid.';

COMMENT ON COLUMN mirror.mirror_impact_statement_versions.text_version_date IS
  'YYYY-MM-DD as text. BLANK for enrolled (enr) versions - congress.gov does '
  'not date them. Readers treat blank as the latest version and sort it last.';

COMMENT ON COLUMN mirror.mirror_impact_statement_versions.text_version_code IS
  'congress.gov version code: is, ih, rs, rh, es, eh, eas, eah, pcs, enr, ...';


-- ---------------------------------------------------------------------------
-- 3. IF THE SYNC GOT HERE FIRST — make sure the keys exist.
--
-- Migration 007 recorded that the sync can create a table it lists. If it
-- created either of these before 010 ran, CREATE TABLE IF NOT EXISTS above
-- left the sync's version in place, possibly without the primary key that
-- makes the upsert work. Add it if missing; refuse if duplicates would make
-- that impossible, because which copy to keep is a judgement call.
-- ---------------------------------------------------------------------------
DO $keys$
DECLARE
  n_total    bigint;
  n_distinct bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'mirror.mirror_bills_master'::regclass AND contype = 'p'
  ) THEN
    SELECT count(*), count(DISTINCT bill_id) INTO n_total, n_distinct
      FROM mirror.mirror_bills_master;
    IF n_total <> n_distinct THEN
      RAISE EXCEPTION '010: mirror_bills_master has % rows but % distinct bill_ids. Resolve the duplicates by hand first.',
        n_total, n_distinct;
    END IF;
    ALTER TABLE mirror.mirror_bills_master ADD PRIMARY KEY (bill_id);
    RAISE NOTICE '010: PRIMARY KEY (bill_id) added to mirror_bills_master over % rows.', n_total;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'mirror.mirror_impact_statement_versions'::regclass AND contype = 'p'
  ) THEN
    SELECT count(*), count(DISTINCT impact_version_uid) INTO n_total, n_distinct
      FROM mirror.mirror_impact_statement_versions;
    IF n_total <> n_distinct THEN
      RAISE EXCEPTION '010: mirror_impact_statement_versions has % rows but % distinct impact_version_uids. Resolve the duplicates by hand first.',
        n_total, n_distinct;
    END IF;
    ALTER TABLE mirror.mirror_impact_statement_versions ADD PRIMARY KEY (impact_version_uid);
    RAISE NOTICE '010: PRIMARY KEY (impact_version_uid) added to mirror_impact_statement_versions over % rows.', n_total;
  END IF;
END
$keys$;


-- ---------------------------------------------------------------------------
-- 4. GRANTS — restated, not relied on.
--
-- The base schema's ALTER DEFAULT PRIVILEGES covers tables `postgres` creates
-- in `mirror`, so a table this migration creates already has these. A table
-- the SYNC created does not — default privileges are per creating role — and
-- either way the wall should be visible in the file that adds the table, not
-- inferred from one written months earlier. Same reasoning as 005 re-revoking
-- what 002 already covered.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON mirror.mirror_bills_master
  TO receipts_sync;
GRANT SELECT ON mirror.mirror_bills_master
  TO receipts_app, receipts_trust;

GRANT SELECT, INSERT, UPDATE, DELETE ON mirror.mirror_impact_statement_versions
  TO receipts_sync;
GRANT SELECT ON mirror.mirror_impact_statement_versions
  TO receipts_app, receipts_trust;

-- Nothing public, nothing for the API roles. Belt and braces, as in §4 of the
-- base schema: no grant was ever made, stated so the intent survives a later
-- broad GRANT.
REVOKE ALL ON mirror.mirror_bills_master              FROM PUBLIC;
REVOKE ALL ON mirror.mirror_impact_statement_versions FROM PUBLIC;
DO $api_roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON mirror.mirror_bills_master, mirror.mirror_impact_statement_versions FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON mirror.mirror_bills_master, mirror.mirror_impact_statement_versions FROM authenticated';
  END IF;
END
$api_roles$;


-- ---------------------------------------------------------------------------
-- 5. ROW LEVEL SECURITY — the `_sync` / `_read` pair, as on every mirror table.
--
-- receipts_sync writes; receipts_app and receipts_trust read. RLS is not the
-- firewall (the grants are); it is defence in depth for the day someone
-- exposes `mirror` through the API. DROP then CREATE so a re-run is clean.
-- ---------------------------------------------------------------------------
ALTER TABLE mirror.mirror_bills_master              ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.mirror_impact_statement_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mirror_bills_master_sync ON mirror.mirror_bills_master;
DROP POLICY IF EXISTS mirror_bills_master_read ON mirror.mirror_bills_master;
DROP POLICY IF EXISTS mirror_impact_statement_versions_sync ON mirror.mirror_impact_statement_versions;
DROP POLICY IF EXISTS mirror_impact_statement_versions_read ON mirror.mirror_impact_statement_versions;

CREATE POLICY mirror_bills_master_sync ON mirror.mirror_bills_master
  FOR ALL TO receipts_sync USING (true) WITH CHECK (true);
CREATE POLICY mirror_bills_master_read ON mirror.mirror_bills_master
  FOR SELECT TO receipts_app, receipts_trust USING (true);

CREATE POLICY mirror_impact_statement_versions_sync ON mirror.mirror_impact_statement_versions
  FOR ALL TO receipts_sync USING (true) WITH CHECK (true);
CREATE POLICY mirror_impact_statement_versions_read ON mirror.mirror_impact_statement_versions
  FOR SELECT TO receipts_app, receipts_trust USING (true);


-- ---------------------------------------------------------------------------
-- 6. VERIFY — read the output before telling the sync lane to proceed.
-- ---------------------------------------------------------------------------

-- Expect both tables, rls_enabled = true, policy_count = 2, pk_columns as
-- declared: bill_id / impact_version_uid.
SELECT
  c.relname                                                     AS table_name,
  c.relrowsecurity                                              AS rls_enabled,
  (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)    AS policy_count,
  (SELECT string_agg(a.attname, ', ' ORDER BY k.ord)
     FROM pg_constraint x
     JOIN LATERAL unnest(x.conkey) WITH ORDINALITY k(attnum, ord) ON true
     JOIN pg_attribute a ON a.attrelid = x.conrelid AND a.attnum = k.attnum
    WHERE x.conrelid = c.oid AND x.contype = 'p')                AS pk_columns
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'mirror'
  AND c.relname IN ('mirror_bills_master', 'mirror_impact_statement_versions')
ORDER BY c.relname;

-- Expect the exact column lists the sync declares, in this order, with these
-- types. Any difference is what the sync will report as schema drift.
SELECT table_name, ordinal_position, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'mirror'
  AND table_name IN ('mirror_bills_master', 'mirror_impact_statement_versions')
ORDER BY table_name, ordinal_position;

-- Expect: receipts_sync with SELECT/INSERT/UPDATE/DELETE, receipts_app and
-- receipts_trust with SELECT only, nobody else.
SELECT table_name, grantee, privilege_type
FROM information_schema.table_privileges
WHERE table_schema = 'mirror'
  AND table_name IN ('mirror_bills_master', 'mirror_impact_statement_versions')
  AND grantee IN ('receipts_sync', 'receipts_app', 'receipts_trust', 'anon', 'authenticated', 'PUBLIC')
ORDER BY table_name, grantee, privilege_type;
