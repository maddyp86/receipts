-- Migration 008 — natural key on mirror_roll_call_votes
--
-- REQUEST from the v7 port lane: "mirror_roll_call_votes still has no natural
-- key, so it reloads every run instead of upserting. UNIQUE (vote_id) fixes it
-- — 220 rows, 220 distinct Vote IDs."
--
-- FINDING — the premise is not quite right, and the difference decides the fix.
-- The table has had a natural key since the base schema:
--
--     UNIQUE (vote_id, politician_id)        -- supabase-schema.sql:242
--
-- A composite UNIQUE does not dedupe when a member is NULL: in Postgres two
-- rows with the same vote_id and NULL politician_id do not conflict, so the
-- constraint silently never fires and every sync run inserts again. That is
-- the reported symptom, and "no natural key" is the wrong diagnosis for it.
--
-- 220 rows / 220 distinct vote_ids says this table is one row per roll call,
-- not one per senator per roll call — so politician_id is very likely null or
-- non-identifying here, and UNIQUE (vote_id) is the correct grain.
--
-- I could not verify the nulls: this lane has no database credential locally.
-- STEP 1 checks it. Run it and read the output before running STEP 2.

-- ── STEP 1 — diagnose. Read the three numbers before going further. ──────────
SELECT count(*)                                  AS total_rows,
       count(DISTINCT vote_id)                   AS distinct_vote_ids,
       count(*) FILTER (WHERE politician_id IS NULL) AS null_politician_id,
       count(*) FILTER (WHERE vote_id IS NULL)   AS null_vote_id
FROM mirror.mirror_roll_call_votes;

-- If total_rows > distinct_vote_ids, STEP 2 will fail: there are duplicate
-- vote_ids to clear first, and which copy to keep is a judgement call, not
-- something this migration should make for you. Stop and say so.
-- If null_vote_id > 0, the key cannot be enforced at all — stop.

-- ── STEP 2 — apply. Safe to re-run; does nothing if already applied. ─────────
DO $mig$
DECLARE
  n_total     bigint;
  n_distinct  bigint;
  n_null_vote bigint;
BEGIN
  IF to_regclass('mirror.mirror_roll_call_votes') IS NULL THEN
    RAISE NOTICE '008: mirror.mirror_roll_call_votes absent — nothing to do.';
    RETURN;
  END IF;

  SELECT count(*), count(DISTINCT vote_id), count(*) FILTER (WHERE vote_id IS NULL)
    INTO n_total, n_distinct, n_null_vote
    FROM mirror.mirror_roll_call_votes;

  IF n_null_vote > 0 THEN
    RAISE EXCEPTION '008: % row(s) have a NULL vote_id. Fix the sync mapping first.', n_null_vote;
  END IF;

  IF n_total <> n_distinct THEN
    RAISE EXCEPTION '008: % rows but only % distinct vote_ids. Resolve the % duplicate(s) by hand first.',
      n_total, n_distinct, n_total - n_distinct;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'mirror.mirror_roll_call_votes'::regclass
       AND conname  = 'mirror_roll_call_votes_vote_id_key'
  ) THEN
    RAISE NOTICE '008: already applied.';
  ELSE
    ALTER TABLE mirror.mirror_roll_call_votes
      ADD CONSTRAINT mirror_roll_call_votes_vote_id_key UNIQUE (vote_id);
    RAISE NOTICE '008: UNIQUE (vote_id) added over % rows.', n_total;
  END IF;

  -- The composite stays. It is now redundant (vote_id alone is stricter) but
  -- dropping it is a separate decision, and it costs one small index.
END
$mig$;

-- ── STEP 3 — the half this file cannot do ───────────────────────────────────
-- A constraint does not make the sync upsert. The n8n node must actually
-- target it: an ON CONFLICT / "matching column" of vote_id. If the node still
-- plain-inserts, 008 turns a silent reload into a loud duplicate-key failure
-- every run. Change the node in the same sitting, or don't run this yet.
--
-- Same shape as the trap in 007: the schema change is inert, or worse than
-- inert, until the pipeline side moves with it.
