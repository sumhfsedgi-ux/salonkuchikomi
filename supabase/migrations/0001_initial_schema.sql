-- Core multi-tenant schema: owners (profiles), their salons, each salon's
-- live survey (questions/options), and a separate template library that
-- salons copy from once (never reference live).

create extension if not exists pgcrypto;

create table profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

create table salons (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  slug text not null unique check (
    slug ~ '^[a-z0-9-]+$' and char_length(slug) between 1 and 60
  ),
  google_review_url text,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index salons_owner_id_idx on salons (owner_id);

create table surveys (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references salons (id) on delete cascade,
  name text not null default '口コミアンケート',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index surveys_salon_id_idx on surveys (salon_id);
-- At most one active survey per salon at a time — the public review page
-- and getCurrentSalon()-style queries both assume a single "the" active survey.
create unique index surveys_one_active_per_salon on surveys (salon_id) where is_active;

create table questions (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references surveys (id) on delete cascade,
  question_text text not null check (char_length(question_text) between 1 and 200),
  question_type text not null check (question_type in ('single', 'multiple', 'text')),
  required boolean not null default true,
  max_selections integer check (max_selections is null or max_selections between 1 and 10),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index questions_survey_id_sort_order_idx on questions (survey_id, sort_order);

create table question_options (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references questions (id) on delete cascade,
  option_text text not null check (char_length(option_text) between 1 and 100),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index question_options_question_id_sort_order_idx on question_options (question_id, sort_order);

create table survey_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  -- Stable machine key used by seed.sql for idempotent upserts.
  category text not null unique,
  description text,
  created_at timestamptz not null default now()
);

create table template_questions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references survey_templates (id) on delete cascade,
  question_text text not null,
  question_type text not null check (question_type in ('single', 'multiple', 'text')),
  required boolean not null default true,
  max_selections integer,
  sort_order integer not null default 0
);
create index template_questions_template_id_sort_order_idx on template_questions (template_id, sort_order);

create table template_question_options (
  id uuid primary key default gen_random_uuid(),
  template_question_id uuid not null references template_questions (id) on delete cascade,
  option_text text not null,
  sort_order integer not null default 0
);
create index template_question_options_tq_id_sort_order_idx on template_question_options (template_question_id, sort_order);
