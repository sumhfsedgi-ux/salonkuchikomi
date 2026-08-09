-- Row Level Security for every table, plus a safe public view over `salons`.
--
-- Design summary (see plan doc for the full reasoning):
--  * profiles: owner can read/update only their own row.
--  * salons: NO public/anon policy at all (it holds owner_id, which must
--    never be exposed). Owner-only select/insert/update/delete.
--  * salon_public: a view exposing only the public-safe columns, created
--    WITHOUT security_invoker so it runs as the view owner and legitimately
--    bypasses the restrictive base-table RLS — the standard Postgres/Supabase
--    pattern for "publish a safe subset of a locked-down table".
--  * surveys / questions / question_options: two permissive select policies
--    each (Postgres ORs them) — one for "anyone, if the parent survey is
--    active", one for "the owner, regardless of active status" — plus
--    owner-only insert/update/delete via the ownership chain.
--  * survey_templates / template_questions / template_question_options:
--    authenticated-only select, no write policies for any client role
--    (only migrations/seed, which run as a role that bypasses RLS, write here).

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
alter table profiles enable row level security;

create policy select_own on profiles
  for select
  using (user_id = (select auth.uid()));

create policy update_own on profiles
  for update
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- salons (owner-only; no anon/authenticated public policy)
-- ---------------------------------------------------------------------------
alter table salons enable row level security;

create policy owner_select on salons
  for select
  using (owner_id = (select id from profiles where user_id = (select auth.uid())));

create policy owner_insert on salons
  for insert
  with check (owner_id = (select id from profiles where user_id = (select auth.uid())));

create policy owner_update on salons
  for update
  using (owner_id = (select id from profiles where user_id = (select auth.uid())))
  with check (owner_id = (select id from profiles where user_id = (select auth.uid())));

create policy owner_delete on salons
  for delete
  using (owner_id = (select id from profiles where user_id = (select auth.uid())));

-- Public-safe view: only id/name/slug/google_review_url/description, never
-- owner_id or timestamps. `security_invoker = false` (the default) is
-- specified explicitly so a future reader doesn't "fix" it to true and
-- silently break the public /review/[slug] lookup.
create view salon_public
with (security_invoker = false) as
select id, name, slug, google_review_url, description
from salons;

grant select on salon_public to anon, authenticated;

-- ---------------------------------------------------------------------------
-- surveys
-- ---------------------------------------------------------------------------
alter table surveys enable row level security;

create policy public_active_select on surveys
  for select
  using (is_active);

create policy owner_select on surveys
  for select
  using (
    exists (
      select 1 from salons s
      where s.id = surveys.salon_id
        and s.owner_id = (select id from profiles where user_id = (select auth.uid()))
    )
  );

create policy owner_insert on surveys
  for insert
  with check (
    exists (
      select 1 from salons s
      where s.id = surveys.salon_id
        and s.owner_id = (select id from profiles where user_id = (select auth.uid()))
    )
  );

create policy owner_update on surveys
  for update
  using (
    exists (
      select 1 from salons s
      where s.id = surveys.salon_id
        and s.owner_id = (select id from profiles where user_id = (select auth.uid()))
    )
  )
  with check (
    exists (
      select 1 from salons s
      where s.id = surveys.salon_id
        and s.owner_id = (select id from profiles where user_id = (select auth.uid()))
    )
  );

create policy owner_delete on surveys
  for delete
  using (
    exists (
      select 1 from salons s
      where s.id = surveys.salon_id
        and s.owner_id = (select id from profiles where user_id = (select auth.uid()))
    )
  );

-- ---------------------------------------------------------------------------
-- questions
-- ---------------------------------------------------------------------------
alter table questions enable row level security;

create policy public_active_select on questions
  for select
  using (
    exists (
      select 1 from surveys sv
      where sv.id = questions.survey_id and sv.is_active
    )
  );

create policy owner_select on questions
  for select
  using (
    exists (
      select 1 from surveys sv
      join salons s on s.id = sv.salon_id
      where sv.id = questions.survey_id
        and s.owner_id = (select id from profiles where user_id = (select auth.uid()))
    )
  );

create policy owner_insert on questions
  for insert
  with check (
    exists (
      select 1 from surveys sv
      join salons s on s.id = sv.salon_id
      where sv.id = questions.survey_id
        and s.owner_id = (select id from profiles where user_id = (select auth.uid()))
    )
  );

create policy owner_update on questions
  for update
  using (
    exists (
      select 1 from surveys sv
      join salons s on s.id = sv.salon_id
      where sv.id = questions.survey_id
        and s.owner_id = (select id from profiles where user_id = (select auth.uid()))
    )
  )
  with check (
    exists (
      select 1 from surveys sv
      join salons s on s.id = sv.salon_id
      where sv.id = questions.survey_id
        and s.owner_id = (select id from profiles where user_id = (select auth.uid()))
    )
  );

create policy owner_delete on questions
  for delete
  using (
    exists (
      select 1 from surveys sv
      join salons s on s.id = sv.salon_id
      where sv.id = questions.survey_id
        and s.owner_id = (select id from profiles where user_id = (select auth.uid()))
    )
  );

-- ---------------------------------------------------------------------------
-- question_options
-- ---------------------------------------------------------------------------
alter table question_options enable row level security;

create policy public_active_select on question_options
  for select
  using (
    exists (
      select 1 from questions q
      join surveys sv on sv.id = q.survey_id
      where q.id = question_options.question_id and sv.is_active
    )
  );

create policy owner_select on question_options
  for select
  using (
    exists (
      select 1 from questions q
      join surveys sv on sv.id = q.survey_id
      join salons s on s.id = sv.salon_id
      where q.id = question_options.question_id
        and s.owner_id = (select id from profiles where user_id = (select auth.uid()))
    )
  );

create policy owner_insert on question_options
  for insert
  with check (
    exists (
      select 1 from questions q
      join surveys sv on sv.id = q.survey_id
      join salons s on s.id = sv.salon_id
      where q.id = question_options.question_id
        and s.owner_id = (select id from profiles where user_id = (select auth.uid()))
    )
  );

create policy owner_update on question_options
  for update
  using (
    exists (
      select 1 from questions q
      join surveys sv on sv.id = q.survey_id
      join salons s on s.id = sv.salon_id
      where q.id = question_options.question_id
        and s.owner_id = (select id from profiles where user_id = (select auth.uid()))
    )
  )
  with check (
    exists (
      select 1 from questions q
      join surveys sv on sv.id = q.survey_id
      join salons s on s.id = sv.salon_id
      where q.id = question_options.question_id
        and s.owner_id = (select id from profiles where user_id = (select auth.uid()))
    )
  );

create policy owner_delete on question_options
  for delete
  using (
    exists (
      select 1 from questions q
      join surveys sv on sv.id = q.survey_id
      join salons s on s.id = sv.salon_id
      where q.id = question_options.question_id
        and s.owner_id = (select id from profiles where user_id = (select auth.uid()))
    )
  );

-- ---------------------------------------------------------------------------
-- survey_templates / template_questions / template_question_options
-- authenticated-only read; no client-facing write policy at all (seed/migrations
-- run as a role that bypasses RLS by nature).
-- ---------------------------------------------------------------------------
alter table survey_templates enable row level security;
create policy authenticated_select on survey_templates
  for select
  to authenticated
  using (true);

alter table template_questions enable row level security;
create policy authenticated_select on template_questions
  for select
  to authenticated
  using (true);

alter table template_question_options enable row level security;
create policy authenticated_select on template_question_options
  for select
  to authenticated
  using (true);
