-- ============================================================================
-- Migration 007 — drop the corpus verdict mirrors
--
-- Run as `postgres` AFTER 006. Idempotent.
--
-- DECISION (Matt, 2026-09-07): these two tables are not relevant to the query
-- tool. It emits its own verdicts in real time from the user's query — it never
-- reads a stored one. That is the product, not an implementation detail.
--
-- Migration 005 revoked receipts_app on both, which made reading them fail on
-- privilege. This goes further and removes them, because a revoke is one GRANT
-- away from being undone by someone tidying permissions, and the tables have no
-- consumer to justify the risk. Belt and braces rather than belt.
--
-- The enrichment mirror stays: donor alignment, party positions, impact
-- statements, roll call results. Those the query tool genuinely reads.
--
-- ⚠ THE SYNC MUST ALSO STOP WRITING THEM. Dropping the tables here does not
-- change the n8n sync set; if the sync still lists them it will recreate them on
-- its next run and quietly reopen what this closes. Remove them there too.
-- ============================================================================

do $drop_corpus_mirrors$
declare
  n bigint;
begin
  if to_regclass('mirror.mirror_promise_alignment_matches') is not null then
    execute 'select count(*) from mirror.mirror_promise_alignment_matches' into n;
    raise notice 'dropping mirror_promise_alignment_matches (% rows)', n;
    execute 'drop table mirror.mirror_promise_alignment_matches';
  else
    raise notice 'mirror_promise_alignment_matches absent — nothing to drop';
  end if;

  if to_regclass('mirror.mirror_decision_scores') is not null then
    execute 'select count(*) from mirror.mirror_decision_scores' into n;
    raise notice 'dropping mirror_decision_scores (% rows)', n;
    execute 'drop table mirror.mirror_decision_scores';
  else
    raise notice 'mirror_decision_scores absent — nothing to drop';
  end if;
end
$drop_corpus_mirrors$;

comment on schema mirror is
  'Read replica of the Google Sheets pipeline tables, for ENRICHMENT only — '
  'donor alignment, party positions, impact statements, roll call results. '
  'Corpus VERDICTS (Promise Alignment - Matches, Decision Scores) are '
  'deliberately absent: the query tool evaluates fresh and never reads a stored '
  'verdict. Do not add them back without revisiting migration 007.';


-- ---------------------------------------------------------------------------
-- VERIFY — expect the two corpus tables absent, the enrichment tables present.
-- ---------------------------------------------------------------------------
select table_name
from information_schema.tables
where table_schema = 'mirror'
order by table_name;
