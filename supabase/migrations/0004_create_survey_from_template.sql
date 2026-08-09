-- Copies a template's questions/options into a brand-new survey owned by
-- the caller's salon. SECURITY INVOKER (the default, stated explicitly) so
-- every insert here is still subject to the owner_insert RLS policies on
-- surveys/questions/question_options — a caller can only ever create a
-- survey under a salon they actually own, and the whole call is one
-- transaction (atomic: either the full copy succeeds, or nothing is created).
--
-- p_template_id = null means "0から作成" — create an empty active survey
-- with no questions, ready for the owner to add questions manually.

create function create_survey_from_template(
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
