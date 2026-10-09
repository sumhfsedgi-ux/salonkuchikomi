-- 機能の選択(お客様が使うと決めた機能)と、Google連携の共通化
-- (docs/plans/lavi-notification-cutover-plan.md「5層の分離」参照)。
--
-- 何度実行しても同じ結果になるように書く(テスト用DBで --reapply-changed を使うため)。
-- 0009・0020 は本番適用済みのため一切書き換えない。
-- 【状態】この migration(と 0022)は本番・共有 DB には未適用(2026-10-08 時点。テスト用DBにだけ適用して検証)。
--
-- 【分けて管理するもの】
--   契約上の利用権限 ........ salons.plan(既存、0010。この migration では触らない)
--   お客様が選んだ機能 ...... salon_feature_selections / salon_setup_state(本ファイル)
--   Googleの認証情報 ......... google_accounts(Googleアカウント単位。店舗には属さない)
--   店舗×機能の接続先 ....... salon_google_bindings(この店舗の予約メール/口コミがどのアカウントを使うか)
--   運用状態 ................ reservation_notification_operations(0022)
--
-- 新しい表はすべて RLS 有効・ポリシー無し・anon/authenticated から全権限を取り消す
-- (ブラウザから直接読めない。サーバーの service-role 経由でのみ扱う)。関数も同様に
-- anon/authenticated/public から実行権限を取り消し、service_role にだけ付ける。

-- ------------------------------------------------------------------
-- 1. お客様が選んだ機能
-- ------------------------------------------------------------------

-- feature_key は lib/features/registry.ts の key(例: 'reviews','blog','reservation_notifications','google_reviews')。
-- 初回保存時に登録されている全機能の行(true/false)を書く。行が無い機能は「未選択」として扱い、
-- 推定で ON にしない(推定は一度も保存していない店舗にだけ、画面表示用に使う)。
create table if not exists public.salon_feature_selections (
  salon_id uuid not null references public.salons (id) on delete cascade,
  feature_key text not null check (feature_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  selected boolean not null,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (salon_id, feature_key)
);

create table if not exists public.salon_setup_state (
  salon_id uuid primary key references public.salons (id) on delete cascade,
  -- 機能の選択を一度でも保存した日時。これがある店舗には初期設定の選択画面を二度と出さない
  -- (すべて未選択で保存しても初期設定へ戻され続けない)。
  feature_selection_saved_at timestamptz,
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------------
-- 2. Googleアカウントの認証情報(店舗に属さない)
-- ------------------------------------------------------------------

-- アカウントの識別は (OAuthクライアント, id_token の sub) で行う。メールアドレス文字列には依存しない
-- (email は表示用)。refresh token は lib/google/tokenBox.ts で AES-256-GCM 暗号化し、
-- 追加認証データ(AAD)に「アカウントid と token_generation」を含める(別の行・別の世代へ
-- 暗号文を付け替えても復号できない)。
create table if not exists public.google_accounts (
  id uuid primary key,
  oauth_client_id text not null,
  google_sub text not null check (google_sub ~ '^[0-9A-Za-z_-]{1,255}$'),
  email text,
  refresh_token_ciphertext text,
  refresh_token_iv text,
  refresh_token_tag text,
  key_version text,
  token_generation integer not null default 1 check (token_generation >= 1),
  -- Googleから実際に許可されたと確認できた scope だけを入れる(要求した scope ではない)。
  granted_scopes text[] not null default '{}',
  auth_state text not null default 'active'
    check (auth_state in ('active', 'needs_reauth', 'revoking', 'revoked')),
  consecutive_auth_failures integer not null default 0,
  last_auth_failure_at timestamptz,
  last_refreshed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (oauth_client_id, google_sub),
  check (
    (refresh_token_ciphertext is null) = (refresh_token_iv is null)
    and (refresh_token_iv is null) = (refresh_token_tag is null)
    and (refresh_token_tag is null) = (key_version is null)
  ),
  -- 取り消し待ち・取り消し済みのアカウントは平文のトークンを持たない(取り消し用の暗号文は
  -- google_revocations へ移す)。それ以外は必ずトークンを持つ。
  check ((auth_state in ('revoking', 'revoked')) = (refresh_token_ciphertext is null))
);

-- ------------------------------------------------------------------
-- 3. 店舗×機能 → どのGoogleアカウントを使うか
-- ------------------------------------------------------------------

-- feature: 'gmail'(予約通知の予約メール) / 'gbp'(Google口コミ)。
-- この行は、その店舗のユーザーがその店舗のために Google の認可を完了したときにだけ作る
-- (同じアカウントが別店舗に接続済みでも、その認可を流用して勝手に作らない)。
create table if not exists public.salon_google_bindings (
  salon_id uuid not null references public.salons (id) on delete cascade,
  feature text not null check (feature in ('gmail', 'gbp')),
  google_account_id uuid not null references public.google_accounts (id) on delete restrict,
  account_email text,
  -- 口コミは認証のあとに「どの店舗(GBPのロケーション)か」を選ぶ手順を省略しない。
  gbp_selection_state text check (gbp_selection_state in ('selection_pending', 'selected')),
  first_connected_at timestamptz not null default now(),
  last_reconnected_at timestamptz,
  -- 今のアカウントを結び付けた日時(アカウントを切り替えたら更新。再認証では変えない)。
  account_bound_at timestamptz not null default now(),
  bound_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (salon_id, feature),
  check ((feature = 'gbp') = (gbp_selection_state is not null))
);

-- 1つの受信箱(Googleアカウント)を2店舗の予約メールに使うと、別店舗のお客様の予約が
-- 互いのスタッフへ届いてしまう。予約メールは1アカウント=1店舗に限る(口コミは複数店舗を
-- 1アカウントで管理するのが普通なので制限しない)。
create unique index if not exists salon_google_bindings_gmail_account_uniq
  on public.salon_google_bindings (google_account_id) where feature = 'gmail';
create index if not exists salon_google_bindings_account_idx
  on public.salon_google_bindings (google_account_id);

-- その機能だけの権限不足(例: Gmail の API が insufficient_scope を返した)を、結び付けの側に記録する。
-- アカウント全体の認証失敗(google_accounts の invalid_grant の連続回数・needs_reauth)とは数えない
-- (Gmail だけの問題で、同じアカウントの口コミ(gbp)まで再接続が必要・停止扱いにしない)。
-- 再接続で許可されたら(google_bind_features)、または定期処理で Gmail を読めたら消す。
alter table public.salon_google_bindings add column if not exists scope_missing_since timestamptz;

-- 接続の履歴(運営側が「再接続済み」を確認するため。追記のみ)。
create table if not exists public.salon_google_connection_events (
  id bigint generated always as identity primary key,
  salon_id uuid not null references public.salons (id) on delete cascade,
  feature text check (feature in ('gmail', 'gbp')),
  google_account_id uuid references public.google_accounts (id) on delete set null,
  account_email text,
  event text not null,
  granted_scopes text[],
  by_user_id uuid,
  occurred_at timestamptz not null default now()
);
alter table public.salon_google_connection_events drop constraint if exists salon_google_connection_events_event_check;
alter table public.salon_google_connection_events add constraint salon_google_connection_events_event_check
  check (event in (
    'connected', 'reconnected', 'account_switched', 'scope_added', 'scope_missing', 'scope_restored',
    'needs_reauth', 'reauthed', 'unbound', 'revocation_enqueued', 'revocation_cancelled', 'revoked'
  ));
create index if not exists salon_google_connection_events_salon_idx
  on public.salon_google_connection_events (salon_id, occurred_at desc);

-- ------------------------------------------------------------------
-- 4. OAuth の state(開始したユーザー・店舗・用途に結び付け、期限付き・1回限り)
-- ------------------------------------------------------------------

create table if not exists public.google_oauth_states (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null,
  salon_id uuid not null references public.salons (id) on delete cascade,
  features text[] not null check (cardinality(features) > 0 and features <@ array['gmail', 'gbp']::text[]),
  purpose text not null check (purpose in ('connect', 'add_scope', 'reauth', 'switch_account')),
  -- 再認証・権限追加では、開始時に期待していたアカウント(sub)と一致することをコールバックで確かめる。
  expected_google_sub text,
  forced_consent boolean not null default false,
  code_verifier_ciphertext text not null,
  code_verifier_iv text not null,
  code_verifier_tag text not null,
  key_version text not null,
  nonce_hash text not null check (nonce_hash ~ '^[0-9a-f]{64}$'),
  return_to text not null default 'settings_google' check (return_to in ('settings_google', 'dashboard', 'notifications')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  check ((purpose in ('add_scope', 'reauth')) = (expected_google_sub is not null))
);
create index if not exists google_oauth_states_expires_idx on public.google_oauth_states (expires_at);

-- state を原子的に1回だけ消費する。ユーザー・店舗が開始時と違う、期限切れ、使用済みなら何も返さない。
create or replace function public.google_consume_oauth_state(p_state_hash text, p_salon_id uuid, p_user_id uuid)
returns setof public.google_oauth_states
language sql
set search_path = ''
as $$
  update public.google_oauth_states
     set used_at = now()
   where state_hash = p_state_hash
     and salon_id = p_salon_id
     and user_id = p_user_id
     and used_at is null
     and expires_at > now()
  returning *;
$$;

-- ------------------------------------------------------------------
-- 5. Google での認可取り消し(revoke)の待ち行列
-- ------------------------------------------------------------------

-- Google の revoke は「そのプロジェクトに許可した全 scope」を取り消す
-- ("Revocation removes all OAuth 2.0 scopes previously granted to a project, invalidating any issued
-- access or refresh tokens for all clients registered under that project.")。
-- そのため、片方の機能の停止では使わない。「Google連携をすべて解除」かつ、どの店舗・機能からも
-- 参照されなくなったアカウントだけを待ち行列に入れる。古いジョブが、その後に再接続された新しい
-- 認可を取り消さないよう、token_generation が一致し、取り消し待ちのまま参照ゼロの時だけ実行する。
create table if not exists public.google_revocations (
  id uuid primary key default gen_random_uuid(),
  google_account_id uuid not null references public.google_accounts (id) on delete cascade,
  token_generation integer not null,
  refresh_token_ciphertext text not null,
  refresh_token_iv text not null,
  refresh_token_tag text not null,
  key_version text not null,
  enqueued_at timestamptz not null default now(),
  -- 実行中のリース(この間は再接続のトークン保存を拒否する)。
  lease_until timestamptz,
  attempts integer not null default 0,
  last_attempt_at timestamptz,
  last_error text,
  cancelled_at timestamptz,
  done_at timestamptz,
  check (not (cancelled_at is not null and done_at is not null))
);
create unique index if not exists google_revocations_open_uniq
  on public.google_revocations (google_account_id) where cancelled_at is null and done_at is null;

-- ------------------------------------------------------------------
-- 6. 認証情報の保存・結び付け・解除(アカウント行をロックして直列化する)
-- ------------------------------------------------------------------

-- 新しいアカウントを作る。同じ (client, sub) が既にあれば何もしない(呼び出し側が読み直す)。
create or replace function public.google_create_account(
  p_id uuid, p_client_id text, p_sub text, p_email text,
  p_ciphertext text, p_iv text, p_tag text, p_key_version text, p_granted_scopes text[]
) returns setof public.google_accounts
language sql
set search_path = ''
as $$
  insert into public.google_accounts
    (id, oauth_client_id, google_sub, email, refresh_token_ciphertext, refresh_token_iv, refresh_token_tag,
     key_version, token_generation, granted_scopes, auth_state, last_refreshed_at)
  values
    (p_id, p_client_id, p_sub, p_email, p_ciphertext, p_iv, p_tag, p_key_version, 1, p_granted_scopes, 'active', now())
  on conflict (oauth_client_id, google_sub) do nothing
  returning *;
$$;

-- 既存アカウントのトークンを新しいものに置き換える(世代を1つ進める)。
--   - p_expected_generation が現在の世代と違えば何もしない(同時に別の保存があった)。
--   - 取り消しジョブが実行中(リース中)なら拒否する(取り消しが新しい認可を巻き込むため)。
--   - 実行前の取り消しジョブは取り消す(cancelled)。置き換え前のトークンは revoke しない。
create or replace function public.google_replace_account_token(
  p_id uuid, p_expected_generation integer, p_email text,
  p_ciphertext text, p_iv text, p_tag text, p_key_version text, p_granted_scopes text[]
) returns text
language plpgsql
set search_path = ''
as $$
declare
  v_account public.google_accounts;
begin
  select * into v_account from public.google_accounts where id = p_id for update;
  if not found then
    return 'not_found';
  end if;
  if v_account.token_generation <> p_expected_generation then
    return 'generation_mismatch';
  end if;
  if exists (
    select 1 from public.google_revocations
     where google_account_id = p_id and cancelled_at is null and done_at is null
       and lease_until is not null and lease_until > now()
  ) then
    return 'revocation_in_progress';
  end if;

  update public.google_revocations
     set cancelled_at = now()
   where google_account_id = p_id and cancelled_at is null and done_at is null;

  update public.google_accounts
     set email = coalesce(p_email, email),
         refresh_token_ciphertext = p_ciphertext,
         refresh_token_iv = p_iv,
         refresh_token_tag = p_tag,
         key_version = p_key_version,
         token_generation = token_generation + 1,
         granted_scopes = p_granted_scopes,
         auth_state = 'active',
         consecutive_auth_failures = 0,
         last_auth_failure_at = null,
         last_refreshed_at = now(),
         updated_at = now()
   where id = p_id;
  return 'replaced';
end;
$$;

-- 保存済みトークンを使い続ける場合(Google が新しい refresh token を返さなかったが、同じ
-- アカウント・同じクライアントで、トークンの更新と scope の確認ができた場合)の記録。
create or replace function public.google_touch_account(
  p_id uuid, p_expected_generation integer, p_email text, p_granted_scopes text[]
) returns text
language plpgsql
set search_path = ''
as $$
declare
  v_account public.google_accounts;
begin
  select * into v_account from public.google_accounts where id = p_id for update;
  if not found then
    return 'not_found';
  end if;
  if v_account.token_generation <> p_expected_generation or v_account.auth_state in ('revoking', 'revoked') then
    return 'not_reusable';
  end if;
  update public.google_accounts
     set email = coalesce(p_email, email),
         granted_scopes = p_granted_scopes,
         auth_state = 'active',
         consecutive_auth_failures = 0,
         last_auth_failure_at = null,
         last_refreshed_at = now(),
         updated_at = now()
   where id = p_id;
  return 'touched';
end;
$$;

-- 店舗の機能を Google アカウントへ結び付ける。運用状態(0022)には一切触れない。
-- 戻り値は機能ごとのイベント('connected'/'reconnected'/'account_switched')。
-- 予約メールのアカウントが別店舗で使用中なら例外 'google:gmail_account_in_use'。
create or replace function public.google_bind_features(
  p_salon_id uuid, p_account_id uuid, p_features text[], p_account_email text,
  p_user_id uuid, p_granted_scopes text[]
) returns table (feature text, event text)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_account public.google_accounts;
  v_feature text;
  v_existing public.salon_google_bindings;
  v_event text;
begin
  select * into v_account from public.google_accounts where id = p_account_id for update;
  if not found or v_account.auth_state in ('revoking', 'revoked') then
    raise exception 'google:account_not_usable' using errcode = 'P0001';
  end if;

  update public.google_revocations
     set cancelled_at = now()
   where google_account_id = p_account_id and cancelled_at is null and done_at is null
     and (lease_until is null or lease_until <= now());

  foreach v_feature in array p_features loop
    select * into v_existing from public.salon_google_bindings b
     where b.salon_id = p_salon_id and b.feature = v_feature for update;

    if not found then
      begin
        insert into public.salon_google_bindings
          (salon_id, feature, google_account_id, account_email, gbp_selection_state, bound_by_user_id)
        values
          (p_salon_id, v_feature, p_account_id, p_account_email,
           case when v_feature = 'gbp' then 'selection_pending' end, p_user_id);
      exception when unique_violation then
        raise exception 'google:gmail_account_in_use' using errcode = 'P0001';
      end;
      v_event := 'connected';
    elsif v_existing.google_account_id = p_account_id then
      update public.salon_google_bindings
         set account_email = coalesce(p_account_email, account_email),
             last_reconnected_at = now(),
             scope_missing_since = null,
             updated_at = now()
       where salon_id = p_salon_id and salon_google_bindings.feature = v_feature;
      v_event := 'reconnected';
    else
      begin
        update public.salon_google_bindings
           set google_account_id = p_account_id,
               account_email = p_account_email,
               account_bound_at = now(),
               last_reconnected_at = now(),
               scope_missing_since = null,
               gbp_selection_state = case when v_feature = 'gbp' then 'selection_pending' end,
               bound_by_user_id = p_user_id,
               updated_at = now()
         where salon_id = p_salon_id and salon_google_bindings.feature = v_feature;
      exception when unique_violation then
        raise exception 'google:gmail_account_in_use' using errcode = 'P0001';
      end;
      v_event := 'account_switched';
    end if;

    insert into public.salon_google_connection_events
      (salon_id, feature, google_account_id, account_email, event, granted_scopes, by_user_id)
    values (p_salon_id, v_feature, p_account_id, p_account_email, v_event, p_granted_scopes, p_user_id);

    feature := v_feature;
    event := v_event;
    return next;
  end loop;
end;
$$;

-- 店舗の機能の結び付けを外す。p_revoke_if_unreferenced=true(「Google連携をすべて解除」)のときだけ、
-- どの店舗・機能からも参照されなくなったアカウントを取り消し待ちにする(暗号文を待ち行列へ移す)。
-- 戻り値: 外したアカウントごとに、残りの参照数と取り消しを待ち行列に入れたか。
create or replace function public.google_unbind_features(
  p_salon_id uuid, p_features text[], p_user_id uuid, p_revoke_if_unreferenced boolean
) returns table (google_account_id uuid, remaining_references integer, revocation_enqueued boolean)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_binding record;
  v_account public.google_accounts;
  v_remaining integer;
  v_enqueued boolean;
begin
  for v_binding in
    select b.google_account_id as account_id, array_agg(b.feature) as features, max(b.account_email) as email
      from public.salon_google_bindings b
     where b.salon_id = p_salon_id and b.feature = any(p_features)
     group by b.google_account_id
  loop
    select * into v_account from public.google_accounts a where a.id = v_binding.account_id for update;

    delete from public.salon_google_bindings b
     where b.salon_id = p_salon_id and b.feature = any(v_binding.features) and b.google_account_id = v_binding.account_id;

    insert into public.salon_google_connection_events
      (salon_id, feature, google_account_id, account_email, event, by_user_id)
    select p_salon_id, f, v_binding.account_id, v_binding.email, 'unbound', p_user_id
      from unnest(v_binding.features) as f;

    select count(*) into v_remaining from public.salon_google_bindings b where b.google_account_id = v_binding.account_id;
    v_enqueued := false;

    if p_revoke_if_unreferenced and v_remaining = 0 and v_account.auth_state not in ('revoking', 'revoked')
       and v_account.refresh_token_ciphertext is not null then
      insert into public.google_revocations
        (google_account_id, token_generation, refresh_token_ciphertext, refresh_token_iv, refresh_token_tag, key_version)
      values
        (v_account.id, v_account.token_generation, v_account.refresh_token_ciphertext, v_account.refresh_token_iv,
         v_account.refresh_token_tag, v_account.key_version);
      update public.google_accounts a
         set auth_state = 'revoking',
             refresh_token_ciphertext = null, refresh_token_iv = null, refresh_token_tag = null, key_version = null,
             updated_at = now()
       where a.id = v_account.id;
      insert into public.salon_google_connection_events (salon_id, google_account_id, account_email, event, by_user_id)
      values (p_salon_id, v_account.id, v_binding.email, 'revocation_enqueued', p_user_id);
      v_enqueued := true;
    end if;

    google_account_id := v_binding.account_id;
    remaining_references := v_remaining;
    revocation_enqueued := v_enqueued;
    return next;
  end loop;
end;
$$;

-- 取り消しジョブを1件取り出し、実行してよいかを確かめてリースを付ける。
-- 実行してよいのは: 未完了・未取消、アカウントが取り消し待ちのまま、世代が一致、参照ゼロ。
-- 条件を満たさないジョブは取り消す(古いジョブが新しい認可を取り消さないため)。
create or replace function public.google_begin_revocation(p_lease interval default interval '2 minutes')
returns setof public.google_revocations
language plpgsql
set search_path = ''
as $$
declare
  v_job public.google_revocations;
  v_account public.google_accounts;
begin
  select * into v_job from public.google_revocations
   where cancelled_at is null and done_at is null and (lease_until is null or lease_until <= now())
   order by enqueued_at
   limit 1
   for update skip locked;
  if not found then
    return;
  end if;

  select * into v_account from public.google_accounts where id = v_job.google_account_id for update;
  if not found
     or v_account.auth_state <> 'revoking'
     or v_account.token_generation <> v_job.token_generation
     or exists (select 1 from public.salon_google_bindings b where b.google_account_id = v_job.google_account_id) then
    update public.google_revocations set cancelled_at = now() where id = v_job.id;
    return;
  end if;

  update public.google_revocations
     set lease_until = now() + p_lease, attempts = attempts + 1, last_attempt_at = now()
   where id = v_job.id
  returning * into v_job;
  return next v_job;
end;
$$;

create or replace function public.google_finish_revocation(p_id uuid, p_ok boolean, p_error text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_job public.google_revocations;
begin
  select * into v_job from public.google_revocations where id = p_id for update;
  if not found or v_job.cancelled_at is not null or v_job.done_at is not null then
    return;
  end if;
  if p_ok then
    update public.google_revocations set done_at = now(), lease_until = null, last_error = null where id = p_id;
    update public.google_accounts
       set auth_state = 'revoked', granted_scopes = '{}', updated_at = now()
     where id = v_job.google_account_id and auth_state = 'revoking' and token_generation = v_job.token_generation;
  else
    update public.google_revocations set lease_until = null, last_error = left(p_error, 300) where id = p_id;
  end if;
end;
$$;

-- 認証の失敗・成功の記録(アカウント単位。1回の cron で同じアカウントを何度も数えないのは呼び出し側の責務)。
-- 'invalid_grant' が連続 p_threshold 回で needs_reauth。運用状態には触れない。
-- 数えるのは refresh token 自体の失効(トークンの更新で invalid_grant)だけ。ある機能の権限不足
-- (Gmail の insufficient_scope 等)は数えず、google_mark_binding_scope で結び付けの側に記録する。
create or replace function public.google_record_auth_result(
  p_id uuid, p_ok boolean, p_threshold integer default 2
) returns text
language plpgsql
set search_path = ''
as $$
declare
  v_account public.google_accounts;
  v_next integer;
begin
  select * into v_account from public.google_accounts where id = p_id for update;
  if not found or v_account.auth_state in ('revoking', 'revoked') then
    return 'ignored';
  end if;
  if p_ok then
    update public.google_accounts
       set consecutive_auth_failures = 0, last_auth_failure_at = null, auth_state = 'active',
           last_refreshed_at = now(), updated_at = now()
     where id = p_id;
    return case when v_account.auth_state = 'needs_reauth' then 'recovered' else 'ok' end;
  end if;
  v_next := v_account.consecutive_auth_failures + 1;
  update public.google_accounts
     set consecutive_auth_failures = v_next,
         last_auth_failure_at = now(),
         auth_state = case when v_next >= p_threshold then 'needs_reauth' else auth_state end,
         updated_at = now()
   where id = p_id;
  if v_next >= p_threshold and v_account.auth_state <> 'needs_reauth' then
    return 'became_needs_reauth';
  end if;
  return 'failure_recorded';
end;
$$;

-- その機能だけの権限不足を記録する・消す(店舗×機能の結び付けの状態。アカウントの認証状態・
-- 失敗回数には触れない)。状態が変わったときだけ履歴を残す。
-- 戻り値: 'became_missing' / 'already_missing' / 'restored' / 'ok' / 'not_bound'
create or replace function public.google_mark_binding_scope(
  p_salon_id uuid, p_feature text, p_missing boolean, p_granted_scopes text[]
) returns text
language plpgsql
set search_path = ''
as $$
declare
  v_binding public.salon_google_bindings;
begin
  select * into v_binding from public.salon_google_bindings b
   where b.salon_id = p_salon_id and b.feature = p_feature for update;
  if not found then
    return 'not_bound';
  end if;
  if p_missing then
    if v_binding.scope_missing_since is not null then
      return 'already_missing';
    end if;
    update public.salon_google_bindings b set scope_missing_since = now(), updated_at = now()
     where b.salon_id = p_salon_id and b.feature = p_feature;
    insert into public.salon_google_connection_events (salon_id, feature, google_account_id, account_email, event, granted_scopes)
    values (p_salon_id, p_feature, v_binding.google_account_id, v_binding.account_email, 'scope_missing', p_granted_scopes);
    return 'became_missing';
  end if;
  if v_binding.scope_missing_since is null then
    return 'ok';
  end if;
  update public.salon_google_bindings b set scope_missing_since = null, updated_at = now()
   where b.salon_id = p_salon_id and b.feature = p_feature;
  insert into public.salon_google_connection_events (salon_id, feature, google_account_id, account_email, event, granted_scopes)
  values (p_salon_id, p_feature, v_binding.google_account_id, v_binding.account_email, 'scope_restored', p_granted_scopes);
  return 'restored';
end;
$$;

-- ------------------------------------------------------------------
-- 7. RLS とブラウザからのアクセス拒否
-- ------------------------------------------------------------------

alter table public.salon_feature_selections enable row level security;
alter table public.salon_setup_state enable row level security;
alter table public.google_accounts enable row level security;
alter table public.salon_google_bindings enable row level security;
alter table public.salon_google_connection_events enable row level security;
alter table public.google_oauth_states enable row level security;
alter table public.google_revocations enable row level security;

revoke all on table public.salon_feature_selections from anon, authenticated;
revoke all on table public.salon_setup_state from anon, authenticated;
revoke all on table public.google_accounts from anon, authenticated;
revoke all on table public.salon_google_bindings from anon, authenticated;
revoke all on table public.salon_google_connection_events from anon, authenticated;
revoke all on table public.google_oauth_states from anon, authenticated;
revoke all on table public.google_revocations from anon, authenticated;

revoke all on function public.google_consume_oauth_state(text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.google_create_account(uuid, text, text, text, text, text, text, text, text[]) from public, anon, authenticated;
revoke all on function public.google_replace_account_token(uuid, integer, text, text, text, text, text, text[]) from public, anon, authenticated;
revoke all on function public.google_touch_account(uuid, integer, text, text[]) from public, anon, authenticated;
revoke all on function public.google_bind_features(uuid, uuid, text[], text, uuid, text[]) from public, anon, authenticated;
revoke all on function public.google_unbind_features(uuid, text[], uuid, boolean) from public, anon, authenticated;
revoke all on function public.google_begin_revocation(interval) from public, anon, authenticated;
revoke all on function public.google_finish_revocation(uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.google_record_auth_result(uuid, boolean, integer) from public, anon, authenticated;
revoke all on function public.google_mark_binding_scope(uuid, text, boolean, text[]) from public, anon, authenticated;

grant execute on function public.google_consume_oauth_state(text, uuid, uuid) to service_role;
grant execute on function public.google_create_account(uuid, text, text, text, text, text, text, text, text[]) to service_role;
grant execute on function public.google_replace_account_token(uuid, integer, text, text, text, text, text, text[]) to service_role;
grant execute on function public.google_touch_account(uuid, integer, text, text[]) to service_role;
grant execute on function public.google_bind_features(uuid, uuid, text[], text, uuid, text[]) to service_role;
grant execute on function public.google_unbind_features(uuid, text[], uuid, boolean) to service_role;
grant execute on function public.google_begin_revocation(interval) to service_role;
grant execute on function public.google_finish_revocation(uuid, boolean, text) to service_role;
grant execute on function public.google_record_auth_result(uuid, boolean, integer) to service_role;
grant execute on function public.google_mark_binding_scope(uuid, text, boolean, text[]) to service_role;
