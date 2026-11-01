-- ===========================================================================
-- Receipts activation funnel, per day, from app.app_funnel_events (migration
-- 025). Run as postgres in the Supabase SQL editor.
--
-- One row per day and starting source. Each step counts SESSIONS (tabs) that
-- reached it, so every column is a subset of the one before:
--
--   landed      opened the page
--   asked       asked at least one question
--   answered    saw a real answer: a verdict or a record label, not a
--               "can't tell" (ND_*) or "nothing found"
--   activated   asked at least one follow-up after an answer  ← the metric
--   repeat      asked a second question in the same tab
--
-- `source` is how the tab's FIRST question started: a landing-page starter or
-- typed. Tabs that landed and never asked are under source 'none'.
-- ===========================================================================
with s as (
  select session_key,
         min(created_at)::date as day,
         bool_or(event = 'landing_view')                                           as landed,
         bool_or(event = 'query_submitted')                                        as asked,
         bool_or(event = 'result_shown'
                 and props->>'outcome' !~ '^ND_'
                 and props->>'outcome' <> 'NO_RECORDED_ACTION_FOUND')              as answered,
         bool_or(event = 'followup_asked')                                         as activated,
         max((props->>'nth')::int) filter (where event = 'query_submitted') >= 2   as repeat,
         (array_agg(props->>'source' order by created_at)
            filter (where event = 'query_submitted'))[1]                           as source
    from app.app_funnel_events
   where created_at >= now() - interval '30 days'
   group by session_key
)
select day,
       coalesce(source, 'none')                                   as source,
       count(*) filter (where landed)                             as landed,
       count(*) filter (where asked)                              as asked,
       count(*) filter (where answered)                           as answered,
       count(*) filter (where activated)                          as activated,
       count(*) filter (where repeat)                             as repeat,
       round(100.0 * count(*) filter (where asked)     / nullif(count(*) filter (where landed), 0), 1)   as pct_asked,
       round(100.0 * count(*) filter (where answered)  / nullif(count(*) filter (where asked), 0), 1)    as pct_answered,
       round(100.0 * count(*) filter (where activated) / nullif(count(*) filter (where answered), 0), 1) as pct_activated
  from s
 group by day, coalesce(source, 'none')
 order by day desc, source;
