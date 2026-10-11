-- v2 PIPELINE: SPONSORSHIPS AND BILLS, step 4. What is new, asked of the database.
-- $1: the member-list pairs (bill, member, role). $2: the bucket listing.
-- Returns one row: the bills whose file must be read, and why.
WITH p AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb)
    AS x(bill_id text, member_id text, role text, introduced_date text, congress int, bill_type text, bill_number int)
),
lb AS (
  SELECT x.path, x.md5, x.size,
         m[3] || m[4] || '-' || m[1] AS bill_id
    FROM jsonb_to_recordset($2::jsonb) AS x(path text, md5 text, size bigint),
         LATERAL regexp_match(x.path, 'data/([0-9]+)/([a-z]+)/([a-z]+)([0-9]+)/data[.]json$') AS m
   WHERE m IS NOT NULL
),
new_pairs AS (
  SELECT p.*, u.action_uid AS existing_action_uid
    FROM p
    LEFT JOIN core.action_uids u ON u.member_id = p.member_id AND u.bill_id = p.bill_id
   WHERE NOT EXISTS (SELECT 1 FROM core.sponsorships s WHERE s.bill_id = p.bill_id AND s.member_id = p.member_id)
),
vote_bills AS (
  SELECT DISTINCT rc.bill_id FROM core.roll_calls rc
   WHERE rc.bill_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.bills b WHERE b.bill_id = rc.bill_id)
),
changed AS (
  SELECT lb.bill_id FROM lb
    JOIN core.bills b ON b.bill_id = lb.bill_id
    LEFT JOIN core.source_files f ON f.path = lb.path
   WHERE f.md5 IS DISTINCT FROM lb.md5
),
wanted AS (
  SELECT bill_id, 'member_list' AS why FROM new_pairs
  UNION SELECT bill_id, 'vote' FROM vote_bills
  UNION SELECT bill_id, 'file_changed' FROM changed
),
bills AS (
  SELECT w.bill_id,
         array_agg(DISTINCT w.why) AS why,
         (b.bill_id IS NOT NULL) AS in_core,
         (b.bill_text_url IS NOT NULL) AS has_text_url,
         b.source_updated_at,
         lb.path, lb.md5, lb.size
    FROM wanted w
    LEFT JOIN core.bills b ON b.bill_id = w.bill_id
    LEFT JOIN lb ON lb.bill_id = w.bill_id
   GROUP BY w.bill_id, b.bill_id, b.bill_text_url, b.source_updated_at, lb.path, lb.md5, lb.size
),
existing_rows AS (
  -- Sponsorship rows already held for the bills about to be re-read, so their
  -- cosponsor details are recomputed from the new file.
  SELECT s.bill_id, s.member_id, s.role FROM core.sponsorships s
    JOIN core.members m ON m.member_id = s.member_id AND m.in_scope
   WHERE s.bill_id IN (SELECT bill_id FROM bills)
)
SELECT
  (SELECT count(*) FROM p) AS pairs_listed,
  (SELECT count(*) FROM lb) AS files_listed,
  (SELECT coalesce(jsonb_agg(np ORDER BY np.bill_id, np.member_id), '[]') FROM new_pairs np) AS new_pairs,
  (SELECT coalesce(jsonb_agg(b ORDER BY
      (CASE WHEN 'member_list' = ANY (b.why) THEN 0 WHEN 'vote' = ANY (b.why) THEN 1 ELSE 2 END), b.bill_id), '[]') FROM bills b) AS bills,
  (SELECT coalesce(jsonb_agg(e), '[]') FROM existing_rows e) AS existing_rows,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('member_id', m.member_id, 'congresses', m.congresses, 'full_name', m.full_name)), '[]')
     FROM core.members m WHERE m.in_scope) AS in_scope;
