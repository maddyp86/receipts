-- ============================================================================
-- Migration 026 — core.member_terms: when each member served, term by term
--
-- Run as `postgres`, AFTER 025, and BEFORE the members workflow that writes
-- member_terms is published (it names the table). Idempotent. Purely
-- additive: one table, one function, one view, and four new keys inside the
-- `row` of compat.mirror_politicians. No existing row changes, and every key
-- the query tool reads today keeps its name and format.
--
-- SOURCE: docs/v2/congress-120-transition.md, decision 3 and Phase 1 step 1.
--
-- WHY. core.members has one row per member and no tenure. term_start and
-- term_end are the LAST term only (Collins reads 2021-01-03, though she has
-- served since 1997); left_at says only that a member is gone; and
-- `congresses` means the congresses COLLECTED, not served. On 3 January 2027
-- the 120th Congress convenes: departed senators' records close, freshmen
-- start from zero, and a returning senator (Brown, OH: in the 118th, out for
-- the 119th, back for the 120th) has a gap. None of that can be said honestly
-- from one row. Both congress-legislators files carry every term a member
-- ever held, so the members workflow writes them here and the rest is derived.
--
-- WHAT IT HOLDS
--   member_terms    one row per member and term, from the `terms[]` arrays of
--                   legislators-current and legislators-historical; both
--                   chambers, every year, not only the record's
--   congress_of(d)  the Congress sitting on a date (120 from 2027-01-03)
--   member_tenure   VIEW, one row per core.members row: first and last day in
--                   the member's current chamber, the congresses served there,
--                   and the congresses served in each chamber
--   compat.mirror_politicians gains 'Left At', 'First Term Start',
--                   'Last Term End' and 'Served Congresses' (the chamber the
--                   member sits in, in the format of 'Coverage Congresses')
--
-- Only members in core.members get terms (foreign key), so former House
-- members, who are never added, have none. A term the source later removes
-- or re-dates is NOT deleted here: the pipeline only upserts. The verify
-- query at the end lists any member whose latest term here disagrees with
-- their term_end in core.members, which is how such a case would show.
--
-- `served` and `collected` stay separate on purpose. core.members.congresses
-- is still what the pipeline collects; member_tenure says where the member
-- actually sat. The app compares the two to describe a gap.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. core.member_terms
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.member_terms (
  member_id     text NOT NULL REFERENCES core.members (member_id),
  term_start    date NOT NULL,
  term_end      date NOT NULL,
  chamber       text NOT NULL CHECK (chamber IN ('Senate', 'House')),
  state         text NOT NULL,
  district      text,                          -- House only, as the file writes it ('0' at large)
  senate_class  smallint,
  party         text,
  how           text,                          -- 'appointment', 'special-election', ... when the file says
  end_type      text,                          -- 'death', 'resignation', ... when the file says
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, term_start),
  CONSTRAINT member_terms_dates CHECK (term_end >= term_start)
);

CREATE INDEX IF NOT EXISTS member_terms_chamber_idx ON core.member_terms (chamber, term_start);

COMMENT ON TABLE core.member_terms IS
  'One row per member and term, from congress-legislators (legislators-current and legislators-historical terms[]). '
  'Every term the member ever held, both chambers. Written by the v2 members workflow; upsert only, never deleted.';
COMMENT ON COLUMN core.member_terms.term_end IS
  'The day the term ended or is due to end. For a seat left early this is the day they left, so it equals core.members.left_at for the last term.';
COMMENT ON COLUMN core.member_terms.how IS
  'How the seat was taken when the file says: appointment, special-election. NULL for an ordinary election.';
COMMENT ON COLUMN core.member_terms.end_type IS
  'Why the term ended early when the file says: death, resignation, ... NULL when it ran its course or is still running.';


-- ---------------------------------------------------------------------------
-- 2. core.congress_of(date)
--
-- A Congress begins at noon on 3 January of each odd year (20th Amendment,
-- so exact from 1935). The 1st and 2nd of January still belong to the
-- Congress that is ending, so step back two days before taking the year.
--   2027-01-02 -> 119, 2027-01-03 -> 120, 2023-01-03 -> 118.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.congress_of(d date) RETURNS smallint
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT (((extract(year FROM (d - 2))::int - 1789) / 2) + 1)::smallint
$$;

COMMENT ON FUNCTION core.congress_of(date) IS
  'The Congress sitting on a date: 3 January of an odd year starts a new one. Integer division, so the 1st and 2nd of January belong to the Congress ending.';


-- ---------------------------------------------------------------------------
-- 3. core.member_tenure
--
-- The congresses a term covers run from the one sitting on its first day to
-- the one sitting on its LAST day (term_end - 1): a term ending 2027-01-03
-- served the 119th, not the 120th. A member's `served_congresses` is for the
-- chamber core.members puts them in today; the per-chamber arrays are there
-- for a member who moved (Peltola: House 118th, then Senate).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW core.member_tenure
WITH (security_invoker = true) AS
WITH spans AS (
  SELECT t.member_id, t.chamber, t.term_start, t.term_end,
         core.congress_of(t.term_start)::int   AS first_congress,
         core.congress_of(t.term_end - 1)::int AS last_congress
    FROM core.member_terms t
   WHERE t.term_end > t.term_start
),
per_chamber AS (
  SELECT s.member_id, s.chamber,
         min(s.term_start) AS first_term_start,
         max(s.term_end)   AS last_term_end,
         count(*)::int     AS terms,
         (SELECT array_agg(DISTINCT c ORDER BY c)::smallint[]
            FROM spans s2, generate_series(s2.first_congress, s2.last_congress) AS c
           WHERE s2.member_id = s.member_id AND s2.chamber = s.chamber) AS congresses
    FROM spans s
   GROUP BY s.member_id, s.chamber
)
SELECT m.member_id,
       m.chamber,
       cur.first_term_start,
       cur.last_term_end,
       coalesce(cur.congresses, '{}'::smallint[]) AS served_congresses,
       coalesce(sen.congresses, '{}'::smallint[]) AS senate_congresses,
       coalesce(hou.congresses, '{}'::smallint[]) AS house_congresses,
       coalesce(cur.terms, 0)                     AS terms_in_chamber
  FROM core.members m
  LEFT JOIN per_chamber cur ON cur.member_id = m.member_id AND cur.chamber = m.chamber
  LEFT JOIN per_chamber sen ON sen.member_id = m.member_id AND sen.chamber = 'Senate'
  LEFT JOIN per_chamber hou ON hou.member_id = m.member_id AND hou.chamber = 'House';

COMMENT ON VIEW core.member_tenure IS
  'Per member: first and last day in their current chamber, the congresses served there, and per chamber. Empty arrays and NULL dates until member_terms is written for them.';


-- ---------------------------------------------------------------------------
-- 4. compat.mirror_politicians: four new keys, nothing else changes
--
-- Same columns, same existing keys and formats as migration 015. 'Served
-- Congresses' is written like 'Coverage Congresses' ('118, 119') so the
-- reader that parses one can parse the other.
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
         'Website', coalesce(m.website, ''),
         -- Migration 026. Tenure, from core.member_terms through member_tenure.
         'Left At', coalesce(m.left_at::text, ''),
         'First Term Start', coalesce(mt.first_term_start::text, ''),
         'Last Term End', coalesce(mt.last_term_end::text, ''),
         'Served Congresses', array_to_string(coalesce(mt.served_congresses, '{}'::smallint[]), ', ')
       ) AS row,
       NULL::integer AS source_row_number,
       (SELECT max(finished_at) FROM core.ingest_runs) AS synced_at
  FROM core.members m
  LEFT JOIN core.member_tenure mt ON mt.member_id = m.member_id;


-- ---------------------------------------------------------------------------
-- 5. GRANTS and RLS — the posture of migration 014
--
-- The default privileges set in 014 already give receipts_sync write and
-- receipts_app / receipts_trust SELECT on new tables and views in core; the
-- explicit grants below make this file complete on its own. The function is
-- granted by name, as match_member_bills is.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION core.congress_of(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.congress_of(date) TO receipts_sync, receipts_app, receipts_trust;

GRANT SELECT, INSERT, UPDATE, DELETE ON core.member_terms TO receipts_sync;
GRANT SELECT ON core.member_terms, core.member_tenure TO receipts_app, receipts_trust;

ALTER TABLE core.member_terms ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS member_terms_sync ON core.member_terms;
DROP POLICY IF EXISTS member_terms_read ON core.member_terms;
CREATE POLICY member_terms_sync ON core.member_terms FOR ALL TO receipts_sync USING (true) WITH CHECK (true);
CREATE POLICY member_terms_read ON core.member_terms FOR SELECT TO receipts_app, receipts_trust USING (true);


-- ---------------------------------------------------------------------------
-- 6. VERIFY — read the output.
-- ---------------------------------------------------------------------------

-- Expect: 118, 119, 120, 120 — the 1st and 2nd of January stay with the
-- Congress ending.
SELECT core.congress_of('2023-01-03') AS c118,
       core.congress_of('2027-01-02') AS c119,
       core.congress_of('2027-01-03') AS c120,
       core.congress_of('2028-12-31') AS c120_still;

-- Expect: receipts_sync can write member_terms; receipts_app and
-- receipts_trust read it and the two views, and can run congress_of.
SELECT r.rolname,
       has_table_privilege(r.rolname, 'core.member_terms', 'SELECT')          AS terms_select,
       has_table_privilege(r.rolname, 'core.member_terms', 'INSERT')          AS terms_insert,
       has_table_privilege(r.rolname, 'core.member_tenure', 'SELECT')         AS tenure_select,
       has_table_privilege(r.rolname, 'compat.mirror_politicians', 'SELECT')  AS politicians_select,
       has_function_privilege(r.rolname, 'core.congress_of(date)', 'EXECUTE') AS congress_of
  FROM pg_roles r
 WHERE r.rolname IN ('receipts_sync', 'receipts_app', 'receipts_trust')
 ORDER BY r.rolname;

-- Expect, before the first members write run: every member has 0 terms. After
-- it: 0 members without terms (every row in core.members is in one of the two
-- files), and the four new keys filled for the live senators.
SELECT count(*) FILTER (WHERE terms_in_chamber = 0) AS members_without_terms,
       count(*) FILTER (WHERE terms_in_chamber > 0) AS members_with_terms
  FROM core.member_tenure;

SELECT politician_id,
       row->>'Term Start'          AS last_term_start,
       row->>'First Term Start'    AS first_term_start,
       row->>'Last Term End'       AS last_term_end,
       row->>'Left At'             AS left_at,
       row->>'Coverage Congresses' AS collected,
       row->>'Served Congresses'   AS served
  FROM compat.mirror_politicians
 WHERE (row->>'Live')::boolean OR politician_id IN ('B000944', 'G000359', 'P000619')
 ORDER BY politician_id;

-- Expect: no rows. A row means the source re-dated or removed a term and the
-- upsert kept the old one; fix by hand, the pipeline never deletes.
SELECT m.member_id, m.full_name, m.term_end AS members_term_end, mt.last_term_end
  FROM core.members m
  JOIN core.member_tenure mt USING (member_id)
 WHERE mt.terms_in_chamber > 0 AND m.term_end IS DISTINCT FROM mt.last_term_end
 ORDER BY m.member_id;
