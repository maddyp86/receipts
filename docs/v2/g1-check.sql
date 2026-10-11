-- Gate G1: core.member_bill_actions vs mirror.mirror_politician_bill_actions,
-- Schumer and Thune, field by field. One output row per difference.
--
-- Every value is compared as normalised text: the sheet's 'NA' and blank
-- become NULL, M/D/YYYY dates become ISO, booleans become true/false, and
-- timestamps are ISO UTC with milliseconds.
--
-- Read-only. Run as postgres (the SQL editor). The result on 10 October 2026
-- is in docs/v2/phase-1-report.md.
WITH m AS (
  SELECT politician_id AS member_id, bill_id, action_uid, row AS r
    FROM mirror.mirror_politician_bill_actions
   WHERE politician_id IN ('S000148', 'T000250')
),
c AS (
  SELECT * FROM core.member_bill_actions WHERE member_id IN ('S000148', 'T000250')
),
pairs AS (
  SELECT coalesce(m.member_id, c.member_id) AS member_id,
         coalesce(m.bill_id, c.bill_id)     AS bill_id,
         m.r, m.action_uid AS m_uid, c
    FROM m FULL JOIN c ON c.member_id = m.member_id AND c.bill_id = m.bill_id
),
fields AS (
  SELECT p.member_id, p.bill_id, f.field, f.mirror_value, f.core_value
    FROM pairs p
    CROSS JOIN LATERAL (
      SELECT * FROM (VALUES
        ('presence', CASE WHEN p.r IS NULL THEN 'absent' ELSE 'present' END,
                     CASE WHEN (p.c).member_id IS NULL THEN 'absent' ELSE 'present' END),
        ('action_uid', p.m_uid, (p.c).action_uid),
        ('vote',  nullif(nullif(trim(p.r->>'Vote'), ''), 'NA'), (p.c).vote),
        ('vote_id', nullif(nullif(trim(p.r->>'Vote ID'), ''), 'NA'), (p.c).vote_id),
        ('action_date', nullif(nullif(trim(p.r->>'Action Date'), ''), 'NA'), (p.c).action_date::text),
        ('cloture_vote', nullif(nullif(trim(p.r->>'Cloture Vote'), ''), 'NA'), (p.c).cloture_vote),
        ('cloture_vote_id', nullif(nullif(trim(p.r->>'Cloture Vote ID'), ''), 'NA'), (p.c).cloture_vote_id),
        ('cloture_vote_date', nullif(nullif(trim(p.r->>'Cloture Vote Date'), ''), 'NA'), (p.c).cloture_vote_date::text),
        ('cloture_vote_count', coalesce(nullif(nullif(trim(p.r->>'Cloture Vote Count'), ''), 'NA'),
                               CASE WHEN nullif(nullif(trim(p.r->>'Cloture Vote'), ''), 'NA') IS NULL THEN '0' ELSE '1' END),
                               (p.c).cloture_vote_count::text),
        ('passage_vote', nullif(nullif(trim(p.r->>'Passage Vote'), ''), 'NA'), (p.c).passage_vote),
        ('passage_vote_id', nullif(nullif(trim(p.r->>'Passage Vote ID'), ''), 'NA'), (p.c).passage_vote_id),
        ('passage_vote_date', nullif(nullif(trim(p.r->>'Passage Vote Date'), ''), 'NA'), (p.c).passage_vote_date::text),
        ('passage_vote_count', coalesce(nullif(nullif(trim(p.r->>'Passage Vote Count'), ''), 'NA'),
                               CASE WHEN nullif(nullif(trim(p.r->>'Passage Vote'), ''), 'NA') IS NULL THEN '0' ELSE '1' END),
                               (p.c).passage_vote_count::text),
        ('is_sponsor', lower(p.r->>'Is Sponsor'), (p.c).is_sponsor::text),
        ('is_cosponsor', lower(p.r->>'Is Co-Sponsor'), (p.c).is_cosponsor::text),
        ('action_type', nullif(nullif(trim(p.r->>'Action Type'), ''), 'NA'), (p.c).action_type),
        ('sponsor_tier', nullif(nullif(trim(p.r->>'Sponsor Tier'), ''), 'NA'), (p.c).sponsor_tier),
        ('cosponsored_at', nullif(nullif(trim(p.r->>'Cosponsored At'), ''), 'NA'), (p.c).cosponsored_at::text),
        ('original_cosponsor', lower(nullif(nullif(trim(p.r->>'Original Cosponsor'), ''), 'NA')), (p.c).original_cosponsor::text),
        ('cosponsor_ordinal', nullif(nullif(trim(p.r->>'Cosponsor Ordinal'), ''), 'NA'), (p.c).cosponsor_ordinal::text),
        ('cosponsor_total', nullif(nullif(trim(p.r->>'Cosponsor Total'), ''), 'NA'), (p.c).cosponsor_total::text),
        ('days_after_introduction', nullif(nullif(trim(p.r->>'Days After Introduction'), ''), 'NA'), (p.c).days_after_introduction::text),
        ('withdrawn_at', nullif(nullif(trim(p.r->>'Withdrawn At'), ''), 'NA'), (p.c).withdrawn_at::text),
        ('committee_member', nullif(nullif(trim(p.r->>'Committee Member'), ''), 'NA'),
                             CASE WHEN (p.c).committee_member = 'NA' THEN NULL ELSE (p.c).committee_member END),
        ('committee_member_of', nullif(nullif(trim(p.r->>'Committee Member Of'), ''), 'NA'), array_to_string((p.c).committee_member_of, ';')),
        ('progress_checked_at', nullif(nullif(trim(p.r->>'Progress Checked At'), ''), 'NA'),
                                to_char((p.c).progress_checked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
        ('impact_statement_created', lower(p.r->>'Impact Statement Created'), (p.c).impact_statement_created::text),
        ('party', nullif(trim(p.r->>'Party'), ''), (p.c).party),
        ('state', nullif(trim(p.r->>'State'), ''), (p.c).state)
      ) AS v(field, mirror_value, core_value)
    ) f
)
SELECT member_id, bill_id, field,
       -- normalise sheet dates (M/D/YYYY) before comparing
       CASE WHEN mirror_value ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$'
            THEN to_char(to_date(mirror_value, 'MM/DD/YYYY'), 'YYYY-MM-DD') ELSE mirror_value END AS mirror_value,
       core_value
  FROM fields
 WHERE (CASE WHEN mirror_value ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$'
             THEN to_char(to_date(mirror_value, 'MM/DD/YYYY'), 'YYYY-MM-DD') ELSE mirror_value END)
       IS DISTINCT FROM core_value
 ORDER BY field, member_id, bill_id;
