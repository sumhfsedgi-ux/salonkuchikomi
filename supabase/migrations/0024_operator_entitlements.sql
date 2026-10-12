-- 運営管理(システム管理者)と、機能ごとの利用権限(契約プラン × 提供状態 × サロンごとの個別設定)。
-- 計画: docs/plans/operator-admin-plan.md
--
-- 0001〜0023 は本番適用済みのため一切書き換えない(作り直す関数は、ここで create or replace する)。
-- 何度実行しても同じ結果になるように書く。
--
-- 【分けて管理するもの】
--   機能の提供状態 ............ feature_catalog.lifecycle(準備中/提供中/提供終了。個別許可では解除できない)
--   対象プラン・プラン内の標準 .. plan_feature_rules(行がある=そのプランの対象。default_enabled=標準で使える)
--   サロンごとの個別設定 ...... salon_feature_overrides(allow/deny。行が無い=プランに従う。対象外のプランでは効かない)
--   最終的な利用可否 .......... salon_feature_access()(画面・API・通知処理が同じ関数・同じ表で判定する)
--   権限による停止 ............ salon_feature_holds(定期処理を持つ機能=予約通知だけ。利用可→利用不可で開き、
--                               再び利用可になっても閉じない。運営が管理画面から明示的に解除する)
--   稼働状態 .................. 既存のまま(reservation_notification_operations・受信ON/OFF・利用停止・旧側の条件)。
--                               この migration は既存店舗の稼働状態を変えない。
--
-- 【整合性】
--   - 店舗ごとの基準行(salon_entitlement_state)を共通のロックにする。契約・個別設定・提供状態・プランの標準を
--     変える経路(管理画面・CLI・SQL Editor)は、トリガーでこの行を FOR UPDATE して版数を上げる。
--     送信直前の確認(notifications_begin_send)などは、この行を FOR SHARE してから利用可否と停止を読む。
--     → 利用不可の保存がコミットされた後に、新しい送信開始(send_started_at の記録)は起きない。
--   - 利用可否の変化による停止の開閉は、コミット直前に1回だけ評価する(遅延制約トリガー)。プランと個別設定を同じ
--     トランザクションで変えても、途中の状態で停止期間を開閉しない。
--   - 操作履歴(operator_audit_log)は、変更と同じトランザクションのトリガーで書く(追記のみ)。
--
-- 【旧アプリとの互換】既存の関数は引数の形を変えない。p_allowed_plans を受け取る関数は、配列が渡されたら従来どおり
--   「プランがその配列に含まれる」ことも条件にする(AND)。新しいアプリは null を渡し、DB の判定だけを使う。

-- ------------------------------------------------------------------
-- 1. 機能カタログ・対象プランと標準設定
-- ------------------------------------------------------------------

-- feature_key は lib/features/registry.ts の key と同じ(変えない ID)。表示名・アイコン・分類などはコード側に持つ。
-- has_runtime: 定期処理などで自動で動き続ける機能(利用不可にしたら「権限による停止」を記録する)。
create table if not exists public.feature_catalog (
  feature_key text primary key check (feature_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  lifecycle text not null check (lifecycle in ('coming_soon', 'available', 'ended')),
  has_runtime boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.plan_feature_rules (
  plan text not null check (plan in ('reviews', 'salonpack')),
  feature_key text not null references public.feature_catalog (feature_key) on delete cascade,
  default_enabled boolean not null,
  updated_at timestamptz not null default now(),
  primary key (plan, feature_key)
);

-- 現在の lib/access/plan.ts(PLAN_FEATURES)・lib/features/registry.ts(availability)と同じ値。
-- 届いた口コミ(google_reviews)などの口コミ465の次期機能は、今回は入れない(コードの PLAN_FEATURES のまま)。
insert into public.feature_catalog (feature_key, lifecycle, has_runtime) values
  ('reviews', 'available', false),
  ('blog', 'available', false),
  ('reservation_notifications', 'available', true)
on conflict (feature_key) do nothing;

insert into public.plan_feature_rules (plan, feature_key, default_enabled) values
  ('reviews', 'reviews', true),
  ('salonpack', 'reviews', true),
  ('salonpack', 'blog', true),
  ('salonpack', 'reservation_notifications', true)
on conflict (plan, feature_key) do nothing;

-- ------------------------------------------------------------------
-- 2. 管理者・個別設定・基準行・権限による停止・操作履歴
-- ------------------------------------------------------------------

-- 管理者は認証済みユーザーの ID で判定する(メールアドレスでは判定しない)。ブラウザからは読み書きできない。
-- 登録は運営が CLI(scripts/operator-admin.ts)か SQL Editor で行う。
create table if not exists public.operator_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  granted_at timestamptz not null default now(),
  granted_by text not null,
  note text,
  revoked_at timestamptz,
  revoked_by text,
  check ((revoked_at is null) = (revoked_by is null))
);

create table if not exists public.salon_feature_overrides (
  salon_id uuid not null references public.salons (id) on delete cascade,
  feature_key text not null references public.feature_catalog (feature_key) on delete restrict,
  mode text not null check (mode in ('allow', 'deny')),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (salon_id, feature_key)
);

-- 店舗ごとの基準行(ロック・版数・前回コミット時点の利用可否)。全店舗に1行ずつ置く。
create table if not exists public.salon_entitlement_state (
  salon_id uuid primary key references public.salons (id) on delete cascade,
  version bigint not null default 0,
  -- 前回コミットした時点の、機能ごとの最終的な利用可否({"blog": true, ...})。停止の開閉の比較にだけ使う。
  committed_entitled jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.salon_feature_holds (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons (id) on delete cascade,
  feature_key text not null references public.feature_catalog (feature_key) on delete restrict,
  opened_at timestamptz not null default now(),
  opened_by text not null,
  reason text,
  released_at timestamptz,
  released_by text,
  release_note text,
  check ((released_at is null) = (released_by is null))
);
create unique index if not exists salon_feature_holds_open_uniq
  on public.salon_feature_holds (salon_id, feature_key) where released_at is null;
create index if not exists salon_feature_holds_salon_idx on public.salon_feature_holds (salon_id, opened_at desc);

-- 操作履歴。店舗が削除されても残す(外部キーを付けない)。追記のみ(UPDATE・DELETE・TRUNCATE はトリガーで拒否)。
create table if not exists public.operator_audit_log (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  salon_id uuid not null,
  actor_kind text not null check (actor_kind in ('operator', 'cli', 'sql', 'system')),
  actor_user_id uuid,
  actor_label text,
  -- 'plan' / 'feature:<key>' / 'hold:<key>' / 'catalog:<key>' / 'plan_rule:<plan>:<key>'
  target text not null,
  before jsonb,
  after jsonb,
  note text,
  request_id uuid,
  tx_id bigint not null default txid_current()
);
create index if not exists operator_audit_log_salon_idx on public.operator_audit_log (salon_id, occurred_at desc, id desc);

create or replace function public.operator_audit_log_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'operator_audit_log は追記のみです' using errcode = '42501';
end;
$$;
drop trigger if exists operator_audit_log_immutable on public.operator_audit_log;
create trigger operator_audit_log_immutable
  before update or delete on public.operator_audit_log
  for each row execute function public.operator_audit_log_immutable();
drop trigger if exists operator_audit_log_no_truncate on public.operator_audit_log;
create trigger operator_audit_log_no_truncate
  before truncate on public.operator_audit_log
  for each statement execute function public.operator_audit_log_immutable();

-- 停止期間の種類に「権限による停止(entitlement)」を加える(0022 の制約を付け替える)。
alter table public.reservation_stop_intervals drop constraint if exists reservation_stop_intervals_kind_check;
alter table public.reservation_stop_intervals add constraint reservation_stop_intervals_kind_check
  check (kind in (
    'outage', 'auth', 'gmail_scope', 'manual_feature_off', 'manual_master_off', 'operator_pause', 'contract',
    'legacy_active', 'legacy_cutover', 'entitlement'
  ));

-- ------------------------------------------------------------------
-- 3. 最終的な利用可否(画面・API・通知処理で共通)
-- ------------------------------------------------------------------

-- 判定の順(lib/features/access.ts と同じ):
--   1. カタログに無い ............................ 利用不可(unknown_feature)
--   2. 店舗のプランが対象外 ...................... 利用不可(not_in_plan)。個別許可でも解除しない
--   3. 提供状態が提供中ではない .................. 利用不可(lifecycle_coming_soon / lifecycle_ended)。個別許可でも解除しない
--   4. 個別に利用不可 ............................ 利用不可(override_deny)
--   5. 個別に許可 ................................ 利用可(override_allow)
--   6. プラン内の標準 ............................ 利用可(plan_default)/ 利用不可(plan_default_off)
-- デプロイが提供するか(APP_MODE)はアプリ側で判定する(提供しないデプロイは、この判定を使う処理を呼ばない)。
create or replace function public.salon_feature_access(p_salon_id uuid, p_feature_key text)
returns table (allowed boolean, reason text)
language sql
stable
set search_path = ''
as $$
  select
    case
      when c.feature_key is null then false
      when r.plan is null then false
      when c.lifecycle <> 'available' then false
      when o.mode = 'deny' then false
      when o.mode = 'allow' then true
      else r.default_enabled
    end,
    case
      when c.feature_key is null then 'unknown_feature'
      when r.plan is null then 'not_in_plan'
      when c.lifecycle <> 'available' then 'lifecycle_' || c.lifecycle
      when o.mode = 'deny' then 'override_deny'
      when o.mode = 'allow' then 'override_allow'
      when r.default_enabled then 'plan_default'
      else 'plan_default_off'
    end
  from public.salons s
  left join public.feature_catalog c on c.feature_key = p_feature_key
  left join public.plan_feature_rules r on r.plan = s.plan and r.feature_key = p_feature_key
  left join public.salon_feature_overrides o on o.salon_id = s.id and o.feature_key = p_feature_key
  where s.id = p_salon_id;
$$;

create or replace function public.salon_feature_entitled(p_salon_id uuid, p_feature_key text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((select a.allowed from public.salon_feature_access(p_salon_id, p_feature_key) a), false);
$$;

-- カタログの全機能の利用可否({"blog": true, ...})。
create or replace function public.salon_entitlement_snapshot(p_salon_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(c.feature_key, public.salon_feature_entitled(p_salon_id, c.feature_key)), '{}'::jsonb)
    from public.feature_catalog c;
$$;

-- アプリ(画面・Server Action・API)が読む、店舗の全機能の判定(同じ関数の結果をそのまま使う)。
-- 管理画面の表示に要る材料(対象プランか・標準・個別設定・提供状態・権限による停止)も返す。
create or replace function public.salon_feature_access_all(p_salon_id uuid)
returns table (
  feature_key text, lifecycle text, has_runtime boolean, in_plan boolean, default_enabled boolean,
  override_mode text, allowed boolean, reason text, hold_open boolean
)
language sql
stable
set search_path = ''
as $$
  select c.feature_key, c.lifecycle, c.has_runtime, r.plan is not null, coalesce(r.default_enabled, false),
         coalesce(o.mode, 'inherit'), a.allowed, a.reason,
         exists (select 1 from public.salon_feature_holds h
                  where h.salon_id = s.id and h.feature_key = c.feature_key and h.released_at is null)
    from public.salons s
    cross join public.feature_catalog c
    left join public.plan_feature_rules r on r.plan = s.plan and r.feature_key = c.feature_key
    left join public.salon_feature_overrides o on o.salon_id = s.id and o.feature_key = c.feature_key
    cross join lateral public.salon_feature_access(s.id, c.feature_key) a
   where s.id = p_salon_id
   order by c.feature_key;
$$;

create or replace function public.salon_feature_hold_open(p_salon_id uuid, p_feature_key text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.salon_feature_holds h
     where h.salon_id = p_salon_id and h.feature_key = p_feature_key and h.released_at is null
  );
$$;

-- ------------------------------------------------------------------
-- 4. 操作した人(トランザクションの設定値から)と、基準行の更新
-- ------------------------------------------------------------------

-- 管理画面の保存関数は salonpack.actor_user_id を、CLI は salonpack.actor_label を設定する。
-- どちらも無ければ SQL(SQL Editor など)からの変更として、DB のロール名を記録する。
create or replace function public.entitlement_actor()
returns table (kind text, user_id uuid, label text, note text, request_id uuid)
language sql
stable
set search_path = ''
as $$
  select
    case
      when nullif(current_setting('salonpack.actor_user_id', true), '') is not null then 'operator'
      when nullif(current_setting('salonpack.actor_label', true), '') is not null then 'cli'
      else 'sql'
    end,
    nullif(current_setting('salonpack.actor_user_id', true), '')::uuid,
    coalesce(nullif(current_setting('salonpack.actor_label', true), ''), current_user::text),
    nullif(current_setting('salonpack.change_note', true), ''),
    nullif(current_setting('salonpack.request_id', true), '')::uuid;
$$;

-- 権限に関わる変更があった店舗の基準行をロックし、版数を上げ、履歴を書く(変更と同じトランザクション)。
-- 版数の更新は、コミット直前の評価(salon_entitlement_settle)の合図にもなる。
create or replace function public.entitlement_touch(p_salon_id uuid, p_target text, p_before jsonb, p_after jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor record;
begin
  -- 店舗ごと削除されている途中(外部キーの cascade)なら何もしない。
  if not exists (select 1 from public.salons s where s.id = p_salon_id) then
    return;
  end if;
  insert into public.salon_entitlement_state (salon_id, committed_entitled)
  values (p_salon_id, public.salon_entitlement_snapshot(p_salon_id))
  on conflict (salon_id) do nothing;
  perform 1 from public.salon_entitlement_state st where st.salon_id = p_salon_id for update;
  update public.salon_entitlement_state st
     set version = st.version + 1, updated_at = now()
   where st.salon_id = p_salon_id;
  select * into v_actor from public.entitlement_actor();
  insert into public.operator_audit_log (salon_id, actor_kind, actor_user_id, actor_label, target, before, after, note, request_id)
  values (p_salon_id, v_actor.kind, v_actor.user_id, v_actor.label, p_target, p_before, p_after, v_actor.note, v_actor.request_id);
end;
$$;

-- 店舗を作ったときに基準行を作る(お客様のセッション(authenticated)からの作成でも動くよう security definer)。
create or replace function public.salon_entitlement_state_init()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.salon_entitlement_state (salon_id, committed_entitled)
  values (new.id, public.salon_entitlement_snapshot(new.id))
  on conflict (salon_id) do nothing;
  return null;
end;
$$;
drop trigger if exists salon_entitlement_state_init on public.salons;
create trigger salon_entitlement_state_init
  after insert on public.salons
  for each row execute function public.salon_entitlement_state_init();

-- 契約(salons.plan)の変更。どの経路(管理画面・CLI・SQL Editor)でも通る。
create or replace function public.salon_plan_entitlement_touch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.plan is distinct from old.plan then
    perform public.entitlement_touch(new.id, 'plan', to_jsonb(old.plan), to_jsonb(new.plan));
  end if;
  return null;
end;
$$;
drop trigger if exists salon_plan_entitlement_touch on public.salons;
create trigger salon_plan_entitlement_touch
  after update of plan on public.salons
  for each row execute function public.salon_plan_entitlement_touch();

-- 個別設定の変更(行が無い=プランに従う='inherit' として記録する)。
create or replace function public.salon_override_entitlement_touch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.entitlement_touch(new.salon_id, 'feature:' || new.feature_key, to_jsonb('inherit'::text), to_jsonb(new.mode));
  elsif tg_op = 'DELETE' then
    perform public.entitlement_touch(old.salon_id, 'feature:' || old.feature_key, to_jsonb(old.mode), to_jsonb('inherit'::text));
  elsif new.mode is distinct from old.mode or new.salon_id <> old.salon_id or new.feature_key <> old.feature_key then
    if new.salon_id <> old.salon_id or new.feature_key <> old.feature_key then
      perform public.entitlement_touch(old.salon_id, 'feature:' || old.feature_key, to_jsonb(old.mode), to_jsonb('inherit'::text));
      perform public.entitlement_touch(new.salon_id, 'feature:' || new.feature_key, to_jsonb('inherit'::text), to_jsonb(new.mode));
    else
      perform public.entitlement_touch(new.salon_id, 'feature:' || new.feature_key, to_jsonb(old.mode), to_jsonb(new.mode));
    end if;
  end if;
  return null;
end;
$$;
drop trigger if exists salon_override_entitlement_touch on public.salon_feature_overrides;
create trigger salon_override_entitlement_touch
  after insert or update or delete on public.salon_feature_overrides
  for each row execute function public.salon_override_entitlement_touch();

-- 全体の提供状態・プランの標準を変えたとき(migration・SQL Editor。編集画面は作らない)。対象の店舗すべての
-- 基準行を(店舗 ID の順に)ロックして版数を上げる。各店舗の停止の開閉は、コミット直前の評価で行う。
create or replace function public.feature_catalog_entitlement_touch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_salon uuid;
  v_key text := coalesce(new.feature_key, old.feature_key);
begin
  if tg_op = 'UPDATE' and new.lifecycle is not distinct from old.lifecycle and new.has_runtime is not distinct from old.has_runtime then
    return null;
  end if;
  for v_salon in select s.id from public.salons s order by s.id loop
    perform public.entitlement_touch(
      v_salon, 'catalog:' || v_key,
      case when tg_op = 'INSERT' then null else jsonb_build_object('lifecycle', old.lifecycle, 'has_runtime', old.has_runtime) end,
      case when tg_op = 'DELETE' then null else jsonb_build_object('lifecycle', new.lifecycle, 'has_runtime', new.has_runtime) end
    );
  end loop;
  return null;
end;
$$;
drop trigger if exists feature_catalog_entitlement_touch on public.feature_catalog;
create trigger feature_catalog_entitlement_touch
  after insert or update or delete on public.feature_catalog
  for each row execute function public.feature_catalog_entitlement_touch();

create or replace function public.plan_rule_entitlement_touch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_salon uuid;
  v_plans text[] := array_remove(array[old.plan, new.plan], null);
  v_key text := coalesce(new.feature_key, old.feature_key);
begin
  if tg_op = 'UPDATE' and new.default_enabled is not distinct from old.default_enabled
     and new.plan = old.plan and new.feature_key = old.feature_key then
    return null;
  end if;
  for v_salon in select s.id from public.salons s where s.plan = any(v_plans) order by s.id loop
    perform public.entitlement_touch(
      v_salon, 'plan_rule:' || coalesce(new.plan, old.plan) || ':' || v_key,
      case when tg_op = 'INSERT' then null else jsonb_build_object('plan', old.plan, 'default_enabled', old.default_enabled) end,
      case when tg_op = 'DELETE' then null else jsonb_build_object('plan', new.plan, 'default_enabled', new.default_enabled) end
    );
  end loop;
  return null;
end;
$$;
drop trigger if exists plan_rule_entitlement_touch on public.plan_feature_rules;
create trigger plan_rule_entitlement_touch
  after insert or update or delete on public.plan_feature_rules
  for each row execute function public.plan_rule_entitlement_touch();

-- ------------------------------------------------------------------
-- 5. コミット直前の評価(権限による停止を開く。閉じない)
-- ------------------------------------------------------------------

-- 版数が上がった基準行ごとに、コミットの直前に1回評価する。
--   - 前回コミット時点で利用可 → 今は利用不可 の定期処理を持つ機能: 権限による停止と停止期間(entitlement)を開く。
--     予約通知は、運用状態の行があり、開始前(setup_pending)ではない店舗だけ(開始前の店舗は、お客様の開始の操作が
--     もともと明示的な操作のため)。
--   - 利用不可 → 利用可: 何も閉じない(再び許可しただけでは再開しない。解除は feature_hold_release)。
--   - committed_entitled を最新にする。この更新は version を変えないので、このトリガーは再び起動しない(再帰しない)。
--     同じトランザクションで版数が何度上がっても、2回目以降は差分が無く何もしない(重複して記録しない)。
create or replace function public.salon_entitlement_settle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb;
  v_now jsonb;
  v_key text;
  v_actor record;
  v_ops_state text;
  v_label text;
begin
  select st.committed_entitled into v_old from public.salon_entitlement_state st where st.salon_id = new.salon_id;
  if not found then
    return null;
  end if;
  v_now := public.salon_entitlement_snapshot(new.salon_id);
  if v_now = v_old then
    return null;
  end if;
  select * into v_actor from public.entitlement_actor();
  v_label := case v_actor.kind when 'operator' then 'operator:' || v_actor.user_id::text else v_actor.kind || ':' || v_actor.label end;
  for v_key in
    select c.feature_key from public.feature_catalog c
     where c.has_runtime
       and coalesce((v_old ->> c.feature_key)::boolean, false)
       and not coalesce((v_now ->> c.feature_key)::boolean, false)
  loop
    if v_key = 'reservation_notifications' then
      select o.state into v_ops_state from public.reservation_notification_operations o where o.salon_id = new.salon_id;
      if v_ops_state is null or v_ops_state = 'setup_pending' then
        continue;
      end if;
      perform public.reservation_open_stop(new.salon_id, 'entitlement', v_label, '利用不可になったため');
    end if;
    insert into public.salon_feature_holds (salon_id, feature_key, opened_by, reason)
    values (new.salon_id, v_key, v_label, (select a.reason from public.salon_feature_access(new.salon_id, v_key) a))
    on conflict (salon_id, feature_key) where released_at is null do nothing;
    insert into public.operator_audit_log (salon_id, actor_kind, actor_user_id, actor_label, target, before, after, note, request_id)
    values (new.salon_id, 'system', v_actor.user_id, v_label, 'hold:' || v_key, to_jsonb('none'::text), to_jsonb('open'::text),
            '利用不可になったため自動で停止', v_actor.request_id);
  end loop;
  update public.salon_entitlement_state st set committed_entitled = v_now where st.salon_id = new.salon_id;
  return null;
end;
$$;
drop trigger if exists salon_entitlement_settle on public.salon_entitlement_state;
create constraint trigger salon_entitlement_settle
  after update of version on public.salon_entitlement_state
  deferrable initially deferred
  for each row
  when (new.version is distinct from old.version)
  execute function public.salon_entitlement_settle();

-- 契約変更の記録(0022)。停止期間 contract の開閉はやめる(利用可否の変化は salon_entitlement_settle が扱い、
-- 再び利用可になっても自動では再開しない)。salon_plan_changes への記録は従来どおり続ける。
create or replace function public.reservation_track_plan_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.plan is distinct from old.plan then
    insert into public.salon_plan_changes (salon_id, old_plan, new_plan, note)
    values (new.id, old.plan, new.plan, nullif(current_setting('salonpack.change_note', true), ''));
  end if;
  return new;
end;
$$;

-- ------------------------------------------------------------------
-- 6. 既存店舗の基準行・既存の契約変更の記録
-- ------------------------------------------------------------------

-- 全店舗の基準行(現在の利用可否を記録するだけ。停止は開かない)。
insert into public.salon_entitlement_state (salon_id, committed_entitled)
select s.id, public.salon_entitlement_snapshot(s.id) from public.salons s
on conflict (salon_id) do nothing;

-- 今の契約では予約通知を使えないのに、運用状態が開始前ではない店舗(以前 salonpack から外した店舗など)。
-- 今も送信していない(契約で止まっている)ため稼働は変わらない。今後 salonpack に戻したときに自動で再開しないよう、
-- 権限による停止を記録しておく(適用前の確認: docs/plans/operator-admin-runbook.md)。
insert into public.salon_feature_holds (salon_id, feature_key, opened_by, reason)
select o.salon_id, 'reservation_notifications', 'migration:0024', '導入時点で契約に含まれていないため'
  from public.reservation_notification_operations o
 where o.state <> 'setup_pending'
   and not public.salon_feature_entitled(o.salon_id, 'reservation_notifications')
on conflict (salon_id, feature_key) where released_at is null do nothing;
-- その店舗に意図的な停止期間が開いていなければ、停止期間(entitlement)も開く(既存の「停止中に届いた予約は送らない」)。
insert into public.reservation_stop_intervals (salon_id, kind, started_by, note)
select h.salon_id, 'entitlement', 'migration:0024', '導入時点で契約に含まれていないため'
  from public.salon_feature_holds h
 where h.feature_key = 'reservation_notifications' and h.released_at is null and h.opened_by = 'migration:0024'
   and not exists (
     select 1 from public.reservation_stop_intervals i
      where i.salon_id = h.salon_id and i.ended_at is null and i.kind in ('contract', 'entitlement')
   )
on conflict (salon_id, kind) where ended_at is null do nothing;

-- 0022 以降の契約変更の記録を、操作履歴にも写す(画面の履歴を1か所にする)。何度実行しても重複させない。
insert into public.operator_audit_log (occurred_at, salon_id, actor_kind, actor_label, target, before, after, note)
select c.changed_at, c.salon_id, 'sql', c.changed_by, 'plan', to_jsonb(c.old_plan), to_jsonb(c.new_plan),
       coalesce(c.note, '') || ' [salon_plan_changes #' || c.id || ']'
  from public.salon_plan_changes c
 where not exists (
   -- 写したもの、または同じトランザクションでトリガーが書いたもの(0024 のあとの変更)は写さない。
   select 1 from public.operator_audit_log l
    where l.salon_id = c.salon_id and l.target = 'plan'
      and (l.note like '%[salon_plan_changes #' || c.id || ']'
           or (l.occurred_at = c.changed_at and l.after = to_jsonb(c.new_plan)))
 );

-- ------------------------------------------------------------------
-- 7. 予約通知の処理を、最終的な利用可否と権限による停止にそろえる(引数の形は変えない)
-- ------------------------------------------------------------------

-- 共通の判定(基準行を共有ロックしてから読む。呼び出し側のトランザクションの中で使う)。
-- 戻り値: null(送ってよい側)/ 'plan_not_allowed'(旧アプリが渡した対象プランの外)/ 'not_entitled' / 'entitlement_hold'
create or replace function public.reservation_entitlement_block(p_salon_id uuid, p_allowed_plans text[], p_lock boolean)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_plan text;
begin
  if p_lock then
    perform 1 from public.salon_entitlement_state st where st.salon_id = p_salon_id for share;
  end if;
  select s.plan into v_plan from public.salons s where s.id = p_salon_id;
  if v_plan is null or (p_allowed_plans is not null and not (v_plan = any(p_allowed_plans))) then
    return 'plan_not_allowed';
  end if;
  if not public.salon_feature_entitled(p_salon_id, 'reservation_notifications') then
    return 'not_entitled';
  end if;
  if public.salon_feature_hold_open(p_salon_id, 'reservation_notifications') then
    return 'entitlement_hold';
  end if;
  return null;
end;
$$;

-- 定期処理で Gmail を読む店舗の一覧(0022 から: 利用可否と権限による停止を加える。p_allowed_plans は null 可)。
create or replace function public.notifications_list_pollable_salons(p_allowed_plans text[])
returns table (
  salon_id uuid, google_account_id uuid, mail_fetch_since timestamptz, mail_fetch_account_id uuid,
  account_bound_at timestamptz, legacy_source text, gmail_scope_missing_since timestamptz,
  open_auto_stops text[], last_tick_at timestamptz
)
language sql
stable
set search_path = ''
as $$
  select o.salon_id, b.google_account_id, o.mail_fetch_since, o.mail_fetch_account_id, b.account_bound_at,
         o.legacy_source, b.scope_missing_since,
         coalesce((
           select array_agg(i.kind order by i.kind) from public.reservation_stop_intervals i
            where i.salon_id = o.salon_id and i.ended_at is null and i.kind in ('auth', 'gmail_scope', 'outage')
         ), '{}'::text[]),
         gs.last_tick_at
    from public.reservation_notification_operations o
    join public.salons s on s.id = o.salon_id
    join public.salon_google_bindings b on b.salon_id = o.salon_id and b.feature = 'gmail'
    join public.google_accounts a on a.id = b.google_account_id
    left join public.gmail_scan_state gs on gs.salon_id = o.salon_id
   where o.state = 'active'
     and (p_allowed_plans is null or s.plan = any(p_allowed_plans))
     and public.salon_feature_entitled(o.salon_id, 'reservation_notifications')
     and not public.salon_feature_hold_open(o.salon_id, 'reservation_notifications')
     and exists (
       select 1 from public.salon_feature_selections f
        where f.salon_id = o.salon_id and f.feature_key = 'reservation_notifications' and f.selected
     )
     and coalesce((select ns.master_enabled from public.notification_settings ns where ns.salon_id = o.salon_id), true)
     and a.auth_state = 'active'
     and 'https://www.googleapis.com/auth/gmail.readonly' = any(a.granted_scopes)
   order by gs.last_tick_at nulls first, o.salon_id;
$$;

-- Gmail の取得の確保(0022 から: 一覧を作ったあとに利用不可・権限による停止になった店舗は、その回の途中からでも読まない)。
create or replace function public.gmail_scan_acquire(
  p_salon_id uuid, p_account_id uuid, p_initial_watermark timestamptz, p_lease interval default interval '2 minutes'
) returns table (lease_token uuid, watermark timestamptz, scan_id uuid, scan_started_at timestamptz, page_token text, was_reset boolean)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_state public.gmail_scan_state;
  v_reset boolean := false;
begin
  if public.reservation_entitlement_block(p_salon_id, null, true) is not null then
    return;
  end if;
  insert into public.gmail_scan_state (salon_id, google_account_id, watermark)
  values (p_salon_id, p_account_id, p_initial_watermark)
  on conflict (salon_id) do nothing;
  select * into v_state from public.gmail_scan_state s where s.salon_id = p_salon_id for update;
  update public.gmail_scan_state s set last_tick_at = now() where s.salon_id = p_salon_id;
  if v_state.google_account_id is distinct from p_account_id then
    -- 予約メールのアカウントが切り替わった: 前のアカウントの続き・基準日時は使わない。
    update public.gmail_scan_state s
       set google_account_id = p_account_id, watermark = p_initial_watermark,
           scan_id = null, scan_started_at = null, page_token = null, updated_at = now()
     where s.salon_id = p_salon_id;
    v_reset := true;
  elsif v_state.watermark < p_initial_watermark then
    update public.gmail_scan_state s set watermark = p_initial_watermark, updated_at = now() where s.salon_id = p_salon_id;
  end if;
  if v_state.lease_until is not null and v_state.lease_until > now() and not v_reset then
    return;
  end if;
  return query
    update public.gmail_scan_state s
       set lease_token = gen_random_uuid(), lease_until = now() + p_lease, updated_at = now()
     where s.salon_id = p_salon_id
    returning s.lease_token, s.watermark, s.scan_id, s.scan_started_at, s.page_token, v_reset;
end;
$$;

-- 配信の取り出し(0023 から: 利用可否と権限による停止を加える。最終確認は notifications_begin_send が行う)。
create or replace function public.notifications_claim_delivery_v2(
  p_salon_id uuid, p_allowed_plans text[],
  p_lease interval default interval '2 minutes',
  p_retry_window interval default interval '23 hours'
) returns setof public.notification_deliveries
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  update public.notification_deliveries
     set status = case when send_started_at is not null then 'unknown' else coalesce(claimed_from_status, 'pending') end,
         last_error = case when send_started_at is not null then 'lease_expired_after_send_start' else last_error end,
         next_attempt_at = case when send_started_at is not null then now() + interval '1 minute' else next_attempt_at end,
         claim_token = null, claimed_at = null, send_started_at = null, claimed_from_status = null,
         updated_at = now()
   where salon_id = p_salon_id and status = 'claimed' and claimed_at < now() - p_lease;

  if not exists (
    select 1
      from public.reservation_notification_operations o
     where o.salon_id = p_salon_id and o.state = 'active'
       and exists (
         select 1 from public.salon_feature_selections f
          where f.salon_id = p_salon_id and f.feature_key = 'reservation_notifications' and f.selected
       )
  ) or public.reservation_entitlement_block(p_salon_id, p_allowed_plans, false) is not null then
    return;
  end if;

  select d.id into v_id
    from public.notification_deliveries d
   where d.salon_id = p_salon_id and d.origin = 'salonpack' and d.retry_stopped_at is null
     and (
       d.status = 'pending'
       or (d.status in ('unknown', 'retry_wait') and d.first_attempt_at is not null
           and d.first_attempt_at > now() - p_retry_window and coalesce(d.next_attempt_at, now()) <= now())
       or (d.status = 'retry_wait' and d.first_attempt_at is null and coalesce(d.next_attempt_at, now()) <= now())
     )
   order by d.created_at
   limit 1
   for update skip locked;
  if v_id is null then
    return;
  end if;

  return query
    update public.notification_deliveries d
       set claimed_from_status = d.status, status = 'claimed', claim_token = gen_random_uuid(), claimed_at = now(),
           attempts = d.attempts + 1, updated_at = now()
     where d.id = v_id
    returning d.*;
end;
$$;

-- 送信の直前確認(0023 から変更した点):
--   - 運用状態の行に加えて、店舗の基準行を共有ロックしてから、利用可否・権限による停止を読む(権限の保存と直列になる)
--   - 店舗の条件に not_entitled / entitlement_hold を加える
--   - 停止期間 entitlement の間に受信した予約は、既存の意図的な停止と同じく送らない
create or replace function public.notifications_begin_send(
  p_id uuid, p_claim_token uuid, p_allowed_plans text[],
  p_stale_after interval default interval '24 hours',
  p_retry_window interval default interval '23 hours',
  p_backoff interval default interval '5 minutes'
) returns table (
  decision text, reason text, destination_id text, line_text text, line_retry_key uuid,
  event_type text, line_connection_id uuid
)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_d public.notification_deliveries;
  v_o public.reservation_notification_operations;
  v_lc public.line_connections;
  v_master boolean;
  v_selected boolean;
  v_salon_reason text;
  v_entitlement text;
  v_legacy text;
  v_stop_kind text;
  v_reason text;
begin
  select * into v_d from public.notification_deliveries d where d.id = p_id for update;
  if not found or v_d.status <> 'claimed' or v_d.claim_token is distinct from p_claim_token then
    return query select 'lost'::text, 'lease_lost'::text, null::text, null::text, null::uuid, null::text, null::uuid;
    return;
  end if;

  select * into v_o from public.reservation_notification_operations o where o.salon_id = v_d.salon_id for share;
  -- 基準行の共有ロック(権限の保存は FOR UPDATE で待ち合わせる)。ロックのあとの文で、コミット済みの最新の値を読む。
  v_entitlement := public.reservation_entitlement_block(v_d.salon_id, p_allowed_plans, true);
  select coalesce((select ns.master_enabled from public.notification_settings ns where ns.salon_id = v_d.salon_id), true)
    into v_master;
  select coalesce((
    select f.selected from public.salon_feature_selections f
     where f.salon_id = v_d.salon_id and f.feature_key = 'reservation_notifications'
  ), false) into v_selected;

  v_salon_reason := case
    when v_o.salon_id is null then 'no_operations'
    when v_o.state <> 'active' then 'state_' || v_o.state
    when v_entitlement is not null then v_entitlement
    when not v_selected then 'feature_not_selected'
    when not v_master then 'master_off'
    else null
  end;
  if v_salon_reason is null and v_o.legacy_source is not null then
    v_legacy := public.reservation_ops_legacy_state(v_d.salon_id);
    if v_legacy <> 'stopped' then
      v_salon_reason := 'legacy_' || v_legacy;
    end if;
  end if;

  if v_salon_reason is not null then
    update public.notification_deliveries d
       set status = coalesce(d.claimed_from_status, 'pending'), claim_token = null, claimed_at = null,
           claimed_from_status = null, next_attempt_at = now() + p_backoff, last_error = v_salon_reason, updated_at = now()
     where d.id = p_id;
    return query select 'released'::text, v_salon_reason, null::text, null::text, null::uuid, null::text, null::uuid;
    return;
  end if;

  -- 通知先の解除・再登録と同時に進まないよう、通知先の行を共有ロックする。
  select * into v_lc from public.line_connections lc where lc.id = v_d.line_connection_id for share;
  v_reason := case
    when v_lc.id is null or v_lc.removed_at is not null then 'recipient_removed'
    when v_lc.registration_generation <> v_d.recipient_generation then 'recipient_reregistered'
    when v_lc.status <> 'connected' or v_lc.destination_id is null then 'recipient_disconnected'
    when v_d.destination_id is null or v_lc.destination_id <> v_d.destination_id then 'destination_changed'
    when v_d.event_type = 'new_reservation' and not v_lc.new_reservation_enabled then 'recipient_toggle_off'
    when v_d.event_type = 'cancellation' and not v_lc.cancellation_enabled then 'recipient_toggle_off'
    when v_d.event_type not in ('new_reservation', 'cancellation')
         and not (v_lc.new_reservation_enabled or v_lc.cancellation_enabled) then 'recipient_all_off'
    else null
  end;

  if v_d.first_attempt_at is null then
    if v_reason is null and v_d.operator_approved_at is null then
      select i.kind into v_stop_kind
        from public.reservation_stop_intervals i
       where i.salon_id = v_d.salon_id
         and i.kind in ('manual_feature_off', 'manual_master_off', 'operator_pause', 'contract', 'legacy_active', 'entitlement')
         and v_d.mail_received_at is not null
         and v_d.mail_received_at >= i.started_at
         and (i.ended_at is null or v_d.mail_received_at < i.ended_at)
       order by i.started_at
       limit 1;
      if v_stop_kind is not null then
        v_reason := 'received_while_stopped:' || v_stop_kind;
      elsif v_d.mail_received_at is null then
        update public.notification_deliveries d
           set status = 'needs_review', skip_reason = 'missing_received_at', claim_token = null, claimed_at = null,
               claimed_from_status = null, updated_at = now()
         where d.id = p_id;
        return query select 'needs_review'::text, 'missing_received_at'::text, null::text, null::text, null::uuid, null::text, null::uuid;
        return;
      elsif v_o.mail_fetch_since is not null and v_d.mail_received_at < v_o.mail_fetch_since then
        v_reason := 'before_fetch_start';
      elsif v_d.mail_received_at < now() - p_stale_after then
        if v_d.handover then
          update public.notification_deliveries d
             set status = 'needs_review', skip_reason = 'handover_older_than_24h', claim_token = null, claimed_at = null,
                 claimed_from_status = null, updated_at = now()
           where d.id = p_id;
          return query select 'needs_review'::text, 'handover_older_than_24h'::text, null::text, null::text, null::uuid, null::text, null::uuid;
          return;
        end if;
        v_reason := 'stale_after_outage';
      end if;
    end if;
    if v_reason is not null then
      -- 一度も送信を始めていない: 未送信と断定できるので skipped。
      update public.notification_deliveries d
         set status = 'skipped', skip_reason = v_reason, claim_token = null, claimed_at = null,
             claimed_from_status = null, updated_at = now()
       where d.id = p_id;
      return query select 'skipped'::text, v_reason, null::text, null::text, null::uuid, v_d.event_type, v_d.line_connection_id;
      return;
    end if;
  else
    -- 送信を試みたことがある配信: 遅延通知のルールで未送信・解決済みに書き換えない。
    if v_d.first_attempt_at <= now() - p_retry_window then
      update public.notification_deliveries d
         set status = coalesce(d.claimed_from_status, 'unknown'), claim_token = null, claimed_at = null,
             claimed_from_status = null, last_error = 'retry_window_expired', updated_at = now()
       where d.id = p_id;
      return query select 'expired'::text, 'retry_window_expired'::text, null::text, null::text, null::uuid, null::text, null::uuid;
      return;
    end if;
    if v_reason in ('recipient_removed', 'recipient_reregistered') then
      -- 解除・再登録した通知先: 状態は書き換えず(送ったかもしれない)、以後の再試行を止める。
      update public.notification_deliveries d
         set status = coalesce(d.claimed_from_status, 'unknown'), claim_token = null, claimed_at = null,
             claimed_from_status = null, retry_stopped_at = now(), retry_stop_reason = v_reason, updated_at = now()
       where d.id = p_id;
      return query select 'released'::text, 'retry_stopped:' || v_reason, null::text, null::text, null::uuid, null::text, null::uuid;
      return;
    end if;
    if v_reason is not null then
      update public.notification_deliveries d
         set status = coalesce(d.claimed_from_status, 'unknown'), claim_token = null, claimed_at = null,
             claimed_from_status = null, next_attempt_at = now() + p_backoff,
             last_error = 'retry_suppressed:' || v_reason, updated_at = now()
       where d.id = p_id;
      return query select 'released'::text, 'retry_suppressed:' || v_reason, null::text, null::text, null::uuid, null::text, null::uuid;
      return;
    end if;
  end if;

  update public.notification_deliveries d
     set first_attempt_token = case when d.first_attempt_at is null then p_claim_token else d.first_attempt_token end,
         first_attempt_at = coalesce(d.first_attempt_at, now()), send_started_at = now(), claimed_at = now(), updated_at = now()
   where d.id = p_id;
  return query select 'send'::text, null::text, v_d.destination_id, v_d.line_text, v_d.line_retry_key,
                      v_d.event_type, v_d.line_connection_id;
end;
$$;

-- お客様による開始(0022 から: 契約の判定を最終的な利用可否にし、権限による停止の間は開始しない)。
create or replace function public.reservation_ops_customer_start(p_salon_id uuid, p_user_id uuid, p_allowed_plans text[])
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_ops public.reservation_notification_operations;
  v_block text;
  v_account uuid;
begin
  insert into public.reservation_notification_operations (salon_id) values (p_salon_id) on conflict (salon_id) do nothing;
  select * into v_ops from public.reservation_notification_operations where salon_id = p_salon_id for update;
  if v_ops.legacy_source is not null or exists (
    select 1 from public.line_connections lc where lc.salon_id = p_salon_id and lc.migrated_from_hmail_salon_id is not null
  ) then
    return 'legacy_salon';
  end if;
  if v_ops.state = 'active' then
    return 'already_active';
  end if;
  if v_ops.state = 'paused' then
    return 'paused_by_operator';
  end if;
  v_block := public.reservation_entitlement_block(p_salon_id, p_allowed_plans, true);
  if v_block = 'entitlement_hold' then
    return 'entitlement_hold';
  elsif v_block is not null then
    return 'plan_not_allowed';
  end if;
  if not exists (
    select 1 from public.salon_feature_selections f
     where f.salon_id = p_salon_id and f.feature_key = 'reservation_notifications' and f.selected
  ) then
    return 'not_selected';
  end if;
  v_account := public.reservation_ops_usable_gmail_account(p_salon_id);
  if v_account is null then
    return 'gmail_not_connected';
  end if;
  if not exists (
    select 1 from public.line_connections lc
     where lc.salon_id = p_salon_id and lc.status = 'connected' and lc.destination_id is not null
  ) then
    return 'no_line_recipients';
  end if;
  -- 新規店舗の初回開始: 開始した日時から読む(接続した日時ではない。開始前に届いた予約は送らない)。
  update public.reservation_notification_operations
     set state = 'active', mail_fetch_since = now(), mail_fetch_since_reason = 'customer_start',
         mail_fetch_account_id = v_account,
         activated_at = now(), activated_by = 'customer:' || p_user_id::text
   where salon_id = p_salon_id;
  return 'started';
end;
$$;

-- 運営による開始・再開(0022 から: 利用不可・権限による停止の間は開始しない。権限による停止は解除しない)。
create or replace function public.reservation_ops_activate(
  p_salon_id uuid, p_by text, p_mail_fetch_since timestamptz, p_reason text
) returns text
language plpgsql
set search_path = ''
as $$
declare
  v_ops public.reservation_notification_operations;
  v_block text;
  v_account uuid;
begin
  select * into v_ops from public.reservation_notification_operations where salon_id = p_salon_id for update;
  if not found then
    return 'no_operations';
  end if;
  v_block := public.reservation_entitlement_block(p_salon_id, null, true);
  if v_block is not null then
    return v_block;
  end if;
  if not exists (
    select 1 from public.salon_feature_selections f
     where f.salon_id = p_salon_id and f.feature_key = 'reservation_notifications' and f.selected
  ) then
    return 'feature_not_selected';
  end if;
  v_account := public.reservation_ops_usable_gmail_account(p_salon_id);
  if v_account is null then
    return 'gmail_not_connected';
  end if;
  update public.reservation_notification_operations
     set state = 'active',
         mail_fetch_since = coalesce(p_mail_fetch_since, mail_fetch_since),
         mail_fetch_since_reason = case when p_mail_fetch_since is not null then p_reason else mail_fetch_since_reason end,
         mail_fetch_account_id = case when p_mail_fetch_since is not null or mail_fetch_account_id is null
                                      then v_account else mail_fetch_account_id end,
         activated_at = coalesce(activated_at, now()),
         activated_by = coalesce(activated_by, p_by),
         paused_at = null, paused_by = null, pause_reason = null
   where salon_id = p_salon_id;
  -- 取得開始日時を決め直したら、読み進めた位置もそこからにする(切り戻し後の再切り替え等で、
  -- 前回の続きの位置のせいで照合した範囲のメールを読み飛ばさない。処理済みのメールは processed_emails で除く)。
  if p_mail_fetch_since is not null then
    update public.gmail_scan_state s
       set watermark = p_mail_fetch_since, google_account_id = v_account,
           scan_id = null, scan_started_at = null, page_token = null, updated_at = now()
     where s.salon_id = p_salon_id;
  end if;
  perform public.reservation_close_stop(p_salon_id, 'operator_pause', p_by);
  perform public.reservation_close_stop(p_salon_id, 'legacy_active', p_by);
  perform public.reservation_close_stop(p_salon_id, 'legacy_cutover', p_by);
  return 'activated';
end;
$$;

-- ------------------------------------------------------------------
-- 8. 管理画面の操作(service_role だけが実行できる。管理者かどうかを DB でも確かめる)
-- ------------------------------------------------------------------

create or replace function public.operator_is_active(p_user_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from public.operator_admins a where a.user_id = p_user_id and a.revoked_at is null);
$$;

-- 契約と個別設定の保存(1つのトランザクション)。
--   p_actor_user_id    サーバーで認証したユーザー(ブラウザの入力は使わない。アプリの Server Action が渡す)
--   p_expected_version 画面を開いたときの版数
--   p_expected         画面を開いたときの値 {"plan": "...", "overrides": {"<key>": "inherit"|"allow"|"deny"}}
--   p_changes          変更 {"plan": "..."(任意), "overrides": {"<key>": "inherit"|"allow"|"deny"}(任意)}
-- 版数か値のどちらかが違えば何も書かずに conflict を返す(CLI・SQL Editor の変更もトリガーで版数が上がる)。
-- 戻り値: {"result": "saved"|"no_change"|"conflict"|"not_operator"|"not_found"|"invalid", "version": n,
--          "inflight_sends": n(保存の時点で送信開始済みの配信)}
create or replace function public.admin_update_salon_entitlements(
  p_actor_user_id uuid, p_salon_id uuid, p_expected_version bigint, p_expected jsonb, p_changes jsonb,
  p_note text, p_request_id uuid
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_plan text;
  v_version bigint;
  v_key text;
  v_value text;
  v_current text;
  v_new_plan text;
  v_changed boolean := false;
  v_inflight integer;
begin
  if p_actor_user_id is null or not public.operator_is_active(p_actor_user_id) then
    return jsonb_build_object('result', 'not_operator');
  end if;
  if p_note is not null and char_length(p_note) > 500 then
    return jsonb_build_object('result', 'invalid', 'detail', 'note_too_long');
  end if;

  -- ロックの順: 店舗の行 → 基準行(CLI・SQL Editor の契約変更と同じ順。デッドロックしない)。
  -- 店舗の行は、契約の UPDATE と同じ強さ(FOR NO KEY UPDATE)にする。子の表への追加(外部キーの確認の
  -- FOR KEY SHARE。運営による停止の停止期間など)とは衝突させない。
  select s.plan into v_plan from public.salons s where s.id = p_salon_id for no key update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  -- 基準行が無い店舗でも、一意制約で直列になる(同時の初回保存は、片方が版数の比較で conflict になる)。
  insert into public.salon_entitlement_state (salon_id, committed_entitled)
  values (p_salon_id, public.salon_entitlement_snapshot(p_salon_id))
  on conflict (salon_id) do nothing;
  select st.version into v_version from public.salon_entitlement_state st where st.salon_id = p_salon_id for update;

  -- 版数と値の両方を比べる。
  if v_version is distinct from p_expected_version
     or (p_expected ? 'plan' and (p_expected ->> 'plan') is distinct from v_plan) then
    return jsonb_build_object('result', 'conflict', 'version', v_version);
  end if;
  for v_key, v_value in select * from jsonb_each_text(coalesce(p_expected -> 'overrides', '{}'::jsonb)) loop
    select coalesce((select o.mode from public.salon_feature_overrides o where o.salon_id = p_salon_id and o.feature_key = v_key), 'inherit')
      into v_current;
    if v_current is distinct from v_value then
      return jsonb_build_object('result', 'conflict', 'version', v_version);
    end if;
  end loop;

  -- 入力の確認(変更の対象は、比べた値に含まれているものだけ)。
  v_new_plan := p_changes ->> 'plan';
  if v_new_plan is not null and v_new_plan not in ('reviews', 'salonpack') then
    return jsonb_build_object('result', 'invalid', 'detail', 'plan');
  end if;
  if v_new_plan is not null and not (p_expected ? 'plan') then
    return jsonb_build_object('result', 'invalid', 'detail', 'plan_not_compared');
  end if;
  for v_key, v_value in select * from jsonb_each_text(coalesce(p_changes -> 'overrides', '{}'::jsonb)) loop
    if not exists (select 1 from public.feature_catalog c where c.feature_key = v_key)
       or v_value not in ('inherit', 'allow', 'deny')
       or not (coalesce(p_expected -> 'overrides', '{}'::jsonb) ? v_key) then
      return jsonb_build_object('result', 'invalid', 'detail', 'override:' || v_key);
    end if;
  end loop;

  -- 対象プランの外の機能には、個別の許可・利用不可を新しく設定できない(口コミプランのまま他の機能を許可しない)。
  -- 「プランに従う」へ戻すことはいつでもできる。プランを変えても残っている個別設定は、対象外の間は効かない。
  for v_key, v_value in select * from jsonb_each_text(coalesce(p_changes -> 'overrides', '{}'::jsonb)) loop
    if v_value <> 'inherit' and not exists (
      select 1 from public.plan_feature_rules r where r.plan = coalesce(v_new_plan, v_plan) and r.feature_key = v_key
    ) then
      return jsonb_build_object('result', 'invalid', 'detail', 'not_in_plan:' || v_key);
    end if;
  end loop;

  -- 操作した人(トリガーが履歴に書く)。このトランザクションの間だけ有効。
  perform set_config('salonpack.actor_user_id', p_actor_user_id::text, true);
  perform set_config('salonpack.actor_label', '', true);
  perform set_config('salonpack.change_note', coalesce(p_note, ''), true);
  perform set_config('salonpack.request_id', coalesce(p_request_id, gen_random_uuid())::text, true);

  if v_new_plan is not null and v_new_plan <> v_plan then
    update public.salons set plan = v_new_plan, updated_at = now() where id = p_salon_id;
    v_changed := true;
  end if;
  for v_key, v_value in select * from jsonb_each_text(coalesce(p_changes -> 'overrides', '{}'::jsonb)) loop
    select coalesce((select o.mode from public.salon_feature_overrides o where o.salon_id = p_salon_id and o.feature_key = v_key), 'inherit')
      into v_current;
    if v_current = v_value then
      continue;
    end if;
    if v_value = 'inherit' then
      delete from public.salon_feature_overrides where salon_id = p_salon_id and feature_key = v_key;
    else
      insert into public.salon_feature_overrides (salon_id, feature_key, mode, updated_by, updated_at)
      values (p_salon_id, v_key, v_value, p_actor_user_id, now())
      on conflict (salon_id, feature_key) do update
         set mode = excluded.mode, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
    end if;
    v_changed := true;
  end loop;

  select count(*) into v_inflight from public.notification_deliveries d
   where d.salon_id = p_salon_id and d.status = 'claimed' and d.send_started_at is not null;
  select st.version into v_version from public.salon_entitlement_state st where st.salon_id = p_salon_id;
  return jsonb_build_object('result', case when v_changed then 'saved' else 'no_change' end,
                            'version', v_version, 'inflight_sends', v_inflight);
end;
$$;

-- 権限による停止の解除(運営が管理画面から明示的に行う)。今、最終的に利用可であることが条件。
-- 受信ON/OFF・利用停止・運用状態・運営による停止・旧側の条件には触れない。
-- 戻り値: 'released' / 'not_operator' / 'no_hold' / 'conflict'(表示した停止と違う)/ 'not_entitled'
create or replace function public.feature_hold_release(
  p_actor_user_id uuid, p_salon_id uuid, p_feature_key text, p_expected_hold_id uuid, p_note text, p_request_id uuid
) returns text
language plpgsql
set search_path = ''
as $$
declare
  v_hold public.salon_feature_holds;
  v_label text;
begin
  if p_actor_user_id is null or not public.operator_is_active(p_actor_user_id) then
    return 'not_operator';
  end if;
  if p_note is not null and char_length(p_note) > 500 then
    return 'invalid';
  end if;
  -- 基準行を FOR UPDATE(権限の変更と直列にする。ロックの順は 店舗 → 基準行)。
  perform 1 from public.salons s where s.id = p_salon_id for share;
  perform 1 from public.salon_entitlement_state st where st.salon_id = p_salon_id for update;
  select * into v_hold from public.salon_feature_holds h
   where h.salon_id = p_salon_id and h.feature_key = p_feature_key and h.released_at is null
   for update;
  if not found then
    return 'no_hold';
  end if;
  if p_expected_hold_id is not null and v_hold.id <> p_expected_hold_id then
    return 'conflict';
  end if;
  if not public.salon_feature_entitled(p_salon_id, p_feature_key) then
    return 'not_entitled';
  end if;
  v_label := 'operator:' || p_actor_user_id::text;
  update public.salon_feature_holds
     set released_at = now(), released_by = v_label, release_note = p_note
   where id = v_hold.id;
  if p_feature_key = 'reservation_notifications' then
    perform public.reservation_close_stop(p_salon_id, 'entitlement', v_label);
    perform public.reservation_close_stop(p_salon_id, 'contract', v_label);
  end if;
  insert into public.operator_audit_log (salon_id, actor_kind, actor_user_id, actor_label, target, before, after, note, request_id)
  values (p_salon_id, 'operator', p_actor_user_id, v_label, 'hold:' || p_feature_key,
          jsonb_build_object('hold_id', v_hold.id, 'opened_at', v_hold.opened_at), to_jsonb('released'::text),
          nullif(p_note, ''), p_request_id);
  return 'released';
end;
$$;

-- 一覧(検索・絞り込み・キーセット方式のページ送り)。登録メールアドレスは auth.users から読む(security definer)。
-- 秘密の値(トークン等)は返さない。
create or replace function public.admin_list_salons(
  p_query text, p_plan text, p_feature_key text, p_feature_allowed boolean,
  p_after_created_at timestamptz, p_after_id uuid, p_limit integer
) returns table (
  id uuid, name text, slug text, plan text, created_at timestamptz, owner_email text,
  entitled jsonb, overrides jsonb, open_holds text[]
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
                    where h.salon_id = s.id and h.released_at is null), '{}'::text[])
    from public.salons s
    join public.profiles p on p.id = s.owner_id
    left join auth.users u on u.id = p.user_id
    cross join q
   where (q.text is null
          or s.name ilike '%' || replace(replace(replace(q.text, '\', '\\'), '%', '\%'), '_', '\_') || '%'
          or u.email ilike '%' || replace(replace(replace(q.text, '\', '\\'), '%', '\%'), '_', '\_') || '%')
     and (p_plan is null or s.plan = p_plan)
     and (p_feature_key is null or p_feature_allowed is null
          or public.salon_feature_entitled(s.id, p_feature_key) = p_feature_allowed)
     and (p_after_created_at is null or (s.created_at, s.id) < (p_after_created_at, p_after_id))
   order by s.created_at desc, s.id desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

-- 詳細の基本情報(登録メールアドレスを含む)。
create or replace function public.admin_get_salon(p_salon_id uuid)
returns table (
  id uuid, name text, slug text, plan text, business_type text, description text, google_review_url text,
  onboarding_completed boolean, created_at timestamptz, updated_at timestamptz, owner_email text,
  version bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.name, s.slug, s.plan, s.business_type, s.description, s.google_review_url,
         s.onboarding_completed, s.created_at, s.updated_at, u.email::text,
         coalesce(st.version, 0)
    from public.salons s
    join public.profiles p on p.id = s.owner_id
    left join auth.users u on u.id = p.user_id
    left join public.salon_entitlement_state st on st.salon_id = s.id
   where s.id = p_salon_id;
$$;

-- 操作履歴(新しい順・続きから読める)。操作した管理者のメールアドレスを auth.users から添える(表示用)。
create or replace function public.admin_audit_log(p_salon_id uuid, p_before_id bigint, p_limit integer)
returns table (
  id bigint, occurred_at timestamptz, actor_kind text, actor_user_id uuid, actor_label text, actor_email text,
  target text, before jsonb, after jsonb, note text, request_id uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  select l.id, l.occurred_at, l.actor_kind, l.actor_user_id, l.actor_label, u.email::text,
         l.target, l.before, l.after, l.note, l.request_id
    from public.operator_audit_log l
    left join auth.users u on u.id = l.actor_user_id
   where l.salon_id = p_salon_id and (p_before_id is null or l.id < p_before_id)
   order by l.id desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

-- ------------------------------------------------------------------
-- 9. お客様用ページ(公開)で口コミを使えるか
-- ------------------------------------------------------------------

-- 公開するのは「使えるか」の真偽だけで、契約・停止の理由は返さない。ビューから呼ぶ関数の実行権限は
-- 呼び出した側(anon)で確かめられるため、この関数だけを anon / authenticated に許可する(中身は所有者の権限で読む)。
create or replace function public.salon_reviews_public_available(p_salon_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.salon_feature_entitled(p_salon_id, 'reviews');
$$;
revoke all on function public.salon_reviews_public_available(uuid) from public;
grant execute on function public.salon_reviews_public_available(uuid) to anon, authenticated, service_role;

-- salon_public(0003・0008)に列を足す(既存の列と順序はそのまま)。
create or replace view public.salon_public
with (security_invoker = false) as
select id, name, slug, google_review_url, description, business_type,
       public.salon_reviews_public_available(id) as reviews_available
from public.salons;

grant select on public.salon_public to anon, authenticated;

-- ------------------------------------------------------------------
-- 10. RLS と権限
-- ------------------------------------------------------------------

alter table public.feature_catalog enable row level security;
alter table public.plan_feature_rules enable row level security;
alter table public.operator_admins enable row level security;
alter table public.salon_feature_overrides enable row level security;
alter table public.salon_entitlement_state enable row level security;
alter table public.salon_feature_holds enable row level security;
alter table public.operator_audit_log enable row level security;

revoke all on table public.feature_catalog from anon, authenticated;
revoke all on table public.plan_feature_rules from anon, authenticated;
revoke all on table public.operator_admins from anon, authenticated;
revoke all on table public.salon_feature_overrides from anon, authenticated;
revoke all on table public.salon_entitlement_state from anon, authenticated;
revoke all on table public.salon_feature_holds from anon, authenticated;
revoke all on table public.operator_audit_log from anon, authenticated;

-- 機能カタログ・プランの規則は、ログイン中の利用者が読める(書けない)。
grant select on table public.feature_catalog to authenticated;
grant select on table public.plan_feature_rules to authenticated;
drop policy if exists authenticated_select on public.feature_catalog;
create policy authenticated_select on public.feature_catalog for select to authenticated using (true);
drop policy if exists authenticated_select on public.plan_feature_rules;
create policy authenticated_select on public.plan_feature_rules for select to authenticated using (true);

-- 個別設定は、オーナーが自店舗の分だけ読める(getCurrentSalon で一緒に読む)。書き込みのポリシーは無い。
grant select on table public.salon_feature_overrides to authenticated;
drop policy if exists owner_select on public.salon_feature_overrides;
create policy owner_select on public.salon_feature_overrides for select to authenticated
  using (exists (
    select 1 from public.salons s join public.profiles p on p.id = s.owner_id
     where s.id = salon_feature_overrides.salon_id and p.user_id = auth.uid()
  ));

grant all on table public.feature_catalog, public.plan_feature_rules, public.operator_admins, public.salon_feature_overrides,
  public.salon_entitlement_state, public.salon_feature_holds to service_role;
grant select, insert on table public.operator_audit_log to service_role;

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.salon_feature_access(uuid, text)',
    'public.salon_feature_entitled(uuid, text)',
    'public.salon_entitlement_snapshot(uuid)',
    'public.salon_feature_access_all(uuid)',
    'public.salon_feature_hold_open(uuid, text)',
    'public.entitlement_actor()',
    'public.entitlement_touch(uuid, text, jsonb, jsonb)',
    'public.reservation_entitlement_block(uuid, text[], boolean)',
    'public.operator_is_active(uuid)',
    'public.admin_update_salon_entitlements(uuid, uuid, bigint, jsonb, jsonb, text, uuid)',
    'public.feature_hold_release(uuid, uuid, text, uuid, text, uuid)',
    'public.admin_list_salons(text, text, text, boolean, timestamptz, uuid, integer)',
    'public.admin_get_salon(uuid)',
    'public.admin_audit_log(uuid, bigint, integer)',
    'public.salon_entitlement_state_init()',
    'public.salon_plan_entitlement_touch()',
    'public.salon_override_entitlement_touch()',
    'public.feature_catalog_entitlement_touch()',
    'public.plan_rule_entitlement_touch()',
    'public.salon_entitlement_settle()',
    'public.operator_audit_log_immutable()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end;
$$;

-- 作り直した既存の関数は、0022 と同じ権限に戻す(create or replace は権限を保つが、明示しておく)。
revoke all on function public.notifications_list_pollable_salons(text[]) from public, anon, authenticated;
revoke all on function public.gmail_scan_acquire(uuid, uuid, timestamptz, interval) from public, anon, authenticated;
revoke all on function public.notifications_claim_delivery_v2(uuid, text[], interval, interval) from public, anon, authenticated;
revoke all on function public.notifications_begin_send(uuid, uuid, text[], interval, interval, interval) from public, anon, authenticated;
revoke all on function public.reservation_ops_customer_start(uuid, uuid, text[]) from public, anon, authenticated;
revoke all on function public.reservation_ops_activate(uuid, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.notifications_list_pollable_salons(text[]) to service_role;
grant execute on function public.gmail_scan_acquire(uuid, uuid, timestamptz, interval) to service_role;
grant execute on function public.notifications_claim_delivery_v2(uuid, text[], interval, interval) to service_role;
grant execute on function public.notifications_begin_send(uuid, uuid, text[], interval, interval, interval) to service_role;
grant execute on function public.reservation_ops_customer_start(uuid, uuid, text[]) to service_role;
grant execute on function public.reservation_ops_activate(uuid, text, timestamptz, text) to service_role;
