-- Migration 020: record questions (2026-10-15)
--
-- A voter's question about what a senator did ("Did they vote to extend the
-- enhanced ACA tax credits?") is answered from the record with a label, never
-- graded as the senator's own statement. Its query row says so:
--
--   input_kind    STATEMENT (every row before this) or RECORD_QUESTION
--   answer_label  the record answer (VOTED_FOR …), only on a record question
--   provenance    gains 'voter_question': nothing is attributed to the senator
--   statement_type is NULL on a record question (there is no statement)
--   verdict, band  are NULL on a record question (nothing is graded)
--
-- The firewall is unchanged: app_queries is walled off from the corpus, and a
-- stored record question is never evidence about a senator, exactly like a
-- stored statement.
--
-- Additive and safe to run with the old code live: every existing row is a
-- STATEMENT, and the old code never writes the new columns.

begin;

alter table app.app_queries
  add column if not exists input_kind text not null default 'STATEMENT',
  add column if not exists answer_label text;

alter table app.app_queries
  add constraint app_queries_input_kind_chk
    check (input_kind in ('STATEMENT', 'RECORD_QUESTION')),
  add constraint app_queries_answer_label_chk
    check (answer_label is null or answer_label in (
      'VOTED_FOR', 'VOTED_AGAINST', 'MIXED_RECORD', 'SPONSORSHIP_ONLY',
      'ONLY_BROAD_VOTES', 'NO_RECORDED_ACTION_FOUND'));

alter table app.app_queries drop constraint app_queries_provenance_chk;
alter table app.app_queries
  add constraint app_queries_provenance_chk
    check (provenance in ('default', 'corpus', 'asserted', 'voter_question'));

alter table app.app_queries alter column statement_type drop not null;

-- A record question carries no statement and no grade; a statement carries no
-- answer label. Each kind is held to its own shape.
alter table app.app_queries
  add constraint app_queries_kind_shape_chk check (
    (input_kind = 'STATEMENT' and statement_type is not null and provenance <> 'voter_question' and answer_label is null)
    or
    (input_kind = 'RECORD_QUESTION' and statement_type is null and provenance = 'voter_question'
       and verdict is null and band is null and answer_label is not null)
  );

commit;
