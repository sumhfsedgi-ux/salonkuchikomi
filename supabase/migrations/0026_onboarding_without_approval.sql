-- 登録から利用開始までの流れの見直し(運営の承認をなくす。決済の実装の前の段階)。
-- 計画: docs/plans/salon-onboarding-plan.md / 本番の手順: docs/plans/salon-onboarding-runbook.md
--
-- 0001〜0025 は書き換えない(作り直す関数は、ここで作り直す)。
--
-- 【この migration で決めること】
--   - 通常のお客様の利用開始は、将来の決済の完了で自動で行う。運営の承認(利用区分の変更)は、その代わりにしない。
--     決済はまだ無いため、新しい店舗は登録しただけでは使えない(利用開始待ちのまま)。
--   - 新しい店舗は「無料提供」にできない。無料提供は、0025 の時点で存在した店舗(registration_source = 'existing')だけ。
--   - テスト用は運営が指定する。利用を始めるときのプランが決まっていない店舗は、テスト用にできない。
--   - 新規登録の受付(お客様が自分で店舗を登録すること)は、self_signup_settings.open で開け閉めする。初期値は閉じる。
--   - 確認メールなどの送信の間隔は、「前回から N 秒」で数える(auth_email_cooldowns)。
--
-- 【プランの列の意味】
--   salons.plan ............. 利用中(無料提供・テスト用)の店舗では「契約プラン」。
--                             利用開始待ちの店舗では「利用を始めるときに使う予定のプラン」で、契約ではない。
--   salons.plan_placeholder . true のとき salons.plan は判定の内部だけで使う仮の値で、プランは何も決まっていない(表示は「未定」)。
--                             契約が確定したか・支払い済みか・利用開始かは、この列では表さない(利用区分で決まる)。
--   将来の決済: 決済の完了で動く1つの関数が、plan(お客様が選んだプラン)・plan_placeholder = false・
--   利用区分(通常利用の値を足す)を同時に設定する。今回は作らない。
--
-- 【適用の仕方】
--   - 通常は、まだ適用していない migration を番号の順に適用する(0025 → 0026)。
--   - SQL Editor では、このファイル全体を1回で実行する(1つの暗黙のトランザクションになる)。begin / commit は書かない。
--   - 初回だけの処理(列の追加と埋め戻し)は1つの DO ブロックにまとめ、「列がまだ無いか」で判定する。
--     それ以外は、何度実行しても同じ結果になる文だけにする。

select set_config('lock_timeout', '10s', true);

-- ------------------------------------------------------------------
-- 1. プランが仮の値か(初回だけ: 列の追加と埋め戻し)
-- ------------------------------------------------------------------
-- 埋め戻しの対象は、お客様が自分で登録した利用開始待ちの店舗(0025 では口コミプランを仮に入れていた)。
-- 本番には 0025 の時点の店舗(existing)しか無いため、本番で変わる行は無い。
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'salons' and column_name = 'plan_placeholder') then
    return;
  end if;

  alter table public.salons add column plan_placeholder boolean not null default false;
  update public.salons set plan_placeholder = true
   where registration_source = 'self_signup' and service_status = 'pending';
end;
$$;

-- 仮の値のまま利用中にしない。
alter table public.salons drop constraint if exists salons_plan_placeholder_check;
alter table public.salons add constraint salons_plan_placeholder_check
  check (not plan_placeholder or service_status = 'pending');

comment on column public.salons.plan is
  '利用中の店舗では契約プラン。利用開始待ちの店舗では利用を始めるときに使う予定のプランで、契約ではない。';
comment on column public.salons.plan_placeholder is
  'true のとき plan は判定の内部だけで使う仮の値で、プランは未定。契約・支払い・利用開始はこの列で表さない(利用区分で決まる)。';

-- ------------------------------------------------------------------
-- 2. 送信の間隔(前回から N 秒。アドレス・ユーザーごとのキー)
-- ------------------------------------------------------------------
-- キーはアプリが作る(アドレスはハッシュにする。生のアドレス・トークンは入れない)。
create table if not exists public.auth_email_cooldowns (
  cooldown_key text primary key check (char_length(cooldown_key) between 1 and 200),
  last_at timestamptz not null
);

-- 送ってよければ今の時刻を記録して 0 を返す。まだ早ければ記録せず、残りの秒数(1以上)を返す。
-- 確かめることと記録することを1回で行う(同時の呼び出しでも、送ってよいのは1つだけ)。
create or replace function public.auth_email_cooldown_take(p_key text, p_seconds integer)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_last timestamptz;
begin
  if p_key is null or char_length(p_key) not between 1 and 200 then
    raise exception 'auth_email_cooldown_take: invalid key' using errcode = '22023';
  end if;
  if p_seconds is null or p_seconds not between 1 and 3600 then
    raise exception 'auth_email_cooldown_take: invalid seconds' using errcode = '22023';
  end if;

  insert into public.auth_email_cooldowns as c (cooldown_key, last_at)
  values (p_key, now())
  on conflict (cooldown_key) do update set last_at = excluded.last_at
   where c.last_at <= now() - make_interval(secs => p_seconds)
  returning c.last_at into v_last;
  if found then
    -- 古い行(2日より前)を、ときどき消す。
    if random() < 0.01 then
      delete from public.auth_email_cooldowns where last_at < now() - interval '2 days';
    end if;
    return 0;
  end if;

  select c.last_at into v_last from public.auth_email_cooldowns c where c.cooldown_key = p_key;
  return greatest(1, ceil(extract(epoch from (v_last + make_interval(secs => p_seconds) - now())))::integer);
end;
$$;

-- ------------------------------------------------------------------
-- 3. 新規登録の受付(1行だけ。初期値は閉じる)
-- ------------------------------------------------------------------
-- 閉じている間は、店舗を持たないアカウントが自分で店舗を登録できない(create_own_salon が closed を返す)。
-- 運営の登録・招待、招待されたお客様の手続き、ログイン、パスワード再設定は、この設定で止めない。
-- 開けるのは決済が整ってから(手順書の「一般公開の前に確かめること」を済ませてから)。
create table if not exists public.self_signup_settings (
  id smallint primary key default 1 check (id = 1),
  open boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.self_signup_settings (id, open) values (1, false) on conflict (id) do nothing;

-- ------------------------------------------------------------------
-- 4. お客様が自分で店舗を登録する(0025 を作り直す。引数は同じ)
-- ------------------------------------------------------------------
-- 受付が閉じていれば作らない。プランは決めない(仮の値 + plan_placeholder)。利用開始待ちで作る。
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
  if not coalesce((select st.open from public.self_signup_settings st where st.id = 1), false) then
    return jsonb_build_object('result', 'closed');
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
    insert into public.salons (owner_id, name, slug, plan, plan_placeholder, business_type, contact_name, contact_email,
                               contact_phone, service_status, registration_source)
    values (v_profile, v_name, p_slug, 'reviews', true, v_business_type, v_contact_name, v_contact_email,
            v_contact_phone, 'pending', 'self_signup')
    returning id into v_salon;
  exception when unique_violation then
    return jsonb_build_object('result', 'slug_taken');
  end;

  insert into public.operator_audit_log (salon_id, actor_kind, actor_user_id, actor_label, target, before, after, note)
  values (v_salon, 'owner', v_uid, null, 'registration', null,
          jsonb_build_object('source', 'self_signup', 'plan', null, 'plan_placeholder', true, 'service_status', 'pending'), null);
  return jsonb_build_object('result', 'created', 'salon_id', v_salon);
end;
$$;

-- ------------------------------------------------------------------
-- 5. 下書きの値の確認(0025 を作り直す): 新しい店舗の登録種別は「通常登録(pending)」と「テスト用」だけ
-- ------------------------------------------------------------------
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
  -- 無料提供は、新しい店舗には選べない(0025 の時点の店舗だけ)。
  if nullif(p_fields ->> 'service_status', '') is not null and p_fields ->> 'service_status' not in ('pending', 'test') then
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

-- ------------------------------------------------------------------
-- 6. 本登録(0025 を作り直す。引数は同じ)
-- ------------------------------------------------------------------
-- 0025 からの違い:
--   - 登録種別は pending(通常登録)と test だけ(無料提供は invalid:service_status)。
--   - 通常登録のプランは「案内予定のプラン」で任意(無ければ仮の値 + plan_placeholder)。テスト用はプランが必須(契約プラン)。
--   - プランが無いときは、機能ごとの利用許可を登録しない(invalid:feature_overrides)。
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
  if v_draft.service_status is null then
    return jsonb_build_object('result', 'incomplete:service_status');
  end if;
  if v_draft.service_status not in ('pending', 'test') then
    return jsonb_build_object('result', 'invalid:service_status');
  end if;
  if v_draft.plan is null and v_draft.service_status = 'test' then
    return jsonb_build_object('result', 'incomplete:plan');
  end if;
  if v_draft.plan is null and v_draft.feature_overrides <> '{}'::jsonb then
    return jsonb_build_object('result', 'invalid:feature_overrides');
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
    insert into public.salons (owner_id, name, slug, plan, plan_placeholder, business_type, contact_name, contact_email,
                               contact_phone, service_status, registration_source)
    values (v_profile, v_draft.name, p_slug, coalesce(v_draft.plan, 'reviews'), v_draft.plan is null, v_draft.business_type,
            v_draft.contact_name, nullif(v_draft.contact_email, lower(v_user.email)), v_draft.contact_phone,
            v_draft.service_status, 'operator')
    returning id into v_salon;
  exception when unique_violation then
    return jsonb_build_object('result', 'slug_taken');
  end;

  -- 個別設定は、そのプランの対象の機能だけ(対象外の機能の設定は登録しない)。プランが無いときは上で弾いている。
  for v_key in select k from jsonb_object_keys(v_draft.feature_overrides) k loop
    if exists (select 1 from public.plan_feature_rules r where r.plan = v_draft.plan and r.feature_key = v_key) then
      insert into public.salon_feature_overrides (salon_id, feature_key, mode, updated_by, updated_at)
      values (v_salon, v_key, v_draft.feature_overrides ->> v_key, p_actor_user_id, now());
    end if;
  end loop;

  insert into public.salon_invitations (salon_id, user_id, login_email, created_by)
  values (v_salon, v_user.id, lower(v_user.email), p_actor_user_id);

  -- plan: 通常登録では案内予定のプラン(契約ではない)、テスト用では契約プラン。null = 未定。
  insert into public.operator_audit_log (salon_id, actor_kind, actor_user_id, actor_label, target, before, after, note, request_id)
  values (v_salon, 'operator', p_actor_user_id, null, 'registration', null,
          jsonb_build_object('source', 'operator', 'plan', v_draft.plan, 'plan_placeholder', v_draft.plan is null,
                             'service_status', v_draft.service_status,
                             'account', case when v_user.email_confirmed_at is null then 'unconfirmed' else 'verified' end),
          null, v_request);

  update public.salon_drafts d
     set status = 'registered', salon_id = v_salon, registered_by = p_actor_user_id, registered_at = now(),
         version = d.version + 1, updated_by = p_actor_user_id, updated_at = now()
   where d.id = p_draft_id;
  return jsonb_build_object('result', 'registered', 'salon_id', v_salon);
end;
$$;

-- ------------------------------------------------------------------
-- 7. 利用区分の変更(0025 を作り直す。引数は同じ)
-- ------------------------------------------------------------------
-- 0025 からの違い:
--   - 無料提供にできるのは、0025 の時点の店舗(registration_source = 'existing')だけ(invalid / complimentary_existing_only)。
--   - プランが仮の値の店舗は、テスト用にできない(invalid / plan_required)。
--   - 利用開始待ちから利用中にしたときは、そのときの契約プランを履歴に残す(target = contract_plan)。
-- 区分のほかは変えない。プラン・個別設定・権限による停止・稼働状態には触れない(予約通知を自動で開始・再開しない)。
-- 戻り値: {"result": "saved"|"no_change"|"conflict"|"not_operator"|"not_found"|"invalid", "detail": ..., "version": n, "inflight_sends": n}
create or replace function public.admin_update_salon_service_status(
  p_actor_user_id uuid, p_salon_id uuid, p_expected_version bigint, p_expected_status text, p_new_status text,
  p_note text, p_request_id uuid
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
  v_source text;
  v_plan text;
  v_placeholder boolean;
  v_version bigint;
  v_inflight integer;
  v_request uuid := coalesce(p_request_id, gen_random_uuid());
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

  select s.service_status, s.registration_source, s.plan, s.plan_placeholder
    into v_status, v_source, v_plan, v_placeholder
    from public.salons s where s.id = p_salon_id for no key update;
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
  if p_new_status = 'complimentary' and v_source is distinct from 'existing' then
    return jsonb_build_object('result', 'invalid', 'detail', 'complimentary_existing_only');
  end if;
  if p_new_status = 'test' and v_placeholder then
    return jsonb_build_object('result', 'invalid', 'detail', 'plan_required');
  end if;

  perform set_config('salonpack.actor_user_id', p_actor_user_id::text, true);
  perform set_config('salonpack.actor_label', '', true);
  perform set_config('salonpack.change_note', coalesce(p_note, ''), true);
  perform set_config('salonpack.request_id', v_request::text, true);
  update public.salons set service_status = p_new_status, updated_at = now() where id = p_salon_id;

  -- 利用開始待ち → 利用中: このときから契約プランとして使うプラン(利用開始待ちの間は、契約ではなかった)。
  if v_status = 'pending' and public.salon_service_active(p_new_status) then
    insert into public.operator_audit_log (salon_id, actor_kind, actor_user_id, actor_label, target, before, after, note, request_id)
    values (p_salon_id, 'operator', p_actor_user_id, null, 'contract_plan', null,
            jsonb_build_object('plan', v_plan, 'service_status', p_new_status), null, v_request);
  end if;

  select count(*) into v_inflight from public.notification_deliveries d
   where d.salon_id = p_salon_id and d.status = 'claimed' and d.send_started_at is not null;
  select st.version into v_version from public.salon_entitlement_state st where st.salon_id = p_salon_id;
  return jsonb_build_object('result', 'saved', 'version', v_version, 'inflight_sends', v_inflight);
end;
$$;

-- ------------------------------------------------------------------
-- 8. 一覧(0025 を作り直す。引数は同じ。plan_placeholder の列を足す)
-- ------------------------------------------------------------------
-- 返す plan は、表示の側で利用区分・登録経路・plan_placeholder と合わせて読む(利用開始待ちの店舗のプランは契約ではない)。
-- プランでの絞り込みは「契約プラン」だけを対象にする(利用中の店舗と、止めている 0025 の時点の店舗)。
drop function if exists public.admin_list_salons(text, text, text, boolean, timestamptz, uuid, integer, text);
create or replace function public.admin_list_salons(
  p_query text, p_plan text, p_feature_key text, p_feature_allowed boolean,
  p_after_created_at timestamptz, p_after_id uuid, p_limit integer, p_service_status text default null
) returns table (
  id uuid, name text, slug text, plan text, created_at timestamptz, owner_email text,
  entitled jsonb, overrides jsonb, open_holds text[],
  service_status text, registration_source text, invitation_state text, invitation_last_result text,
  plan_placeholder boolean
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
         i.last_result,
         s.plan_placeholder
    from public.salons s
    join public.profiles p on p.id = s.owner_id
    left join auth.users u on u.id = p.user_id
    left join public.salon_invitations i on i.salon_id = s.id
    cross join q
   where (q.text is null
          or s.name ilike '%' || replace(replace(replace(q.text, '\', '\\'), '%', '\%'), '_', '\_') || '%'
          or u.email ilike '%' || replace(replace(replace(q.text, '\', '\\'), '%', '\%'), '_', '\_') || '%')
     and (p_plan is null
          or (s.plan = p_plan and not s.plan_placeholder
              and (public.salon_service_active(s.service_status) or s.registration_source = 'existing')))
     and (p_service_status is null or s.service_status = p_service_status)
     and (p_feature_key is null or p_feature_allowed is null
          or public.salon_feature_entitled(s.id, p_feature_key) = p_feature_allowed)
     and (p_after_created_at is null or (s.created_at, s.id) < (p_after_created_at, p_after_id))
   order by s.created_at desc, s.id desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

-- ------------------------------------------------------------------
-- 9. RLS と権限
-- ------------------------------------------------------------------
alter table public.auth_email_cooldowns enable row level security;
alter table public.self_signup_settings enable row level security;
revoke all on table public.auth_email_cooldowns, public.self_signup_settings from anon, authenticated;
grant all on table public.auth_email_cooldowns, public.self_signup_settings to service_role;

do $$
declare
  v_fn text;
begin
  -- service_role だけが実行できる関数(新しく作ったもの・作り直したもの)
  foreach v_fn in array array[
    'public.auth_email_cooldown_take(text, integer)',
    'public.salon_draft_invalid_field(jsonb)',
    'public.admin_register_salon(uuid, uuid, bigint, uuid, text, uuid)',
    'public.admin_update_salon_service_status(uuid, uuid, bigint, text, text, text, uuid)',
    'public.admin_list_salons(text, text, text, boolean, timestamptz, uuid, integer, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;

  -- ブラウザ(authenticated)からも実行できる関数(中で auth.uid()・信頼できるセッション・受付の設定を確かめる)
  execute 'revoke all on function public.create_own_salon(text, text, text, text, text, text) from public, anon';
  execute 'grant execute on function public.create_own_salon(text, text, text, text, text, text) to authenticated, service_role';
end;
$$;
