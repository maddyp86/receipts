-- ============================================================================
-- Migration 016 — what the v2 daily pipeline needs to know what is new
--
-- Run as `postgres`, AFTER 015. Idempotent. Purely additive: one new table for
-- source files, one for dry-run statement drafts, and three columns on
-- core.bill_impacts. No existing row changes and nothing the query tool reads
-- changes shape.
--
-- SOURCE: docs/v2/plan.md, Phase 3, and docs/v2/phase-3-prompt.md.
--
-- WHY A FILE LEDGER. The storage bucket re-uploads every file of the current
-- congress every day (every 119th-congress vote and bill file carries
-- today's upload time), so an upload timestamp cannot say what changed. Each
-- file's content hash can. The roll-call and bill workflows list the bucket,
-- send the listing to core.source_files, and fetch only the files whose hash
-- is new. Votes the filter rejects (nominations, amendments) are recorded
-- too, so they are read once and never again.
--
-- WHY DRAFTS. Until cutover the old pipeline writes the impact statements and
-- they are copied into core.bill_impacts. The new statement workflow runs in
-- dry-run beside it; anything it generates goes to core.impact_drafts so it can
-- be compared with the old pipeline's statement without being used.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. core.source_files: one row per bucket object the pipeline has read
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.source_files (
  path           text PRIMARY KEY,          -- bucket object name
  kind           text NOT NULL CHECK (kind IN ('vote', 'bill')),
  ref_id         text,                      -- vote_id or bill_id
  md5            text NOT NULL,             -- GCS md5Hash of the content read
  size           bigint,
  outcome        text NOT NULL,             -- 'loaded', 'filtered:<reason>', 'unreadable'
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  read_at        timestamptz NOT NULL DEFAULT now(),
  run_id         bigint REFERENCES core.ingest_runs (run_id)
);

CREATE INDEX IF NOT EXISTS source_files_ref_idx ON core.source_files (kind, ref_id);

COMMENT ON TABLE core.source_files IS
  'Bucket files the v2 pipeline has read, with the content hash it read. A '
  'listed file whose hash differs from this one is new or changed. Replaces '
  'the Vote Manifest and Bill Manifest tabs.';


-- ---------------------------------------------------------------------------
-- 2. core.bill_impacts: written from the title alone, and what was embedded
-- ---------------------------------------------------------------------------
ALTER TABLE core.bill_impacts
  ADD COLUMN IF NOT EXISTS title_only        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS embedded_text_md5 text,
  ADD COLUMN IF NOT EXISTS content_changed_at timestamptz;

COMMENT ON COLUMN core.bill_impacts.title_only IS
  'The statement was written when the bill had no published text, from its '
  'title and subjects alone. The statement workflow redoes it once text appears.';
COMMENT ON COLUMN core.bill_impacts.embedded_text_md5 IS
  'md5 of the exact text the embedding was made from (the Bill Embeddings '
  'recipe). The embeddings workflow re-embeds when the current text differs.';
COMMENT ON COLUMN core.bill_impacts.content_changed_at IS
  'Last time the statement''s content changed. Set by the writers only when a '
  'value actually differs, unlike updated_at, so the embeddings workflow can '
  'find changed statements without reading them all.';


-- ---------------------------------------------------------------------------
-- 3. core.impact_drafts: statements generated in dry-run, kept for comparison
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.impact_drafts (
  draft_id        bigserial PRIMARY KEY,
  run_id          bigint REFERENCES core.ingest_runs (run_id),
  bill_id         text NOT NULL REFERENCES core.bills (bill_id),
  version_code    text,                     -- NULL for the bill-level statement
  model           text,
  content_source  text,                     -- FULL_TEXT or BILLSTATUS_SUMMARY, as WF5 sets it
  title_only      boolean NOT NULL DEFAULT false,
  statement       jsonb,                    -- the flattened statement, as it would be written
  flags           jsonb,                    -- parse, taxonomy and version checks
  usage           jsonb,                    -- model tokens
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS impact_drafts_bill_idx ON core.impact_drafts (bill_id, version_code);

COMMENT ON TABLE core.impact_drafts IS
  'Impact statements the v2 statement workflow generated while in dry-run. '
  'Never read by the query tool; compared with core.bill_impacts by hand.';


-- ---------------------------------------------------------------------------
-- 4. GRANTS AND RLS — as migration 014
-- ---------------------------------------------------------------------------
REVOKE ALL ON core.source_files, core.impact_drafts FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON core.source_files, core.impact_drafts TO receipts_sync;
GRANT USAGE, SELECT ON SEQUENCE core.impact_drafts_draft_id_seq TO receipts_sync;
GRANT SELECT ON core.source_files, core.impact_drafts TO receipts_app, receipts_trust;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['source_files', 'impact_drafts'] LOOP
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
-- 5. VERIFY
-- ---------------------------------------------------------------------------
SELECT table_name
  FROM information_schema.tables
 WHERE table_schema = 'core' AND table_name IN ('source_files', 'impact_drafts');

SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'core' AND table_name = 'bill_impacts'
   AND column_name IN ('title_only', 'embedded_text_md5', 'content_changed_at');
