-- v2 PIPELINE: DAILY COMPARISON (gate G4), the core side.
-- One row: for the members compared, every member-bill row of
-- core.member_bill_actions (votes derived from the roll calls), the bills they
-- touch, and every Senate roll call held.
WITH m AS (SELECT unnest(string_to_array($1, ',')) AS member_id)
SELECT
  (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'member_id', a.member_id, 'bill_id', a.bill_id, 'action_uid', a.action_uid,
      'is_sponsor', a.is_sponsor, 'is_cosponsor', a.is_cosponsor,
      'cloture_vote', a.cloture_vote, 'cloture_vote_id', a.cloture_vote_id, 'cloture_vote_count', a.cloture_vote_count,
      'passage_vote', a.passage_vote, 'passage_vote_id', a.passage_vote_id, 'passage_vote_count', a.passage_vote_count,
      'cosponsored_at', a.cosponsored_at, 'withdrawn_at', a.withdrawn_at, 'original_cosponsor', a.original_cosponsor,
      'sponsor_tier', a.sponsor_tier)), '[]')
     FROM core.member_bill_actions a JOIN m USING (member_id)) AS actions,
  (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'bill_id', b.bill_id, 'official_title', b.official_title, 'status', b.status, 'progress_stage', b.progress_stage,
      'progress_outcome', b.progress_outcome, 'cosponsor_count', b.cosponsor_count, 'bill_text_url', b.bill_text_url)), '[]')
     FROM core.bills b
    WHERE b.bill_id IN (SELECT a.bill_id FROM core.member_bill_actions a JOIN m USING (member_id))) AS bills,
  (SELECT coalesce(jsonb_agg(r.vote_id ORDER BY r.vote_id), '[]') FROM core.roll_calls r WHERE r.chamber = 's') AS roll_calls;
