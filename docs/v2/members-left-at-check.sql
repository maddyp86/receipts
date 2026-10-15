-- READ-ONLY check for migration 017 and the members workflow change.
-- Before: what core.member_bill_actions holds for Graham and Mullin now.
-- After: the view's vote join with the LIS ids the workflow would fill
-- (from legislators-historical; they are blank in core.members).
-- Result on 14 Oct 2026: before 0 and 0 rows; after 127 bills (211 roll calls)
-- for G000359 and 121 bills (199 roll calls) for M001190, every stored
-- position joined.
with fill(member_id, lis_id) as (values ('G000359', 'S293'), ('M001190', 'S419')),
members_after as (
  select m.member_id, coalesce(m.lis_id, f.lis_id) as lis_id
  from core.members m left join fill f using (member_id)
),
bill_votes_after as (
  select ma.member_id, rc.bill_id, rc.vote_id
  from core.roll_calls rc
  join core.member_votes mv on mv.vote_id = rc.vote_id
  join members_after ma on ma.lis_id = mv.voter_id
  where rc.chamber = 's' and rc.category in ('passage', 'cloture')
    and rc.bill_type in ('hr', 'hres', 'hjres', 'hconres', 's', 'sres', 'sjres', 'sconres')
    and rc.bill_id is not null
),
after as (
  select member_id, count(distinct bill_id) as bills_with_vote, count(distinct vote_id) as roll_calls
  from bill_votes_after where member_id in (select member_id from fill) group by 1
),
before as (
  select member_id, count(*) filter (where vote is not null) as bills_with_vote, count(*) as all_rows
  from core.member_bill_actions where member_id in (select member_id from fill) group by 1
)
select f.member_id, f.lis_id,
  coalesce(b.all_rows, 0) as before_rows, coalesce(b.bills_with_vote, 0) as before_bills_with_vote,
  coalesce(a.bills_with_vote, 0) as after_bills_with_vote, coalesce(a.roll_calls, 0) as after_roll_calls,
  (select count(*) from core.member_votes where voter_id = f.lis_id) as positions_stored
from fill f left join before b using (member_id) left join after a using (member_id)
order by 1;
