-- ===========================================================================
-- Migration 023: reversal target fields that read backwards (31 Oct 2026).
--
-- Why: s2556-119 repeals the OBBBA health subtitle. Its own summary says the
-- bill removes the 400% cap on ACA premium tax credits and lowers the
-- applicable percentages, so it expands the credits. Its target_effect said
-- the TARGET "Expanded eligibility ... by removing the 400% income cap". The
-- evaluator read "repealing an expansion" as a cut, and Ossoff's
-- co-sponsorship counted against extending the credits (trace 9b534012).
--
-- An audit of all 419 rows with reverses_existing_policy and a target_effect
-- found 64 like it, in three kinds. Each is fixed the least-inventive way:
--
--   A. 47 rows that are not reversals at all: amendments that ADD something
--      ("require proof of citizenship"), appropriations, CRs, debt-limit
--      suspensions. target_effect restated the bill's own change as what
--      "existing law" did. Fix: not a reversal. The evaluator then reads the
--      bill's own intended effects, which were right all along.
--   B. 15 real repeals, disapprovals, terminations and rescissions whose
--      target_effect gave the target the bill's own effect. Fix: a target
--      sentence that is the inverse of what the row itself says the bill does,
--      or a well-documented fact about the named target. Where neither is
--      safe, target_effect is cleared: the evaluator prompt then returns
--      NEUTRAL rather than guess, which is what it is for.
--   C. 2 rows whose summary and intended effects are themselves inverted.
--      Fix: flagged_for_review, which already stops their direction being
--      trusted (evaluation/summaryReview.ts). They need a regenerated
--      statement, not a field patch.
--
-- The originals are kept in core.bill_impacts_fix_023 for review or rollback:
--   update core.bill_impacts i set reverses_existing_policy = b.reverses_existing_policy,
--     target_type = b.target_type, target_name = b.target_name, target_source = b.target_source,
--     target_effect = b.target_effect, flagged_for_review = b.flagged_for_review
--   from core.bill_impacts_fix_023 b where b.impact_id = i.impact_id;
-- ===========================================================================

begin;

create table if not exists core.bill_impacts_fix_023 as
select impact_id, bill_id, version_code, reverses_existing_policy, target_type, target_name,
       target_source, target_effect, flagged_for_review, now() as saved_at
from core.bill_impacts
where impact_id in (
  -- A
  '0GYXMO','0ZX1XG','10TPG2','1GAFLD','1RRN83','1TKBXT','30648X','3U7PVG','4376EM','4JXWZT',
  '4Y8ACB','5YV7Y9','72M66Q','9PY5R0','9RI7BS','BH7QI4','CA6J53','DFJ88L','PB59LU','QO9KFY',
  'QRID66','QX3NVX','R6D4BB','SD3BFJ','SGZ4F1','TAZ7PY','TTY2NL','VFI0OQ','VJV1JH','WR5WFY',
  'XB8O1O','Y5FRBJ','YP3ICV','YQDZRM','ZLNP6P','E4QWHY','EYYPMY','E94186','FSEVZ2','HBOB1W',
  'I1T3X5','JMOKOL','K0XZ9X','LRSAP2','O1V6QQ','OYDJNZ','DA9MI4',
  -- B
  'CPAEOB','08ZLQ8','15MDTRO177','15ME4P017B','JKOGZ4','16AR2PU11D','W373FOMKUI','G1F95OW40Q',
  '756M0B1FML','BT1JPP2WYK','NKX4ZCCL63','1XXN8M8CXX','OH83L5','9V0ZHEYZRZ','FLC4M1112S',
  -- C
  'H1IL0Y','J86UA12SYI'
);

-- A. Not reversals.
update core.bill_impacts
set reverses_existing_policy = false, target_type = 'NONE',
    target_name = null, target_source = null, target_effect = null
where impact_id in (
  '0GYXMO','0ZX1XG','10TPG2','1GAFLD','1RRN83','1TKBXT','30648X','3U7PVG','4376EM','4JXWZT',
  '4Y8ACB','5YV7Y9','72M66Q','9PY5R0','9RI7BS','BH7QI4','CA6J53','DFJ88L','PB59LU','QO9KFY',
  'QRID66','QX3NVX','R6D4BB','SD3BFJ','SGZ4F1','TAZ7PY','TTY2NL','VFI0OQ','VJV1JH','WR5WFY',
  'XB8O1O','Y5FRBJ','YP3ICV','YQDZRM','ZLNP6P','E4QWHY','EYYPMY','E94186','FSEVZ2','HBOB1W',
  'I1T3X5','JMOKOL','K0XZ9X','LRSAP2','O1V6QQ','OYDJNZ','DA9MI4'
);

-- B. Real reversals: what the target did, the right way round.
update core.bill_impacts set target_effect = v.effect
from (values
  -- s2556-119, the Ossoff case. The inverse of the row's own summary.
  ('CPAEOB', 'Left eligibility for ACA premium tax credits capped at 400% of the federal poverty level, with higher applicable percentages than this bill sets.'),
  -- Rescissions: the target appropriations provided the money the bill takes back.
  ('08ZLQ8', 'Provided funding for energy efficiency and renewable energy improvements at public school facilities.'),
  ('15MDTRO177', 'Provided budget authority for international organizations, peacekeeping, global health, migration and refugee assistance, development assistance, economic support, public broadcasting, and related accounts.'),
  ('15ME4P017B', 'Provided budget authority in multiple appropriations accounts, including foreign assistance, global health, migration and refugee assistance, USAID operating expenses, the United States Institute of Peace, and the Corporation for Public Broadcasting.'),
  ('JKOGZ4', 'Provided budget authority for State Department contributions to international organizations and international peacekeeping, USAID global health and migration assistance programs, and the Corporation for Public Broadcasting.'),
  -- National emergencies the resolutions terminate: the targets declared them.
  ('16AR2PU11D', 'Declared a national emergency used as the basis for imposing additional duties on articles imported from Canada.'),
  ('W373FOMKUI', 'Declared a national emergency concerning the COVID-19 outbreak on March 13, 2020, under the National Emergencies Act.'),
  ('G1F95OW40Q', 'Declared a national emergency concerning the COVID-19 outbreak on March 13, 2020, under the National Emergencies Act.'),
  -- War powers: the target is the hostilities themselves.
  ('756M0B1FML', 'Used United States Armed Forces in hostilities within or against Venezuela without a declaration of war or specific statutory authorization.'),
  -- CRA disapprovals with a well-documented target.
  ('BT1JPP2WYK', 'Exempted covered solar cells and modules from Cambodia, Malaysia, Thailand, and Vietnam from antidumping and countervailing duty cash deposits and suspension of liquidation during the Proclamation 10414 emergency period.'),
  ('NKX4ZCCL63', 'Amended the Buffalo Field Office resource management plan to make federal coal in the planning area unavailable for further coal leasing.'),
  ('1XXN8M8CXX', 'Rescinded the 1971 Richardson Waiver, ending the Department of Health and Human Services'' voluntary use of notice-and-comment rulemaking for matters involving grants, benefits, contracts, loans, and public property.'),
  ('OH83L5', 'Rescinded the 1971 Richardson Waiver, ending the Department of Health and Human Services'' voluntary use of notice-and-comment rulemaking for matters involving grants, benefits, contracts, loans, and public property.')
) as v(id, effect)
where impact_id = v.id;

-- B. Real reversals whose target cannot be stated safely from the row: cleared.
update core.bill_impacts set target_effect = null
where impact_id in ('9V0ZHEYZRZ', 'FLC4M1112S');

-- C. Summary and intended effects inverted too: not to be trusted until regenerated.
update core.bill_impacts set flagged_for_review = true
where impact_id in ('H1IL0Y', 'J86UA12SYI');

commit;
