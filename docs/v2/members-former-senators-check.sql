-- READ-ONLY check for the members workflow adding former senators.
-- Before: what core.member_bill_actions holds for the 17 former senators now.
-- After: the view's vote join with the rows the workflow would insert (LIS ids
-- from legislators-historical; these members have no core.members row today).
-- 'VP' stays unjoined: it is the Vice President's tie-break, not a member.
-- Result on 14 Oct 2026: before 0 rows for all 17; after, every stored
-- position joined: 1,153 roll calls over 16 senators (Rubio 86, Vance 84,
-- the 2024 retirees 83 each, Menendez 75, Butler 48, Feinstein 28, Helmy 2).
-- Sasse has a row but no stored position (he left on 8 Jan 2023).
with added(member_id, lis_id) as (values
  ('S001197', 'S382'), ('F000062', 'S221'), ('M000639', 'S306'), ('B001320', 'S424'),
  ('H001097', 'S425'), ('B000944', 'S307'), ('C000141', 'S308'), ('C000174', 'S277'),
  ('C001070', 'S309'), ('S000770', 'S284'), ('T000464', 'S314'), ('M001183', 'S338'),
  ('S001191', 'S403'), ('B001310', 'S397'), ('R000615', 'S401'), ('V000137', 'S421'),
  ('R000595', 'S350')),
members_after as (
  select member_id, lis_id from core.members
  union all
  select member_id, lis_id from added where member_id not in (select member_id from core.members)
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
  from bill_votes_after where member_id in (select member_id from added) group by 1
),
before as (
  select member_id, count(*) filter (where vote is not null) as bills_with_vote, count(*) as all_rows
  from core.member_bill_actions where member_id in (select member_id from added) group by 1
)
select a0.member_id, a0.lis_id,
  exists (select 1 from core.members m where m.member_id = a0.member_id) as row_exists_now,
  coalesce(b.all_rows, 0) as before_rows, coalesce(b.bills_with_vote, 0) as before_bills_with_vote,
  coalesce(a.bills_with_vote, 0) as after_bills_with_vote, coalesce(a.roll_calls, 0) as after_roll_calls,
  (select count(*) from core.member_votes where voter_id = a0.lis_id) as positions_stored
from added a0 left join before b using (member_id) left join after a using (member_id)
order by positions_stored desc, 1;
