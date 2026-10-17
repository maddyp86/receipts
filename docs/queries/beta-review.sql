-- ===========================================================================
-- Receipts beta review: the last 7 days of real queries, then NOT_DETERMINABLE
-- counted by reason. Run weekly in the Supabase SQL editor (as postgres).
--
-- "Real" = asked through the website: its session carries a browser user
-- agent. Eval and tool runs (npm run eval, replay, stability) call the pipeline
-- directly and have no user agent; curl / node sessions are developer smoke
-- tests. Halts, "not analysed yet" stops and "which way?" stops write no
-- app_queries row, so they are not here.
--
-- `typed` is what the reader typed. `checked_as` is set only when input
-- clean-up (ENABLE_QUERY_CLEANUP) restated a question as a statement: the
-- stored row holds the statement, and the original is read from the run's
-- REQUEST trace step (`rewritten_from`).
-- ===========================================================================
with real as (
  select q.created_at,
         coalesce(p.full_name, q.politician_id)          as senator,
         coalesce(req.rewritten_from, q.promise_text)    as typed,
         case when req.rewritten_from is not null then q.promise_text end as checked_as,
         q.result->'scored'->>'verdict'                  as verdict,
         q.result->'scored'->>'nd_reason'                as reason
    from app.app_queries q
    join app.app_sessions s on s.id = q.session_id
    left join mirror.mirror_politicians p on p.politician_id = q.politician_id
    left join lateral (
      select st.input->>'rewritten_from' as rewritten_from
        from app.app_query_trace_runs r
        join app.app_query_trace_steps st on st.run_id = r.run_id and st.stage = 'REQUEST'
       where r.query_id = q.id
       order by st.seq
       limit 1
    ) req on true
   where q.created_at >= now() - interval '7 days'
     and s.user_agent is not null
     and s.user_agent !~* '^(curl|node|python|wget|go-http)'
)
select 'query' as section, created_at, senator, typed, checked_as, verdict, reason, null::bigint as n
  from real
union all
select 'not determinable, by reason', null, null, null, null, 'NOT_DETERMINABLE', coalesce(reason, '(none)'), count(*)
  from real
 where verdict = 'NOT_DETERMINABLE'
 group by reason
order by section desc, created_at desc nulls last, n desc;
