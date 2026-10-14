-- お客様の新規登録・運営によるサロン登録と招待・利用区分(利用開始待ち/無償提供/テスト店舗)・本人確認とセッション。
-- 計画: docs/plans/salon-onboarding-plan.md / 本番の手順: docs/plans/salon-onboarding-runbook.md
--
-- 0001〜0024 は本番適用済みのため一切書き換えない(作り直す関数・ポリシーは、ここで作り直す)。
--
-- 【適用の仕方と途中の失敗】
--   - SQL Editor では、このファイル全体を1回で実行する(範囲を選んで一部だけ実行しない)。SQL Editor は複数の文を
--     1回の単純クエリとして送るため、全体が1つの暗黙のトランザクションになり、途中で失敗すると何も残らない
--     (testdb で同じ実行方式で確かめる)。ファイルの中には begin / commit を書かない(testdb の適用の道具が自分で
--     トランザクションを張るため)。
--   - 初回だけ行う処理(列の追加・既存店舗の無償提供・既定値の切り替え・既存店舗の履歴・既存アカウントの legacy の記録)は、
--     1つの DO ブロック(1つの文)にまとめ、「列がまだ無いか」で判定する。文の途中で失敗すると全体が戻る。
--   - それ以外は、何度実行しても同じ結果になる文だけにする(create or replace / drop ... if exists のあとに作る /
--     on conflict do nothing)。万一、文ごとに実行されて途中で止まっても、ファイル全体をもう一度実行すれば同じ最終状態になる。
--   - 0025 のあとに 0011・0023・0024 を単独で再実行しない(作り直した関数・ポリシーが古い形に戻る)。再実行したら 0025 も再実行する。
--
-- 【分けて管理するもの】
--   ログイン・本人確認 ........ auth.users(Supabase)と account_verifications(本人確認の記録)。
--                               信頼できるのは、本人確認のあとのセッションだけ(current_session_trusted)。
--   店舗の登録 ................ salons の行がある(registration_source: existing / self_signup / operator)。
--   サービスの利用 ............ salons.service_status(pending=利用開始待ち / complimentary=無償提供 / test=テスト店舗)。
--                               salon_feature_access の結果に「利用中の区分である」ことを最後に AND する。
--                               プラン・提供状態・個別設定・権限による停止・稼働状態は、これまでどおり別に管理する。

select set_config('lock_timeout', '10s', true);

-- ------------------------------------------------------------------
-- 1. 本人確認の記録(アカウント単位)。セッション単位の判定は 4 の current_session_trusted で行う。
-- ------------------------------------------------------------------

-- 本人確認の記録。書けるのは service_role だけ(記録の関数 account_verification_record・移行)。
--   legacy ............. 0025 の適用時点で、メールが確認済みだったアカウント・店舗の所有者
--   password_confirmed . メールのリンクで得たセッションで、本人が登録したパスワードを入れ直した
--   password_set ....... メールのリンクで得たセッションで、本人が新しいパスワードを設定した
create table if not exists public.account_verifications (
  user_id uuid primary key references auth.users (id) on delete cascade,
  verified_at timestamptz not null default now(),
  -- 本人確認を行ったセッション(legacy は null)。このセッションと、verified_at 以降に作られたセッションだけを信頼する。
  verified_session_id uuid,
  method text not null check (method in ('legacy', 'password_confirmed', 'password_set')),
  check ((method = 'legacy') = (verified_session_id is null))
);

-- 本人確認の手続きで求めること。行が無いときは set_new として扱う。
--   confirm_or_set ... 登録したパスワードを入れ直すか、新しく設定する(自分の画面で、アカウントが無い状態から新しく登録したとき)
--   set_new .......... 新しく設定する(それ以外。運営の招待・紐付け、未確認のアドレスでの再登録、API から直接作られたアカウントなど)
create table if not exists public.account_verification_requirements (
  user_id uuid primary key references auth.users (id) on delete cascade,
  mode text not null check (mode in ('confirm_or_set', 'set_new')),
  reason text not null check (reason in ('self_signup', 'self_signup_repeat', 'operator_invite', 'operator_rebind')),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------------
-- 2. 初回だけ行う処理(1つの文。途中で失敗すると全体が戻る)
-- ------------------------------------------------------------------
-- 列を足すときの既定値で既存の行を埋める(行の書き換え・トリガーは起きない)。直後に既定値を新しい店舗用に切り替える。
-- 移行の対象(この時点で存在する店舗・アカウント)は、操作履歴・本人確認の記録に残す。再実行では何もしない。
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'salons' and column_name = 'service_status') then
    return;
  end if;

  alter table public.salons add column service_status text not null default 'complimentary';
  alter table public.salons alter column service_status set default 'pending';
  alter table public.salons add column registration_source text not null default 'existing';
  alter table public.salons alter column registration_source set default 'self_signup';

  insert into public.operator_audit_log (salon_id, actor_kind, actor_label, target, before, after, note)
  select s.id, 'sql', 'migration:0025', 'service_status', null, to_jsonb('complimentary'::text),
         '0025 の適用時点で存在した店舗を、無償提供として移行'
    from public.salons s
   order by s.created_at, s.id;

  insert into public.account_verifications (user_id, verified_at, method)
  select u.id, now(), 'legacy'
    from auth.users u
   where u.email_confirmed_at is not null
      or exists (select 1 from public.profiles p join public.salons s on s.owner_id = p.id where p.user_id = u.id)
  on conflict (user_id) do nothing;
end;
$$;

-- ------------------------------------------------------------------
-- 3. salons の列(連絡先)と制約
-- ------------------------------------------------------------------
alter table public.salons add column if not exists contact_name text;
-- null = ログイン用のメールアドレスと同じ
alter table public.salons add column if not exists contact_email text;
alter table public.salons add column if not exists contact_phone text;

alter table public.salons drop constraint if exists salons_service_status_check;
alter table public.salons add constraint salons_service_status_check
  check (service_status in ('pending', 'complimentary', 'test'));
alter table public.salons drop constraint if exists salons_registration_source_check;
alter table public.salons add constraint salons_registration_source_check
  check (registration_source in ('existing', 'self_signup', 'operator'));
alter table public.salons drop constraint if exists salons_contact_name_check;
alter table public.salons add constraint salons_contact_name_check
  check (contact_name is null or char_length(btrim(contact_name)) between 1 and 100);
alter table public.salons drop constraint if exists salons_contact_email_check;
alter table public.salons add constraint salons_contact_email_check
  check (contact_email is null or (char_length(contact_email) <= 254 and contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'));
alter table public.salons drop constraint if exists salons_contact_phone_check;
alter table public.salons add constraint salons_contact_phone_check
  check (contact_phone is null or (char_length(contact_phone) between 1 and 30 and contact_phone ~ '^[0-9+() -]+$'));

-- 操作履歴に「お客様による操作」(自分の店舗の登録)を足す。
alter table public.operator_audit_log drop constraint if exists operator_audit_log_actor_kind_check;
alter table public.operator_audit_log add constraint operator_audit_log_actor_kind_check
  check (actor_kind in ('operator', 'cli', 'sql', 'system', 'owner'));

-- ------------------------------------------------------------------
-- 4. セッションの信頼と、オーナーが使える店舗
-- ------------------------------------------------------------------

-- 利用中の区分か(将来の決済の状態はここに足す)。
create or replace function public.salon_service_active(p_status text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_status in ('complimentary', 'test'), false);
$$;

-- 今のリクエストの JWT のセッション(PostgREST が request.jwt.claims に入れる)。読めなければ null。
create or replace function public.current_session_id()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_text text;
begin
  v_text := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id';
  if v_text is null or v_text !~ '^[0-9a-fA-F-]{36}$' then
    return null;
  end if;
  return v_text::uuid;
exception when others then
  return null;
end;
$$;

-- そのセッションが、メールのリンク(招待・確認・Magic Link・パスワード再設定)で認証したものか。
-- Supabase Auth はセッションごとの認証方法を auth.mfa_amr_claims に記録する。パスワードでのログインは password。
create or replace function public.session_has_email_link(p_session_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from auth.sessions s
      join auth.mfa_amr_claims c on c.session_id = s.id
     where s.id = p_session_id
       and s.user_id = p_user_id
       and (s.not_after is null or s.not_after > now())
       and c.authentication_method in ('otp', 'magiclink', 'recovery', 'invite', 'email/signup')
  );
$$;

-- 今のリクエストのセッションを信頼してよいか。次のすべてを満たすときだけ true。
--   1. JWT の session_id の行が auth.sessions にあり、本人のもので、期限(not_after)を過ぎていない
--      → サインアウト・削除されたセッションの、期限内の古いアクセストークンを即座に拒否する
--   2. アカウントに本人確認の記録がある
--   3. legacy / 本人確認を行ったセッションそのもの / 本人確認のあとに作られたセッション のどれか
--      → 本人確認より前に作られた(第三者の可能性がある)セッションは、本人確認のあとも信頼しない
create or replace function public.current_session_trusted()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select true
      from auth.sessions s
      join public.account_verifications v on v.user_id = s.user_id
     where s.id = public.current_session_id()
       and s.user_id = auth.uid()
       and (s.not_after is null or s.not_after > now())
       and (v.method = 'legacy' or s.id = v.verified_session_id or s.created_at >= v.verified_at)
     limit 1
  ), false);
$$;

-- 今のセッションで、オーナーとして読み書きしてよい店舗。
--   owner_salon_ids ............ 信頼できるセッションの所有者(利用開始待ちでも、登録内容の確認・修正のために読める)
--   owner_active_salon_ids ..... さらに利用中の区分
--   owner_feature_salon_ids .... さらにその機能を使える(salon_feature_entitled: 区分・プラン・提供状態・個別設定)
create or replace function public.owner_salon_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id
    from public.salons s
    join public.profiles p on p.id = s.owner_id
   where p.user_id = auth.uid()
     and public.current_session_trusted();
$$;

create or replace function public.owner_active_salon_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id
    from public.salons s
    join public.profiles p on p.id = s.owner_id
   where p.user_id = auth.uid()
     and public.salon_service_active(s.service_status)
     and public.current_session_trusted();
$$;

create or replace function public.owner_feature_salon_ids(p_feature_key text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id
    from public.salons s
    join public.profiles p on p.id = s.owner_id
   where p.user_id = auth.uid()
     and public.current_session_trusted()
     and public.salon_feature_entitled(s.id, p_feature_key);
$$;

-- アプリ(画面・Server Action)が今のリクエストの状態を読む。返すのは本人の分だけで、トークン・パスワードは返さない。
create or replace function public.my_account_state()
returns table (
  email_confirmed boolean, verified boolean, verification_mode text, session_trusted boolean,
  email_link_session boolean, is_operator boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select u.email_confirmed_at is not null,
         v.user_id is not null,
         coalesce(r.mode, 'set_new'),
         public.current_session_trusted(),
         public.session_has_email_link(public.current_session_id(), u.id),
         public.operator_is_active(u.id)
    from auth.users u
    left join public.account_verifications v on v.user_id = u.id
    left join public.account_verification_requirements r on r.user_id = u.id
   where u.id = auth.uid();
$$;

-- ------------------------------------------------------------------
-- 5. 本人確認の記録・要件(service_role だけ。アプリのサーバーの Action が、本人の操作を確かめてから呼ぶ)
-- ------------------------------------------------------------------

-- 本人確認を記録する。DB でも次を確かめる: メールが確認済み / セッションが本人のもので有効 / メールのリンクで認証したセッション。
-- 最初の1回だけ記録する(二重の送信・同時の実行でも、記録がずれない)。
-- 戻り値: recorded / already_verified / invalid / no_user / email_unconfirmed / not_email_link
create or replace function public.account_verification_record(p_user_id uuid, p_session_id uuid, p_method text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_confirmed boolean;
begin
  if p_user_id is null or p_session_id is null or p_method not in ('password_confirmed', 'password_set') then
    return 'invalid';
  end if;
  select u.email_confirmed_at is not null into v_confirmed from auth.users u where u.id = p_user_id;
  if not found then
    return 'no_user';
  end if;
  if not v_confirmed then
    return 'email_unconfirmed';
  end if;
  if not public.session_has_email_link(p_session_id, p_user_id) then
    return 'not_email_link';
  end if;
  insert into public.account_verifications (user_id, verified_at, verified_session_id, method)
  values (p_user_id, now(), p_session_id, p_method)
  on conflict (user_id) do nothing;
  if not found then
    return 'already_verified';
  end if;
  return 'recorded';
end;
$$;

-- 本人確認で求めることを記録する。p_only_if_absent = true なら、すでに行があるときは変えない
-- (自分の画面での新規登録は、先に別の経路で記録があれば set_new のまま)。
create or replace function public.account_requirement_set(p_user_id uuid, p_mode text, p_reason text, p_only_if_absent boolean)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_only_if_absent then
    insert into public.account_verification_requirements (user_id, mode, reason)
    values (p_user_id, p_mode, p_reason)
    on conflict (user_id) do nothing;
  else
    insert into public.account_verification_requirements (user_id, mode, reason)
    values (p_user_id, p_mode, p_reason)
    on conflict (user_id) do update set mode = excluded.mode, reason = excluded.reason, updated_at = now();
  end if;
  return 'ok';
end;
$$;

-- 新規登録の分岐用(サーバーだけ)。アドレスが一致するアカウントの有無・確認済みか・作成日時だけを返す。
create or replace function public.account_lookup_for_signup(p_email text)
returns table (user_id uuid, email_confirmed boolean, created_at timestamptz, verified boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.email_confirmed_at is not null, u.created_at,
         exists (select 1 from public.account_verifications v where v.user_id = u.id)
    from auth.users u
   where lower(u.email) = lower(btrim(p_email))
   order by u.created_at, u.id;
$$;

-- ------------------------------------------------------------------
-- 6. 利用区分を判定に入れる(引数・戻り値は 0024 と同じ)
-- ------------------------------------------------------------------
-- 判定の順(lib/features/access.ts・lib/ops/preview.ts と同じ):
--   1〜6 は 0024 と同じ(カタログ → 対象プラン → 提供状態 → 個別設定 → プランの標準)
--   7. 本来なら利用可でも、利用中の区分でなければ利用不可(service_pending)。対象外・準備中・提供終了・個別に利用不可の理由は変えない
create or replace function public.salon_feature_access(p_salon_id uuid, p_feature_key text)
returns table (allowed boolean, reason text)
language sql
stable
set search_path = ''
as $$
  select
    b.allowed and public.salon_service_active(b.service_status),
    case when b.allowed and not public.salon_service_active(b.service_status) then 'service_pending' else b.reason end
  from (
    select
      s.service_status,
      case
        when c.feature_key is null then false
        when r.plan is null then false
        when c.lifecycle <> 'available' then false
        when o.mode = 'deny' then false
        when o.mode = 'allow' then true
        else r.default_enabled
      end as allowed,
      case
        when c.feature_key is null then 'unknown_feature'
        when r.plan is null then 'not_in_plan'
        when c.lifecycle <> 'available' then 'lifecycle_' || c.lifecycle
        when o.mode = 'deny' then 'override_deny'
        when o.mode = 'allow' then 'override_allow'
        when r.default_enabled then 'plan_default'
        else 'plan_default_off'
      end as reason
    from public.salons s
    left join public.feature_catalog c on c.feature_key = p_feature_key
    left join public.plan_feature_rules r on r.plan = s.plan and r.feature_key = p_feature_key
    left join public.salon_feature_overrides o on o.salon_id = s.id and o.feature_key = p_feature_key
    where s.id = p_salon_id
  ) b;
$$;

-- 利用区分の変更。どの経路(管理画面・SQL Editor)でも、版数・ロック・履歴・コミット時の評価(0024)に乗せる。
-- 利用可 → 利用開始待ちで予約通知が利用不可になると、0024 のとおり「権限による停止」が開く(戻しても自動で再開しない)。
create or replace function public.salon_service_status_entitlement_touch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.service_status is distinct from old.service_status then
    perform public.entitlement_touch(new.id, 'service_status', to_jsonb(old.service_status), to_jsonb(new.service_status));
  end if;
  return null;
end;
$$;
drop trigger if exists salon_service_status_entitlement_touch on public.salons;
create trigger salon_service_status_entitlement_touch
  after update of service_status on public.salons
  for each row execute function public.salon_service_status_entitlement_touch();

-- ------------------------------------------------------------------
-- 7. salons の書き込みの制限(0011 を作り直す)と、管理者と所有者を分けるトリガー
-- ------------------------------------------------------------------
-- ブラウザ(anon / authenticated)からは:
--   INSERT: できない(店舗の作成は create_own_salon / admin_register_salon だけ)。owner_insert のポリシーも削除する。
--   UPDATE: 許可リストの列だけ。利用開始待ちの店舗は、登録内容(店舗名・業種・連絡先)だけ。
-- current_user で呼び出し元のロールを判定するため security invoker のまま(0011 と同じ)。
create or replace function public.salons_client_write_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  active_columns constant text[] := array[
    'name', 'description', 'business_type', 'google_review_url', 'onboarding_completed',
    'contact_name', 'contact_email', 'contact_phone', 'updated_at'
  ];
  pending_columns constant text[] := array[
    'name', 'business_type', 'contact_name', 'contact_email', 'contact_phone', 'updated_at'
  ];
  writable text[];
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    raise exception 'salons はクライアントから作成できません'
      using errcode = '42501';
  end if;

  writable := case when public.salon_service_active(old.service_status) then active_columns else pending_columns end;
  if (to_jsonb(new) - writable) is distinct from (to_jsonb(old) - writable) then
    raise exception 'salons のこの列はクライアントから変更できません'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop policy if exists owner_insert on public.salons;
drop policy if exists owner_delete on public.salons;

-- 運営管理のアカウントは店舗の所有者にしない(どの経路でも)。
create or replace function public.salons_owner_not_operator()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.profiles p
      join public.operator_admins a on a.user_id = p.user_id and a.revoked_at is null
     where p.id = new.owner_id
  ) then
    raise exception '運営管理のアカウントは店舗の所有者にできません'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists salons_owner_not_operator on public.salons;
create trigger salons_owner_not_operator
  before insert or update of owner_id on public.salons
  for each row execute function public.salons_owner_not_operator();

create or replace function public.operator_admins_not_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.revoked_at is null and exists (
    select 1 from public.profiles p join public.salons s on s.owner_id = p.id where p.user_id = new.user_id
  ) then
    raise exception '店舗を持つアカウントは運営管理者にできません'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists operator_admins_not_owner on public.operator_admins;
create trigger operator_admins_not_owner
  before insert or update on public.operator_admins
  for each row execute function public.operator_admins_not_owner();

-- ------------------------------------------------------------------
-- 8. ブラウザからの読み書き(RLS)を、信頼できるセッション・利用区分・機能の利用可否にそろえる
-- ------------------------------------------------------------------
-- salons: 信頼できるセッションの所有者だけ。利用開始待ちでも読める・登録内容だけ直せる(列は 7 のトリガーで制限)。
drop policy if exists owner_select on public.salons;
create policy owner_select on public.salons for select to authenticated
  using (id in (select public.owner_salon_ids()));
drop policy if exists owner_update on public.salons;
create policy owner_update on public.salons for update to authenticated
  using (id in (select public.owner_salon_ids()))
  with check (id in (select public.owner_salon_ids()));

-- アンケート(surveys / questions / question_options): オーナーの操作は、信頼できるセッションで、口コミを使える店舗だけ。
-- アンケートの RPC(0004 / 0005 / 0007 / 0019)は security invoker なので、この RLS がそのまま効く。
drop policy if exists owner_select on public.surveys;
create policy owner_select on public.surveys for select to authenticated
  using (salon_id in (select public.owner_feature_salon_ids('reviews')));
drop policy if exists owner_insert on public.surveys;
create policy owner_insert on public.surveys for insert to authenticated
  with check (salon_id in (select public.owner_feature_salon_ids('reviews')));
drop policy if exists owner_update on public.surveys;
create policy owner_update on public.surveys for update to authenticated
  using (salon_id in (select public.owner_feature_salon_ids('reviews')))
  with check (salon_id in (select public.owner_feature_salon_ids('reviews')));
drop policy if exists owner_delete on public.surveys;
create policy owner_delete on public.surveys for delete to authenticated
  using (salon_id in (select public.owner_feature_salon_ids('reviews')));

drop policy if exists owner_select on public.questions;
create policy owner_select on public.questions for select to authenticated
  using (survey_id in (select sv.id from public.surveys sv where sv.salon_id in (select public.owner_feature_salon_ids('reviews'))));
drop policy if exists owner_insert on public.questions;
create policy owner_insert on public.questions for insert to authenticated
  with check (survey_id in (select sv.id from public.surveys sv where sv.salon_id in (select public.owner_feature_salon_ids('reviews'))));
drop policy if exists owner_update on public.questions;
create policy owner_update on public.questions for update to authenticated
  using (survey_id in (select sv.id from public.surveys sv where sv.salon_id in (select public.owner_feature_salon_ids('reviews'))))
  with check (survey_id in (select sv.id from public.surveys sv where sv.salon_id in (select public.owner_feature_salon_ids('reviews'))));
drop policy if exists owner_delete on public.questions;
create policy owner_delete on public.questions for delete to authenticated
  using (survey_id in (select sv.id from public.surveys sv where sv.salon_id in (select public.owner_feature_salon_ids('reviews'))));

drop policy if exists owner_select on public.question_options;
create policy owner_select on public.question_options for select to authenticated
  using (question_id in (
    select q.id from public.questions q join public.surveys sv on sv.id = q.survey_id
     where sv.salon_id in (select public.owner_feature_salon_ids('reviews'))));
drop policy if exists owner_insert on public.question_options;
create policy owner_insert on public.question_options for insert to authenticated
  with check (question_id in (
    select q.id from public.questions q join public.surveys sv on sv.id = q.survey_id
     where sv.salon_id in (select public.owner_feature_salon_ids('reviews'))));
drop policy if exists owner_update on public.question_options;
create policy owner_update on public.question_options for update to authenticated
  using (question_id in (
    select q.id from public.questions q join public.surveys sv on sv.id = q.survey_id
     where sv.salon_id in (select public.owner_feature_salon_ids('reviews'))))
  with check (question_id in (
    select q.id from public.questions q join public.surveys sv on sv.id = q.survey_id
     where sv.salon_id in (select public.owner_feature_salon_ids('reviews'))));
drop policy if exists owner_delete on public.question_options;
create policy owner_delete on public.question_options for delete to authenticated
  using (question_id in (
    select q.id from public.questions q join public.surveys sv on sv.id = q.survey_id
     where sv.salon_id in (select public.owner_feature_salon_ids('reviews'))));

-- 公開中のアンケート(お客様用ページ): 口コミを使える店舗だけ。questions / question_options の公開のポリシーは surveys を
-- 通して読む(0003)ので、同じく止まる。
drop policy if exists public_active_select on public.surveys;
create policy public_active_select on public.surveys for select
  using (is_active and public.salon_reviews_public_available(salon_id));

-- 個別設定(0024): 信頼できるセッションで、利用中の区分の店舗だけ。
drop policy if exists owner_select on public.salon_feature_overrides;
create policy owner_select on public.salon_feature_overrides for select to authenticated
  using (salon_id in (select public.owner_active_salon_ids()));

-- ------------------------------------------------------------------
-- 9. LINE の通知先の招待(0023): 利用中の区分ではない店舗の招待は使えない(受付・開始・登録のすべてで)
-- ------------------------------------------------------------------
create or replace function public.line_invite_status(p_invite public.line_recipient_invites)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_invite.id is null then 'not_found'
    when p_invite.used_at is not null then 'used'
    when p_invite.revoked_at is not null then 'revoked'
    when p_invite.expires_at <= now() then 'expired'
    when not exists (
      select 1 from public.salons s where s.id = p_invite.salon_id and public.salon_service_active(s.service_status)
    ) then 'unavailable'
    else 'valid'
  end;
$$;

-- ------------------------------------------------------------------
-- 10. お客様自身による店舗の登録(authenticated。所有者は auth.uid())
-- ------------------------------------------------------------------
-- 条件: 信頼できるセッション(本人確認のあと)/ メールが確認済み / 運営管理者ではない / まだ店舗を持っていない。
-- 所有者ごとの advisory lock(admin_register_salon と同じ鍵)を取ってから確かめる(同時に登録しても店舗は1つ)。
-- 新しい店舗は必ず「利用開始待ち」・口コミプランで作る(区分・プラン・機能はお客様が指定できない)。
-- 戻り値: {"result": "created"|"already_exists"|"not_authenticated"|"untrusted_session"|"email_unconfirmed"|"operator"|
--          "no_profile"|"invalid:<項目>"|"slug_taken", "salon_id": ...}
create or replace function public.salon_owner_lock(p_profile_id uuid)
returns void
language sql
set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtextextended('salonpack.salon_owner:' || p_profile_id::text, 0));
$$;

create or replace function public.create_own_salon(
  p_name text, p_contact_name text, p_business_type text, p_contact_email text, p_contact_phone text, p_slug text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_profile uuid;
  v_existing uuid;
  v_salon uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_contact_name text := btrim(coalesce(p_contact_name, ''));
  v_business_type text := nullif(btrim(coalesce(p_business_type, '')), '');
  v_contact_email text := nullif(lower(btrim(coalesce(p_contact_email, ''))), '');
  v_contact_phone text := nullif(btrim(coalesce(p_contact_phone, '')), '');
begin
  if v_uid is null then
    return jsonb_build_object('result', 'not_authenticated');
  end if;
  if not public.current_session_trusted() then
    return jsonb_build_object('result', 'untrusted_session');
  end if;
  if not exists (select 1 from auth.users u where u.id = v_uid and u.email_confirmed_at is not null) then
    return jsonb_build_object('result', 'email_unconfirmed');
  end if;
  if public.operator_is_active(v_uid) then
    return jsonb_build_object('result', 'operator');
  end if;
  select p.id into v_profile from public.profiles p where p.user_id = v_uid;
  if not found then
    return jsonb_build_object('result', 'no_profile');
  end if;

  perform public.salon_owner_lock(v_profile);
  select s.id into v_existing from public.salons s where s.owner_id = v_profile order by s.created_at, s.id limit 1;
  if found then
    return jsonb_build_object('result', 'already_exists', 'salon_id', v_existing);
  end if;

  if char_length(v_name) not between 1 and 100 then
    return jsonb_build_object('result', 'invalid:name');
  end if;
  if char_length(v_contact_name) not between 1 and 100 then
    return jsonb_build_object('result', 'invalid:contact_name');
  end if;
  if v_business_type is not null and char_length(v_business_type) > 100 then
    return jsonb_build_object('result', 'invalid:business_type');
  end if;
  if v_contact_email is not null and (char_length(v_contact_email) > 254 or v_contact_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    return jsonb_build_object('result', 'invalid:contact_email');
  end if;
  if v_contact_phone is not null and (char_length(v_contact_phone) > 30 or v_contact_phone !~ '^[0-9+() -]+$') then
    return jsonb_build_object('result', 'invalid:contact_phone');
  end if;
  if p_slug is null or p_slug !~ '^[a-z0-9-]{1,60}$' then
    return jsonb_build_object('result', 'invalid:slug');
  end if;

  begin
    insert into public.salons (owner_id, name, slug, plan, business_type, contact_name, contact_email, contact_phone,
                               service_status, registration_source)
    values (v_profile, v_name, p_slug, 'reviews', v_business_type, v_contact_name, v_contact_email, v_contact_phone,
            'pending', 'self_signup')
    returning id into v_salon;
  exception when unique_violation then
    return jsonb_build_object('result', 'slug_taken');
  end;

  insert into public.operator_audit_log (salon_id, actor_kind, actor_user_id, actor_label, target, before, after, note)
  values (v_salon, 'owner', v_uid, null, 'registration', null,
          jsonb_build_object('source', 'self_signup', 'plan', 'reviews', 'service_status', 'pending'), null);
  return jsonb_build_object('result', 'created', 'salon_id', v_salon);
end;
$$;

-- ------------------------------------------------------------------
-- 11. 利用区分の変更(管理画面。0024 の保存の関数と同じ書き方: 管理者の確認 → 店舗の行 → 基準行 → 版数と値の比較)
-- ------------------------------------------------------------------
-- 区分だけを変える。プラン・個別設定・権限による停止・稼働状態には触れない(予約通知を自動で開始・再開しない)。
-- 戻り値: {"result": "saved"|"no_change"|"conflict"|"not_operator"|"not_found"|"invalid", "version": n, "inflight_sends": n}
create or replace function public.admin_update_salon_service_status(
  p_actor_user_id uuid, p_salon_id uuid, p_expected_version bigint, p_expected_status text, p_new_status text,
  p_note text, p_request_id uuid
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
  v_version bigint;
  v_inflight integer;
begin
  if p_actor_user_id is null or not public.operator_is_active(p_actor_user_id) then
    return jsonb_build_object('result', 'not_operator');
  end if;
  if p_new_status is null or p_new_status not in ('pending', 'complimentary', 'test') then
    return jsonb_build_object('result', 'invalid', 'detail', 'status');
  end if;
  if p_note is not null and char_length(p_note) > 500 then
    return jsonb_build_object('result', 'invalid', 'detail', 'note_too_long');
  end if;

  select s.service_status into v_status from public.salons s where s.id = p_salon_id for no key update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  insert into public.salon_entitlement_state (salon_id, committed_entitled)
  values (p_salon_id, public.salon_entitlement_snapshot(p_salon_id))
  on conflict (salon_id) do nothing;
  select st.version into v_version from public.salon_entitlement_state st where st.salon_id = p_salon_id for update;

  if v_version is distinct from p_expected_version or v_status is distinct from p_expected_status then
    return jsonb_build_object('result', 'conflict', 'version', v_version);
  end if;
  if v_status = p_new_status then
    return jsonb_build_object('result', 'no_change', 'version', v_version);
  end if;

  perform set_config('salonpack.actor_user_id', p_actor_user_id::text, true);
  perform set_config('salonpack.actor_label', '', true);
  perform set_config('salonpack.change_note', coalesce(p_note, ''), true);
  perform set_config('salonpack.request_id', coalesce(p_request_id, gen_random_uuid())::text, true);
  update public.salons set service_status = p_new_status, updated_at = now() where id = p_salon_id;

  select count(*) into v_inflight from public.notification_deliveries d
   where d.salon_id = p_salon_id and d.status = 'claimed' and d.send_started_at is not null;
  select st.version into v_version from public.salon_entitlement_state st where st.salon_id = p_salon_id;
  return jsonb_build_object('result', 'saved', 'version', v_version, 'inflight_sends', v_inflight);
end;
$$;

-- ------------------------------------------------------------------
-- 12. 運営によるサロンの下書き(salons に入れない。アカウントも作らない)
-- ------------------------------------------------------------------
create table if not exists public.salon_drafts (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'draft' check (status in ('draft', 'registered')),
  name text not null check (char_length(btrim(name)) between 1 and 100),
  contact_name text check (contact_name is null or char_length(btrim(contact_name)) between 1 and 100),
  login_email text check (login_email is null or char_length(login_email) <= 254),
  business_type text check (business_type is null or char_length(btrim(business_type)) between 1 and 100),
  -- null = ログイン用のメールアドレスと同じ
  contact_email text check (contact_email is null or (char_length(contact_email) <= 254 and contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
  contact_phone text check (contact_phone is null or (char_length(contact_phone) between 1 and 30 and contact_phone ~ '^[0-9+() -]+$')),
  plan text check (plan is null or plan in ('reviews', 'salonpack')),
  service_status text check (service_status is null or service_status in ('pending', 'complimentary', 'test')),
  -- 利用を許可する機能の個別設定 {"blog": "allow" | "deny"}(書かない機能はプランの標準に従う)
  feature_overrides jsonb not null default '{}'::jsonb check (jsonb_typeof(feature_overrides) = 'object'),
  salon_id uuid unique references public.salons (id) on delete set null,
  version bigint not null default 0,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_by uuid not null,
  updated_at timestamptz not null default now(),
  registered_by uuid,
  registered_at timestamptz,
  check ((status = 'registered') = (registered_at is not null))
);
create index if not exists salon_drafts_status_idx on public.salon_drafts (status, updated_at desc);

-- 下書きの値の確認(保存・本登録で共通)。戻り値: null = 問題なし / '<項目>' = その項目が正しくない
create or replace function public.salon_draft_invalid_field(p_fields jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key text;
  v_value jsonb;
begin
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    return 'fields';
  end if;
  if char_length(btrim(coalesce(p_fields ->> 'name', ''))) not between 1 and 100 then
    return 'name';
  end if;
  if nullif(btrim(coalesce(p_fields ->> 'contact_name', '')), '') is not null and char_length(btrim(p_fields ->> 'contact_name')) > 100 then
    return 'contact_name';
  end if;
  if nullif(btrim(coalesce(p_fields ->> 'login_email', '')), '') is not null
     and (char_length(btrim(p_fields ->> 'login_email')) > 254 or btrim(p_fields ->> 'login_email') !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    return 'login_email';
  end if;
  if nullif(btrim(coalesce(p_fields ->> 'business_type', '')), '') is not null and char_length(btrim(p_fields ->> 'business_type')) > 100 then
    return 'business_type';
  end if;
  if nullif(btrim(coalesce(p_fields ->> 'contact_email', '')), '') is not null
     and (char_length(btrim(p_fields ->> 'contact_email')) > 254 or btrim(p_fields ->> 'contact_email') !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    return 'contact_email';
  end if;
  if nullif(btrim(coalesce(p_fields ->> 'contact_phone', '')), '') is not null
     and (char_length(btrim(p_fields ->> 'contact_phone')) > 30 or btrim(p_fields ->> 'contact_phone') !~ '^[0-9+() -]+$') then
    return 'contact_phone';
  end if;
  if nullif(p_fields ->> 'plan', '') is not null and p_fields ->> 'plan' not in ('reviews', 'salonpack') then
    return 'plan';
  end if;
  if nullif(p_fields ->> 'service_status', '') is not null and p_fields ->> 'service_status' not in ('pending', 'complimentary', 'test') then
    return 'service_status';
  end if;
  if p_fields ? 'feature_overrides' then
    if jsonb_typeof(p_fields -> 'feature_overrides') <> 'object' then
      return 'feature_overrides';
    end if;
    for v_key, v_value in select * from jsonb_each(p_fields -> 'feature_overrides') loop
      if v_key !~ '^[a-z][a-z0-9_]{1,40}$' or jsonb_typeof(v_value) <> 'string' or v_value #>> '{}' not in ('allow', 'deny') then
        return 'feature_overrides';
      end if;
    end loop;
  end if;
  return null;
end;
$$;

-- 下書きの保存(新規・更新)。版数で比べ、違えば何も書かない。サロン名だけでも保存できる。
-- 戻り値: {"result": "saved"|"conflict"|"not_found"|"registered"|"not_operator"|"invalid:<項目>", "draft_id": ..., "version": n}
create or replace function public.admin_save_salon_draft(
  p_actor_user_id uuid, p_draft_id uuid, p_expected_version bigint, p_fields jsonb
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_invalid text;
  v_draft public.salon_drafts;
  v_key text;
  v_overrides jsonb := '{}'::jsonb;
begin
  if p_actor_user_id is null or not public.operator_is_active(p_actor_user_id) then
    return jsonb_build_object('result', 'not_operator');
  end if;
  v_invalid := public.salon_draft_invalid_field(p_fields);
  if v_invalid is not null then
    return jsonb_build_object('result', 'invalid:' || v_invalid);
  end if;
  -- カタログにある機能だけを残す
  for v_key in select k from jsonb_object_keys(coalesce(p_fields -> 'feature_overrides', '{}'::jsonb)) k loop
    if exists (select 1 from public.feature_catalog c where c.feature_key = v_key) then
      v_overrides := v_overrides || jsonb_build_object(v_key, p_fields -> 'feature_overrides' ->> v_key);
    else
      return jsonb_build_object('result', 'invalid:feature_overrides');
    end if;
  end loop;

  if p_draft_id is null then
    insert into public.salon_drafts (name, contact_name, login_email, business_type, contact_email, contact_phone, plan,
                                     service_status, feature_overrides, created_by, updated_by)
    values (btrim(p_fields ->> 'name'),
            nullif(btrim(coalesce(p_fields ->> 'contact_name', '')), ''),
            nullif(lower(btrim(coalesce(p_fields ->> 'login_email', ''))), ''),
            nullif(btrim(coalesce(p_fields ->> 'business_type', '')), ''),
            nullif(lower(btrim(coalesce(p_fields ->> 'contact_email', ''))), ''),
            nullif(btrim(coalesce(p_fields ->> 'contact_phone', '')), ''),
            nullif(p_fields ->> 'plan', ''),
            nullif(p_fields ->> 'service_status', ''),
            v_overrides, p_actor_user_id, p_actor_user_id)
    returning * into v_draft;
    return jsonb_build_object('result', 'saved', 'draft_id', v_draft.id, 'version', v_draft.version);
  end if;

  select * into v_draft from public.salon_drafts d where d.id = p_draft_id for update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_draft.status = 'registered' then
    return jsonb_build_object('result', 'registered', 'draft_id', v_draft.id, 'salon_id', v_draft.salon_id);
  end if;
  if v_draft.version is distinct from p_expected_version then
    return jsonb_build_object('result', 'conflict', 'draft_id', v_draft.id, 'version', v_draft.version);
  end if;
  update public.salon_drafts d
     set name = btrim(p_fields ->> 'name'),
         contact_name = nullif(btrim(coalesce(p_fields ->> 'contact_name', '')), ''),
         login_email = nullif(lower(btrim(coalesce(p_fields ->> 'login_email', ''))), ''),
         business_type = nullif(btrim(coalesce(p_fields ->> 'business_type', '')), ''),
         contact_email = nullif(lower(btrim(coalesce(p_fields ->> 'contact_email', ''))), ''),
         contact_phone = nullif(btrim(coalesce(p_fields ->> 'contact_phone', '')), ''),
         plan = nullif(p_fields ->> 'plan', ''),
         service_status = nullif(p_fields ->> 'service_status', ''),
         feature_overrides = v_overrides,
         version = d.version + 1,
         updated_by = p_actor_user_id,
         updated_at = now()
   where d.id = p_draft_id
  returning * into v_draft;
  return jsonb_build_object('result', 'saved', 'draft_id', v_draft.id, 'version', v_draft.version);
end;
$$;

-- ------------------------------------------------------------------
-- 13. 本登録と招待(運営)
-- ------------------------------------------------------------------

-- ログイン用のメールアドレスで、アカウントの状態を調べる(管理者だけ。確認画面と本登録の前に使う)。
-- 返すのは、紐付け先の判断に要る値だけ(パスワード・トークンは返さない)。
create or replace function public.admin_account_lookup(p_actor_user_id uuid, p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_user auth.users;
  v_salon record;
begin
  if p_actor_user_id is null or not public.operator_is_active(p_actor_user_id) then
    return jsonb_build_object('result', 'not_operator');
  end if;
  select count(*) into v_count from auth.users u where lower(u.email) = lower(btrim(coalesce(p_email, '')));
  if v_count = 0 then
    return jsonb_build_object('result', 'none');
  end if;
  if v_count > 1 then
    return jsonb_build_object('result', 'ambiguous');
  end if;
  select * into v_user from auth.users u where lower(u.email) = lower(btrim(p_email));
  select s.id, s.name into v_salon
    from public.salons s join public.profiles p on p.id = s.owner_id
   where p.user_id = v_user.id
   order by s.created_at, s.id limit 1;
  return jsonb_build_object(
    'result', 'found',
    'user_id', v_user.id,
    'email_confirmed', v_user.email_confirmed_at is not null,
    'verified', exists (select 1 from public.account_verifications v where v.user_id = v_user.id),
    'requirement_mode', (select r.mode from public.account_verification_requirements r where r.user_id = v_user.id),
    'is_operator', public.operator_is_active(v_user.id),
    'salon_id', v_salon.id,
    'salon_name', v_salon.name
  );
end;
$$;

-- 店舗ごとの招待と案内(運営が登録した店舗だけ。お客様が自分で登録した店舗には無い)。
create table if not exists public.salon_invitations (
  salon_id uuid primary key references public.salons (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  login_email text not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  -- 最後に送ろうとした案内の種類: invite=招待 / salon_notice=店舗登録のお知らせ / verify_link=本人確認のリンク
  last_kind text check (last_kind in ('invite', 'salon_notice', 'verify_link')),
  last_attempt_at timestamptz,
  -- sending=送信中 / accepted=Supabase が送信を受け付けた(届いた・読まれたことではない) / failed=送れなかった / simulated=検証モードで送っていない
  last_result text check (last_result in ('sending', 'accepted', 'failed', 'simulated')),
  last_error text check (last_error is null or last_error ~ '^[a-z_]{1,40}$'),
  last_accepted_at timestamptz,
  -- 初回の案内(登録と同時に送るもの)を受け付けた日時。再送とは別に持つ
  first_accepted_at timestamptz
);

create table if not exists public.salon_invitation_attempts (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons (id) on delete cascade,
  actor_user_id uuid not null,
  kind text not null check (kind in ('invite', 'salon_notice', 'verify_link')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  result text not null default 'sending' check (result in ('sending', 'accepted', 'failed', 'simulated')),
  error_code text check (error_code is null or error_code ~ '^[a-z_]{1,40}$'),
  request_id uuid
);
create index if not exists salon_invitation_attempts_salon_idx on public.salon_invitation_attempts (salon_id, started_at desc);

-- 本登録(1つのトランザクションで、店舗・個別設定・招待の行・履歴を書く)。アカウントは、アプリが先に用意する
-- (新しいアドレス: パスワード無しで作り set_new を記録 / 未確認のアカウント: パスワードを乱数にして無効にし set_new を記録)。
-- ここでも、紐付け先が条件を満たすかを確かめる:
--   ログイン用のアドレスと一致 / 管理者ではない / まだ店舗を持っていない(所有者ごとのロックのあと)
--   確認済みなら本人確認の記録がある(無ければ owner_unverified)/ 未確認なら set_new の記録がある(無ければ owner_requirement_missing)
-- 同じ下書きをもう一度登録しようとしたら、作った店舗を返す(連打・同時操作・途中の失敗からの再実行で重複しない)。
create or replace function public.admin_register_salon(
  p_actor_user_id uuid, p_draft_id uuid, p_expected_version bigint, p_owner_user_id uuid, p_slug text, p_request_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_draft public.salon_drafts;
  v_user auth.users;
  v_profile uuid;
  v_existing uuid;
  v_salon uuid;
  v_key text;
  v_mode text;
  v_request uuid := coalesce(p_request_id, gen_random_uuid());
begin
  if p_actor_user_id is null or not public.operator_is_active(p_actor_user_id) then
    return jsonb_build_object('result', 'not_operator');
  end if;
  select * into v_draft from public.salon_drafts d where d.id = p_draft_id for update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_draft.status = 'registered' then
    return jsonb_build_object('result', 'already_registered', 'salon_id', v_draft.salon_id);
  end if;
  if v_draft.version is distinct from p_expected_version then
    return jsonb_build_object('result', 'conflict', 'version', v_draft.version);
  end if;

  if v_draft.contact_name is null then
    return jsonb_build_object('result', 'incomplete:contact_name');
  end if;
  if v_draft.login_email is null or v_draft.login_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return jsonb_build_object('result', 'incomplete:login_email');
  end if;
  if v_draft.plan is null then
    return jsonb_build_object('result', 'incomplete:plan');
  end if;
  if v_draft.service_status is null then
    return jsonb_build_object('result', 'incomplete:service_status');
  end if;
  if p_slug is null or p_slug !~ '^[a-z0-9-]{1,60}$' then
    return jsonb_build_object('result', 'invalid:slug');
  end if;

  select * into v_user from auth.users u where u.id = p_owner_user_id;
  if not found or lower(v_user.email) is distinct from lower(v_draft.login_email) then
    return jsonb_build_object('result', 'email_mismatch');
  end if;
  if public.operator_is_active(v_user.id) then
    return jsonb_build_object('result', 'owner_is_operator');
  end if;
  if v_user.email_confirmed_at is not null then
    if not exists (select 1 from public.account_verifications v where v.user_id = v_user.id) then
      return jsonb_build_object('result', 'owner_unverified');
    end if;
  else
    select r.mode into v_mode from public.account_verification_requirements r where r.user_id = v_user.id;
    if v_mode is distinct from 'set_new' then
      return jsonb_build_object('result', 'owner_requirement_missing');
    end if;
  end if;
  select p.id into v_profile from public.profiles p where p.user_id = v_user.id;
  if not found then
    return jsonb_build_object('result', 'no_profile');
  end if;

  perform public.salon_owner_lock(v_profile);
  select s.id into v_existing from public.salons s where s.owner_id = v_profile order by s.created_at, s.id limit 1;
  if found then
    return jsonb_build_object('result', 'owner_has_salon', 'salon_id', v_existing);
  end if;

  -- 操作した人(トリガーが履歴に書く)。このトランザクションの間だけ有効。
  perform set_config('salonpack.actor_user_id', p_actor_user_id::text, true);
  perform set_config('salonpack.actor_label', '', true);
  perform set_config('salonpack.change_note', '', true);
  perform set_config('salonpack.request_id', v_request::text, true);

  begin
    insert into public.salons (owner_id, name, slug, plan, business_type, contact_name, contact_email, contact_phone,
                               service_status, registration_source)
    values (v_profile, v_draft.name, p_slug, v_draft.plan, v_draft.business_type, v_draft.contact_name,
            nullif(v_draft.contact_email, lower(v_user.email)), v_draft.contact_phone, v_draft.service_status, 'operator')
    returning id into v_salon;
  exception when unique_violation then
    return jsonb_build_object('result', 'slug_taken');
  end;

  -- 個別設定は、そのプランの対象の機能だけ(対象外の機能の設定は登録しない)。
  for v_key in select k from jsonb_object_keys(v_draft.feature_overrides) k loop
    if exists (select 1 from public.plan_feature_rules r where r.plan = v_draft.plan and r.feature_key = v_key) then
      insert into public.salon_feature_overrides (salon_id, feature_key, mode, updated_by, updated_at)
      values (v_salon, v_key, v_draft.feature_overrides ->> v_key, p_actor_user_id, now());
    end if;
  end loop;

  insert into public.salon_invitations (salon_id, user_id, login_email, created_by)
  values (v_salon, v_user.id, lower(v_user.email), p_actor_user_id);

  insert into public.operator_audit_log (salon_id, actor_kind, actor_user_id, actor_label, target, before, after, note, request_id)
  values (v_salon, 'operator', p_actor_user_id, null, 'registration', null,
          jsonb_build_object('source', 'operator', 'plan', v_draft.plan, 'service_status', v_draft.service_status,
                             'account', case when v_user.email_confirmed_at is null then 'unconfirmed' else 'verified' end),
          null, v_request);

  update public.salon_drafts d
     set status = 'registered', salon_id = v_salon, registered_by = p_actor_user_id, registered_at = now(),
         version = d.version + 1, updated_by = p_actor_user_id, updated_at = now()
   where d.id = p_draft_id;
  return jsonb_build_object('result', 'registered', 'salon_id', v_salon);
end;
$$;

-- 案内の送信を始める(制限の確認・種類の決定・試行の記録)。アプリは結果の attempt_id で送信し、finish で結果を記録する。
-- 制限: 同じ店舗では前の試行から60秒あける / 24時間で10回まで。
-- 種類: アカウントのメールが未確認なら invite / 確認済みで本人確認がまだなら verify_link / 本人確認済みなら salon_notice。
-- 戻り値: {"result": "ok"|"cooldown"|"daily_limit"|"no_invitation"|"owner_changed"|"not_operator", ...}
create or replace function public.admin_invitation_begin(p_actor_user_id uuid, p_salon_id uuid, p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.salon_invitations;
  v_user auth.users;
  v_last timestamptz;
  v_count integer;
  v_kind text;
  v_attempt uuid;
begin
  if p_actor_user_id is null or not public.operator_is_active(p_actor_user_id) then
    return jsonb_build_object('result', 'not_operator');
  end if;
  select * into v_inv from public.salon_invitations i where i.salon_id = p_salon_id for update;
  if not found then
    return jsonb_build_object('result', 'no_invitation');
  end if;
  if not exists (
    select 1 from public.salons s join public.profiles p on p.id = s.owner_id where s.id = p_salon_id and p.user_id = v_inv.user_id
  ) then
    return jsonb_build_object('result', 'owner_changed');
  end if;
  select max(a.started_at), count(*) filter (where a.started_at > now() - interval '24 hours')
    into v_last, v_count
    from public.salon_invitation_attempts a where a.salon_id = p_salon_id;
  if v_last is not null and v_last > now() - interval '60 seconds' then
    return jsonb_build_object('result', 'cooldown',
                              'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_last + interval '60 seconds' - now())))::int));
  end if;
  if v_count >= 10 then
    return jsonb_build_object('result', 'daily_limit');
  end if;
  select * into v_user from auth.users u where u.id = v_inv.user_id;
  v_kind := case
    when v_user.email_confirmed_at is null then 'invite'
    when not exists (select 1 from public.account_verifications v where v.user_id = v_user.id) then 'verify_link'
    else 'salon_notice'
  end;
  insert into public.salon_invitation_attempts (salon_id, actor_user_id, kind, request_id)
  values (p_salon_id, p_actor_user_id, v_kind, p_request_id)
  returning id into v_attempt;
  update public.salon_invitations i
     set last_kind = v_kind, last_attempt_at = now(), last_result = 'sending', last_error = null
   where i.salon_id = p_salon_id;
  return jsonb_build_object('result', 'ok', 'attempt_id', v_attempt, 'kind', v_kind, 'email', v_user.email,
                            'user_id', v_user.id, 'first', v_inv.first_accepted_at is null);
end;
$$;

-- 送信の結果を記録する(履歴にも書く)。古い試行の結果が、あとの試行の結果を上書きしない。
-- 戻り値: 'ok' / 'already_finished' / 'not_found' / 'invalid' / 'not_operator'
create or replace function public.admin_invitation_finish(p_actor_user_id uuid, p_attempt_id uuid, p_result text, p_error_code text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.salon_invitation_attempts;
  v_latest uuid;
begin
  if p_actor_user_id is null or not public.operator_is_active(p_actor_user_id) then
    return 'not_operator';
  end if;
  if p_result not in ('accepted', 'failed', 'simulated') or (p_error_code is not null and p_error_code !~ '^[a-z_]{1,40}$') then
    return 'invalid';
  end if;
  select * into v_attempt from public.salon_invitation_attempts a where a.id = p_attempt_id for update;
  if not found then
    return 'not_found';
  end if;
  if v_attempt.finished_at is not null then
    return 'already_finished';
  end if;
  update public.salon_invitation_attempts a
     set finished_at = now(), result = p_result, error_code = case when p_result = 'failed' then coalesce(p_error_code, 'send_failed') end
   where a.id = p_attempt_id;

  perform 1 from public.salon_invitations i where i.salon_id = v_attempt.salon_id for update;
  select a.id into v_latest from public.salon_invitation_attempts a
   where a.salon_id = v_attempt.salon_id order by a.started_at desc, a.id desc limit 1;
  if v_latest = v_attempt.id then
    update public.salon_invitations i
       set last_result = p_result,
           last_error = case when p_result = 'failed' then coalesce(p_error_code, 'send_failed') end,
           last_accepted_at = case when p_result = 'accepted' then now() else i.last_accepted_at end,
           first_accepted_at = case when p_result = 'accepted' then coalesce(i.first_accepted_at, now()) else i.first_accepted_at end
     where i.salon_id = v_attempt.salon_id;
  end if;

  insert into public.operator_audit_log (salon_id, actor_kind, actor_user_id, actor_label, target, before, after, note, request_id)
  values (v_attempt.salon_id, 'operator', p_actor_user_id, null, 'invitation', null,
          jsonb_build_object('kind', v_attempt.kind, 'result', p_result,
                             'error', case when p_result = 'failed' then coalesce(p_error_code, 'send_failed') end),
          null, v_attempt.request_id);
  return 'ok';
end;
$$;

-- 詳細の画面に出す、利用区分・登録経路・連絡先・招待と本人確認の状態(管理者だけ。サーバーの service_role が呼ぶ)。
create or replace function public.admin_salon_onboarding(p_salon_id uuid)
returns table (
  service_status text, registration_source text, contact_name text, contact_email text, contact_phone text,
  owner_user_id uuid, owner_email text, owner_email_confirmed boolean, owner_verified boolean, owner_verification_method text,
  has_invitation boolean, last_kind text, last_attempt_at timestamptz, last_result text, last_error text,
  last_accepted_at timestamptz, first_accepted_at timestamptz, attempts_24h integer, next_send_at timestamptz,
  entitlement_version bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.service_status, s.registration_source, s.contact_name, s.contact_email, s.contact_phone,
         u.id, u.email::text, u.email_confirmed_at is not null, v.user_id is not null, v.method,
         i.salon_id is not null, i.last_kind, i.last_attempt_at, i.last_result, i.last_error,
         i.last_accepted_at, i.first_accepted_at,
         coalesce((select count(*)::int from public.salon_invitation_attempts a
                    where a.salon_id = s.id and a.started_at > now() - interval '24 hours'), 0),
         (select max(a.started_at) + interval '60 seconds' from public.salon_invitation_attempts a where a.salon_id = s.id),
         coalesce(st.version, 0)
    from public.salons s
    join public.profiles p on p.id = s.owner_id
    left join auth.users u on u.id = p.user_id
    left join public.account_verifications v on v.user_id = u.id
    left join public.salon_invitations i on i.salon_id = s.id
    left join public.salon_entitlement_state st on st.salon_id = s.id
   where s.id = p_salon_id;
$$;

-- 一覧(0024)に、利用区分の絞り込み(最後の引数・既定 null)と、区分・登録経路・招待の状態の列を足す。
-- 引数の形が変わるため作り直す(旧アプリの7つの引数の名前付きの呼び出しは、既定値でそのまま動く)。
drop function if exists public.admin_list_salons(text, text, text, boolean, timestamptz, uuid, integer);
create or replace function public.admin_list_salons(
  p_query text, p_plan text, p_feature_key text, p_feature_allowed boolean,
  p_after_created_at timestamptz, p_after_id uuid, p_limit integer, p_service_status text default null
) returns table (
  id uuid, name text, slug text, plan text, created_at timestamptz, owner_email text,
  entitled jsonb, overrides jsonb, open_holds text[],
  service_status text, registration_source text, invitation_state text, invitation_last_result text
)
language sql
stable
security definer
set search_path = ''
as $$
  with q as (
    select nullif(btrim(coalesce(p_query, '')), '') as text
  )
  select s.id, s.name, s.slug, s.plan, s.created_at, u.email::text,
         public.salon_entitlement_snapshot(s.id),
         coalesce((select jsonb_object_agg(o.feature_key, o.mode) from public.salon_feature_overrides o where o.salon_id = s.id), '{}'::jsonb),
         coalesce((select array_agg(h.feature_key order by h.feature_key) from public.salon_feature_holds h
                    where h.salon_id = s.id and h.released_at is null), '{}'::text[]),
         s.service_status, s.registration_source,
         case
           when i.salon_id is null then 'none'
           when u.email_confirmed_at is not null and exists (select 1 from public.account_verifications v where v.user_id = u.id) then 'complete'
           else 'incomplete'
         end,
         i.last_result
    from public.salons s
    join public.profiles p on p.id = s.owner_id
    left join auth.users u on u.id = p.user_id
    left join public.salon_invitations i on i.salon_id = s.id
    cross join q
   where (q.text is null
          or s.name ilike '%' || replace(replace(replace(q.text, '\', '\\'), '%', '\%'), '_', '\_') || '%'
          or u.email ilike '%' || replace(replace(replace(q.text, '\', '\\'), '%', '\%'), '_', '\_') || '%')
     and (p_plan is null or s.plan = p_plan)
     and (p_service_status is null or s.service_status = p_service_status)
     and (p_feature_key is null or p_feature_allowed is null
          or public.salon_feature_entitled(s.id, p_feature_key) = p_feature_allowed)
     and (p_after_created_at is null or (s.created_at, s.id) < (p_after_created_at, p_after_id))
   order by s.created_at desc, s.id desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

-- ------------------------------------------------------------------
-- 14. RLS と権限
-- ------------------------------------------------------------------
alter table public.account_verifications enable row level security;
alter table public.account_verification_requirements enable row level security;
alter table public.salon_drafts enable row level security;
alter table public.salon_invitations enable row level security;
alter table public.salon_invitation_attempts enable row level security;
revoke all on table public.account_verifications, public.account_verification_requirements, public.salon_drafts,
  public.salon_invitations, public.salon_invitation_attempts from anon, authenticated;
grant all on table public.account_verifications, public.account_verification_requirements, public.salon_drafts,
  public.salon_invitations, public.salon_invitation_attempts to service_role;

do $$
declare
  v_fn text;
begin
  -- service_role だけが実行できる関数(新しく作ったもの・作り直したもの)
  foreach v_fn in array array[
    'public.current_session_id()',
    'public.session_has_email_link(uuid, uuid)',
    'public.current_session_trusted()',
    'public.account_verification_record(uuid, uuid, text)',
    'public.account_requirement_set(uuid, text, text, boolean)',
    'public.account_lookup_for_signup(text)',
    'public.salon_feature_access(uuid, text)',
    'public.salon_service_status_entitlement_touch()',
    'public.salons_owner_not_operator()',
    'public.operator_admins_not_owner()',
    'public.line_invite_status(public.line_recipient_invites)',
    'public.salon_owner_lock(uuid)',
    'public.admin_update_salon_service_status(uuid, uuid, bigint, text, text, text, uuid)',
    'public.salon_draft_invalid_field(jsonb)',
    'public.admin_save_salon_draft(uuid, uuid, bigint, jsonb)',
    'public.admin_account_lookup(uuid, text)',
    'public.admin_register_salon(uuid, uuid, bigint, uuid, text, uuid)',
    'public.admin_invitation_begin(uuid, uuid, uuid)',
    'public.admin_invitation_finish(uuid, uuid, text, text)',
    'public.admin_salon_onboarding(uuid)',
    'public.admin_list_salons(text, text, text, boolean, timestamptz, uuid, integer, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;

  -- ブラウザ(authenticated)からも実行できる関数。中で auth.uid() と信頼できるセッションを確かめる。
  -- owner_* は RLS のポリシー(to authenticated)から呼ぶため、実行の権限が要る。
  foreach v_fn in array array[
    'public.owner_salon_ids()',
    'public.owner_active_salon_ids()',
    'public.owner_feature_salon_ids(text)',
    'public.my_account_state()',
    'public.create_own_salon(text, text, text, text, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', v_fn);
    execute format('grant execute on function %s to authenticated, service_role', v_fn);
  end loop;

  -- 制限のトリガー(security invoker)から呼ぶ純粋な関数。
  execute 'revoke all on function public.salon_service_active(text) from public';
  execute 'grant execute on function public.salon_service_active(text) to anon, authenticated, service_role';
  -- 0011 のトリガー関数(作り直した)
  execute 'revoke all on function public.salons_client_write_guard() from public, anon, authenticated';
end;
$$;
