-- Lets an owner throw away their current survey's questions and start over
-- from a (possibly different) template, without ever having zero active
-- surveys in between. SECURITY INVOKER, same as create_survey_from_template:
-- the deactivate-update and the insert are both still subject to the
-- owner_update/owner_insert RLS policies on surveys/questions/question_options,
-- so a caller can only ever restart a survey under a salon they actually own.
--
-- The previous survey row (and its questions/options) is kept, just marked
-- is_active = false, rather than deleted -- cheap to keep, and avoids a
-- destructive cascade delete for what is otherwise a routine "start over"
-- action. It is not exposed anywhere in the admin UI though, so from the
-- owner's point of view the old content is gone for good.

create function restart_survey_from_template(
  p_salon_id uuid,
  p_template_id uuid,
  p_survey_name text default '口コミアンケート'
)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_survey_id uuid;
  v_question_id uuid;
  tq record;
  opt record;
begin
  update surveys
  set is_active = false, updated_at = now()
  where salon_id = p_salon_id and is_active = true;

  insert into surveys (salon_id, name, is_active)
  values (p_salon_id, p_survey_name, true)
  returning id into v_survey_id;

  if p_template_id is not null then
    for tq in
      select * from template_questions
      where template_id = p_template_id
      order by sort_order
    loop
      insert into questions (survey_id, question_text, question_type, required, max_selections, sort_order)
      values (v_survey_id, tq.question_text, tq.question_type, tq.required, tq.max_selections, tq.sort_order)
      returning id into v_question_id;

      for opt in
        select * from template_question_options
        where template_question_id = tq.id
        order by sort_order
      loop
        insert into question_options (question_id, option_text, sort_order)
        values (v_question_id, opt.option_text, opt.sort_order);
      end loop;
    end loop;
  end if;

  return v_survey_id;
end;
$$;
