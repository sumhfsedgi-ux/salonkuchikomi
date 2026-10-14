-- ローカルの PostgreSQL で supabase/migrations を検証するための、Supabase の最小限の代わり。
-- 本番・テスト用の Supabase プロジェクトには適用しない(Supabase には最初からある)。
--   - ロール: anon / authenticated / service_role(service_role は RLS を通らない)
--   - auth スキーマ: auth.users・auth.sessions・auth.mfa_amr_claims と auth.uid() / auth.jwt()
--     (request.jwt.claim.sub / request.jwt.claims から読む。PostgREST と同じ形)。列は migration が読むものだけ。
--     実際の Supabase Auth の動き(セッション・認証方法の記録)は scripts/testdb で確かめる。
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end;
$$;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  email_confirmed_at timestamptz,
  encrypted_password text,
  last_sign_in_at timestamptz
);

-- Supabase Auth のセッション(サインアウトすると行が消える)と、セッションごとの認証方法(password / otp / invite など)。
create table if not exists auth.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  not_after timestamptz
);
create table if not exists auth.mfa_amr_claims (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references auth.sessions (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  authentication_method text not null,
  unique (session_id, authentication_method)
);

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select nullif(coalesce(current_setting('request.jwt.claim.sub', true), current_setting('request.jwt.claims', true)::jsonb ->> 'sub'), '')::uuid;
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;

create or replace function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb;
$$;
grant execute on function auth.jwt() to anon, authenticated, service_role;
