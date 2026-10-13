-- v2 PIPELINE: IMPACT STATEMENTS, step 1. What needs a statement.
-- $1: this workflow's name, to total this month's model spend.
-- $2: sample_bills, a comma-separated list of bill ids (may be empty)
--   named    those bills, whether or not they need a statement: sample mode
--            sends them to the model so a new statement can be read beside
--            the one the old pipeline wrote
--   main     bills linked to an in_scope member (sponsor, cosponsor or a vote)
--            with no bill-level statement, or whose statement was written from
--            the title alone and whose text has since been published
--   changed  bills linked to an in_scope member whose source file changed, with
--            the text versions that already have a statement
-- Each bill is shaped like a Bills Master row, because WF5's bill-context
-- builder and prompt read those keys.
WITH scope AS (SELECT member_id FROM core.members WHERE in_scope),
linked AS (
  SELECT s.bill_id FROM core.sponsorships s JOIN scope USING (member_id)
  UNION
  SELECT a.bill_id FROM core.member_bill_actions a JOIN scope USING (member_id)
),
rowof AS (
  SELECT b.bill_id, jsonb_build_object(
    'Bill ID', b.bill_id, 'Congress', b.congress, 'Bill Type', b.bill_type, 'Bill Number', b.bill_number,
    'Bill Base', b.bill_type || b.bill_number, 'Official Title', b.official_title, 'Subject', b.subject,
    'Subjects', b.subjects, 'Bill Status URL', b.bill_status_url, 'Bill Text URL', b.bill_text_url) AS r
  FROM core.bills b JOIN (SELECT DISTINCT bill_id FROM linked) l USING (bill_id)
),
main AS (
  SELECT r.bill_id, r.r || jsonb_build_object('redo_title_only', coalesce(i.title_only, false)) AS r
    FROM rowof r
    LEFT JOIN core.bill_impacts i ON i.bill_id = r.bill_id AND i.version_code IS NULL
   WHERE i.impact_id IS NULL
      OR (i.title_only AND r.r->>'Bill Text URL' IS NOT NULL)
),
named AS (
  SELECT b.bill_id, jsonb_build_object(
    'Bill ID', b.bill_id, 'Congress', b.congress, 'Bill Type', b.bill_type, 'Bill Number', b.bill_number,
    'Bill Base', b.bill_type || b.bill_number, 'Official Title', b.official_title, 'Subject', b.subject,
    'Subjects', b.subjects, 'Bill Status URL', b.bill_status_url, 'Bill Text URL', b.bill_text_url) AS r
  FROM core.bills b
  WHERE b.bill_id = ANY (string_to_array(nullif(btrim($2), ''), ','))
),
changed AS (
  SELECT r.bill_id, r.r || jsonb_build_object('have', coalesce(
           (SELECT jsonb_agg(v.version_code) FROM core.bill_impacts v WHERE v.bill_id = r.bill_id AND v.version_code IS NOT NULL), '[]')) AS r
    FROM rowof r JOIN core.bills b USING (bill_id)
   WHERE b.source_changed
)
SELECT
  (SELECT coalesce(jsonb_agg(m.r ORDER BY m.bill_id), '[]') FROM main m) AS main,
  (SELECT coalesce(jsonb_agg(n.r ORDER BY n.bill_id), '[]') FROM named n) AS named,
  (SELECT coalesce(jsonb_agg(c.r ORDER BY c.bill_id), '[]') FROM changed c) AS changed,
  (SELECT coalesce(sum((counts->>'cost_usd')::numeric), 0) FROM core.ingest_runs
    WHERE workflow = $1 AND started_at >= date_trunc('month', now())) AS month_spend_usd;
