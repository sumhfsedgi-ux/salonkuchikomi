-- Replaces a survey's entire question/option tree in one call. Used by the
-- admin question editor, which now keeps every add/delete/reorder/edit as
-- local-only state and only touches the database once, when the owner
-- presses "変更を保存" -- previously each of those interactions was its own
-- round trip, which made routine editing feel slow.
--
-- Nothing else in the schema references a specific questions.id or
-- question_options.id (customer answers are never persisted -- they go
-- straight to OpenAI and back), so a full delete-and-reinsert per save is
-- safe and much simpler than diffing against the previous rows.
--
-- SECURITY INVOKER: the delete is scoped by the caller's own owner_delete
-- RLS policy on `questions` (rows they don't own simply won't be deleted),
-- and every insert is subject to the owner_insert policies on
-- questions/question_options, so a caller can only ever replace the
-- questions of a survey under a salon they actually own.

create function save_survey_questions(p_survey_id uuid, p_questions jsonb)
returns void
language plpgsql
security invoker
as $$
declare
  q jsonb;
  opt jsonb;
  v_question_id uuid;
  v_question_sort integer := 0;
  v_option_sort integer;
begin
  delete from questions where survey_id = p_survey_id;

  for q in select * from jsonb_array_elements(p_questions)
  loop
    insert into questions (survey_id, question_text, question_type, required, max_selections, sort_order)
    values (
      p_survey_id,
      q->>'question_text',
      q->>'question_type',
      coalesce((q->>'required')::boolean, true),
      nullif(q->>'max_selections', '')::integer,
      v_question_sort
    )
    returning id into v_question_id;

    v_option_sort := 0;
    for opt in select * from jsonb_array_elements(coalesce(q->'options', '[]'::jsonb))
    loop
      insert into question_options (question_id, option_text, sort_order)
      values (v_question_id, opt->>'option_text', v_option_sort);
      v_option_sort := v_option_sort + 1;
    end loop;

    v_question_sort := v_question_sort + 1;
  end loop;
end;
$$;
