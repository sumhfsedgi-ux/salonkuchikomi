-- LINE 通知先の招待(オーナーが招待リンク・QR を発行し、スタッフ本人が LINE ログインで連携する)と、
-- 通知先の解除・再登録の世代管理、定期処理の締切のための配信の巻き戻し。
-- (docs/plans/lavi-notification-cutover-plan.md §「LINE 通知先」・§「実行時間」)
--
-- 【状態】本番・共有 DB には未適用(2026-10-09 時点。テスト用DBにだけ適用して検証)。適用順は 0021 → 0022 → 0023。
-- 何度実行しても同じ結果になるように書く。0009・0020 は本番適用済みのため書き換えない。
--
-- 【既存の本番の通知を守るために】
--   - 旧サービス(hmail)の LINE Messaging API チャネルの Webhook・トークンは使わない・変えない。スタッフの本人確認は、
--     同じプロバイダーの LINE ログインチャネル(未作成。作成・設定されるまでアプリ側で未有効化)で行う。
--     LINE 公式: "If the provider is the same, the user ID is the same regardless of the channel type
--     (LINE Login channel or Messaging API channel)."
--   - hmail の表には触れない。表示名などは public.line_connections にだけ保存する。

-- ------------------------------------------------------------------
-- 1. 通知先(line_connections)の由来・解除・登録の世代
-- ------------------------------------------------------------------

alter table public.line_connections add column if not exists removed_at timestamptz;
alter table public.line_connections add column if not exists removed_by text;
alter table public.line_connections add column if not exists added_via text;
alter table public.line_connections add column if not exists invite_id uuid;
-- 解除のあと同じ人を再び登録したら +1。配信は作成時の世代を持ち、世代が違う配信は送らない
-- (解除前の配信が、再登録のあとに送信・再試行されないように)。
alter table public.line_connections add column if not exists registration_generation integer not null default 1;
-- 招待で登録・再登録した日時。これより前に届いた予約のメールは、この通知先へは送らない
-- (旧サービスから引き継いだ通知先・運営が登録した通知先は null = 下限なし)。
alter table public.line_connections add column if not exists recipient_since timestamptz;
alter table public.line_connections drop constraint if exists line_connections_added_via_check;
alter table public.line_connections add constraint line_connections_added_via_check
  check (added_via is null or added_via in ('hmail_migration', 'invite', 'operator'));
update public.line_connections set added_via = 'hmail_migration'
 where added_via is null and migrated_from_hmail_salon_id is not null;

alter table public.notification_deliveries add column if not exists recipient_generation integer not null default 1;
-- 解除・再登録などで、以後の送信・再試行を止めた配信(状態は書き換えない。送信を始めていた通信は取り消せない)。
alter table public.notification_deliveries add column if not exists retry_stopped_at timestamptz;
alter table public.notification_deliveries add column if not exists retry_stop_reason text;
-- 送信直前の確認でこの処理権が first_attempt_at を付けたか(締切のために送信を取りやめたとき、元に戻すため)。
alter table public.notification_deliveries add column if not exists first_attempt_token uuid;

-- ------------------------------------------------------------------
-- 2. 招待・連携の進行・LINE ログインの state
-- ------------------------------------------------------------------

-- 招待。リンクの値(推測できない乱数)は保存せず、sha256 だけを持つ。24時間・1人の登録で使用済み。
create table if not exists public.line_recipient_invites (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons (id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 40),
  created_by uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by uuid,
  used_at timestamptz,
  used_line_connection_id uuid,
  reissued_from uuid references public.line_recipient_invites (id) on delete set null,
  check (not (used_at is not null and revoked_at is not null))
);
create index if not exists line_recipient_invites_salon_idx on public.line_recipient_invites (salon_id, created_at desc);

-- 招待1件 × ブラウザ1つの連携の進行。ブラウザとの結び付け(httpOnly の cookie の値)は sha256 だけを持つ。
-- コールバックのあと、生の招待トークン無しに結果の表示・再試行ができるようにする(任意の戻り先は受け付けない)。
create table if not exists public.line_invite_flows (
  id uuid primary key default gen_random_uuid(),
  invite_id uuid not null references public.line_recipient_invites (id) on delete cascade,
  browser_binding_hash text not null check (browser_binding_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_outcome text check (last_outcome in (
    'cancelled', 'not_friend', 'temporary_failure', 'registered', 'already_registered', 'invite_invalid'
  )),
  last_outcome_at timestamptz,
  line_connection_id uuid,
  unique (invite_id, browser_binding_hash)
);
create index if not exists line_invite_flows_binding_idx on public.line_invite_flows (browser_binding_hash, created_at desc);

-- LINE ログインの state(1回限り・10分)。nonce は sha256 だけを持ち、ID トークンの検証の結果の nonce を
-- ハッシュにして比べる。PKCE の verifier は暗号化して持つ(lib/google/tokenBox.ts)。
create table if not exists public.line_login_states (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  flow_id uuid not null references public.line_invite_flows (id) on delete cascade,
  nonce_hash text not null check (nonce_hash ~ '^[0-9a-f]{64}$'),
  code_verifier_ciphertext text not null,
  code_verifier_iv text not null,
  code_verifier_tag text not null,
  key_version text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

-- ------------------------------------------------------------------
-- 3. 切り替え待ちの間に変更できない通知先・設定(画面・Server Action・DB で同じ判定を使う)
-- ------------------------------------------------------------------

-- 旧サービス利用店舗の切り替え待ち(旧側がまだ通知している)。
create or replace function public.salon_settings_locked_for_cutover(p_salon_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.reservation_notification_operations o
     where o.salon_id = p_salon_id and o.state = 'awaiting_cutover' and o.legacy_source is not null
  );
$$;

-- 旧側で使われている(旧サービスから引き継いだ)通知先か。表示名ではなく、移行の記録で判定する。
create or replace function public.line_recipient_is_legacy(p_salon_id uuid, p_connection_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.line_connections lc
     where lc.id = p_connection_id and lc.salon_id = p_salon_id
       and (lc.migrated_from_hmail_salon_id is not null
            or lc.added_via = 'hmail_migration'
            or exists (
              select 1 from public.legacy_cutover_snapshots s
               where s.salon_id = p_salon_id and s.legacy_salon_id = lc.id::text
            ))
  );
$$;

-- 切り替え待ちの間は、旧側で使われている通知先の ON/OFF・解除を受け付けない(旧側には反映されないため)。
-- 旧側で使われていない新規追加先は変更できる。
create or replace function public.line_recipient_change_locked(p_salon_id uuid, p_connection_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select public.salon_settings_locked_for_cutover(p_salon_id)
     and public.line_recipient_is_legacy(p_salon_id, p_connection_id);
$$;

-- 通知先の一覧(画面用)。解除済みは除く。LINE の userId(destination_id)は返さない。
create or replace function public.line_recipient_list(p_salon_id uuid)
returns table (
  id uuid, label text, status text, new_reservation_enabled boolean, cancellation_enabled boolean,
  linked_at timestamptz, origin text, change_locked boolean, has_destination boolean
)
language sql
stable
set search_path = ''
as $$
  select lc.id, lc.label, lc.status, lc.new_reservation_enabled, lc.cancellation_enabled, lc.linked_at,
         case when public.line_recipient_is_legacy(p_salon_id, lc.id) then 'legacy'
              else coalesce(lc.added_via, 'operator') end,
         public.line_recipient_change_locked(p_salon_id, lc.id),
         lc.destination_id is not null
    from public.line_connections lc
   where lc.salon_id = p_salon_id and lc.removed_at is null
   order by lc.linked_at nulls last, lc.created_at, lc.id;
$$;

-- 予約通知の全体スイッチ。切り替え待ちの間は変更を受け付けない。
create or replace function public.notification_settings_set_master(p_salon_id uuid, p_enabled boolean)
returns text
language plpgsql
set search_path = ''
as $$
begin
  if public.salon_settings_locked_for_cutover(p_salon_id) then
    return 'locked';
  end if;
  insert into public.notification_settings (salon_id, master_enabled, updated_at)
  values (p_salon_id, p_enabled, now())
  on conflict (salon_id) do update set master_enabled = excluded.master_enabled, updated_at = now();
  return 'updated';
end;
$$;

-- 通知先の ON/OFF・表示名。他の店舗の通知先は対象外。ロック中の通知先は ON/OFF だけ拒否(表示名は SalonPack 側だけの値なので可)。
create or replace function public.line_recipient_update(
  p_salon_id uuid, p_connection_id uuid, p_new_reservation boolean, p_cancellation boolean, p_label text
) returns text
language plpgsql
set search_path = ''
as $$
declare
  v_lc public.line_connections;
begin
  select * into v_lc from public.line_connections lc
   where lc.id = p_connection_id and lc.salon_id = p_salon_id and lc.removed_at is null for update;
  if not found then
    return 'not_found';
  end if;
  if (p_new_reservation is not null or p_cancellation is not null)
     and public.line_recipient_change_locked(p_salon_id, p_connection_id) then
    return 'locked';
  end if;
  if p_label is not null and char_length(btrim(p_label)) not between 1 and 40 then
    return 'invalid_label';
  end if;
  update public.line_connections lc
     set new_reservation_enabled = coalesce(p_new_reservation, lc.new_reservation_enabled),
         cancellation_enabled = coalesce(p_cancellation, lc.cancellation_enabled),
         label = coalesce(btrim(p_label), lc.label),
         updated_at = now()
   where lc.id = p_connection_id;
  return 'updated';
end;
$$;

-- 口コミ通知(口コミブランチの表。統合したときだけ存在する)を、その通知先について止める。
-- 既定は OFF(行が無ければ OFF)なので、ここでは OFF にするだけで、ON にすることはない。
-- 送信をまだ一度も始めていない(pending で first_attempt_at・attempt_started_at が無い)口コミ通知だけを skipped にし、
-- 送信を試みた記録は書き換えない(口コミ側の再試行の停止・登録の世代の確認は、口コミブランチ側で同じ考え方の実装が必要)。
create or replace function public.line_recipient_stop_review_notifications(p_salon_id uuid, p_connection_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if to_regclass('public.line_notification_preferences') is not null then
    execute 'update public.line_notification_preferences set new_review_enabled = false, updated_at = now()
              where line_connection_id = $1 and new_review_enabled'
      using p_connection_id;
  end if;
  if to_regclass('public.review_notification_deliveries') is not null then
    execute 'update public.review_notification_deliveries set status = ''skipped'', last_error = ''recipient_removed'', finished_at = now()
              where line_connection_id = $1 and salon_id = $2 and status = ''pending''
                and first_attempt_at is null and attempt_started_at is null'
      using p_connection_id, p_salon_id;
  end if;
end;
$$;

-- 通知先の解除。行は残す(配信の記録・世代のため)。
--   - 切り替え待ちの間、旧側で使われている通知先は拒否する。
--   - 送信を一度も始めていない配信(pending / retry_wait、first_attempt_at も send_started_at も無い)は、
--     未送信と断定できるので skipped にする。
--   - 送信を試みた配信・送信中の配信は状態を変えず、retry_stopped_at を付けて以後の再試行を止める
--     (送信を始めていた通信は取り消せない。結果はそのまま記録される)。
create or replace function public.line_recipient_remove(p_salon_id uuid, p_connection_id uuid, p_by text)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_lc public.line_connections;
begin
  select * into v_lc from public.line_connections lc
   where lc.id = p_connection_id and lc.salon_id = p_salon_id and lc.removed_at is null for update;
  if not found then
    return 'not_found';
  end if;
  if public.line_recipient_change_locked(p_salon_id, p_connection_id) then
    return 'locked';
  end if;
  update public.line_connections lc
     set status = 'not_connected', removed_at = now(), removed_by = p_by, updated_at = now()
   where lc.id = p_connection_id;
  update public.notification_deliveries d
     set status = 'skipped', skip_reason = 'recipient_removed', updated_at = now()
   where d.line_connection_id = p_connection_id
     and d.status in ('pending', 'retry_wait')
     and d.first_attempt_at is null and d.send_started_at is null;
  update public.notification_deliveries d
     set retry_stopped_at = now(), retry_stop_reason = 'recipient_removed', updated_at = now()
   where d.line_connection_id = p_connection_id
     and d.retry_stopped_at is null
     and d.status in ('unknown', 'retry_wait', 'claimed', 'pending');
  perform public.line_recipient_stop_review_notifications(p_salon_id, p_connection_id);
  return 'removed';
end;
$$;

-- 招待の作成(1店舗あたり、有効な未使用の招待は20件まで)。
create or replace function public.line_invite_create(
  p_salon_id uuid, p_token_hash text, p_display_name text, p_by uuid, p_ttl interval default interval '24 hours',
  p_reissued_from uuid default null
) returns table (id uuid, expires_at timestamptz)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_active integer;
begin
  -- 同じ店舗の招待の作成を直列にする(上限の数え間違いを防ぐ。salons の行はロックしない)。
  perform pg_advisory_xact_lock(hashtextextended('line_invite:' || p_salon_id::text, 0));
  select count(*) into v_active from public.line_recipient_invites i
   where i.salon_id = p_salon_id and i.used_at is null and i.revoked_at is null and i.expires_at > now();
  if v_active >= 20 then
    raise exception 'line_invite:too_many_active' using errcode = 'P0001';
  end if;
  return query
    insert into public.line_recipient_invites (salon_id, token_hash, display_name, created_by, expires_at, reissued_from)
    values (p_salon_id, p_token_hash, btrim(p_display_name), p_by, now() + p_ttl, p_reissued_from)
    returning line_recipient_invites.id, line_recipient_invites.expires_at;
end;
$$;

-- 未使用の招待の一覧(画面用。トークンは保存していないので返せない)。
create or replace function public.line_invite_list(p_salon_id uuid)
returns table (id uuid, display_name text, created_at timestamptz, expires_at timestamptz, expired boolean)
language sql
stable
set search_path = ''
as $$
  select i.id, i.display_name, i.created_at, i.expires_at, i.expires_at <= now()
    from public.line_recipient_invites i
   where i.salon_id = p_salon_id and i.used_at is null and i.revoked_at is null
     and i.expires_at > now() - interval '7 days'
   order by i.created_at desc;
$$;

-- 招待の取消(その店舗の未使用の招待だけ)。
create or replace function public.line_invite_revoke(p_salon_id uuid, p_invite_id uuid, p_by uuid)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_invite public.line_recipient_invites;
begin
  select * into v_invite from public.line_recipient_invites i
   where i.id = p_invite_id and i.salon_id = p_salon_id for update;
  if not found then
    return 'not_found';
  end if;
  if v_invite.used_at is not null then
    return 'already_used';
  end if;
  if v_invite.revoked_at is not null then
    return 'already_revoked';
  end if;
  update public.line_recipient_invites i set revoked_at = now(), revoked_by = p_by where i.id = p_invite_id;
  return 'revoked';
end;
$$;

-- 招待の再発行: 古い招待を取り消し(期限切れでも可)、同じ表示名で新しい招待を作る。
drop function if exists public.line_invite_reissue(uuid, uuid, text, uuid);
create function public.line_invite_reissue(p_salon_id uuid, p_invite_id uuid, p_new_token_hash text, p_by uuid)
returns table (outcome text, id uuid, expires_at timestamptz, display_name text)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_invite public.line_recipient_invites;
begin
  select * into v_invite from public.line_recipient_invites i
   where i.id = p_invite_id and i.salon_id = p_salon_id for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::timestamptz, null::text;
    return;
  end if;
  if v_invite.used_at is not null then
    return query select 'already_used'::text, null::uuid, null::timestamptz, null::text;
    return;
  end if;
  if v_invite.revoked_at is null then
    update public.line_recipient_invites i set revoked_at = now(), revoked_by = p_by where i.id = p_invite_id;
  end if;
  return query
    select 'reissued'::text, c.id, c.expires_at, v_invite.display_name
      from public.line_invite_create(p_salon_id, p_new_token_hash, v_invite.display_name, p_by, interval '24 hours', p_invite_id) c;
end;
$$;

-- 招待の状態(招待ページ用)。有効なときだけ店舗名・表示名を返す。
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
    else 'valid'
  end;
$$;

create or replace function public.line_invite_lookup(p_token_hash text)
returns table (status text, salon_name text, display_name text)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_invite public.line_recipient_invites;
  v_status text;
begin
  select * into v_invite from public.line_recipient_invites i where i.token_hash = p_token_hash;
  v_status := public.line_invite_status(v_invite);
  if v_status <> 'valid' then
    return query select v_status, null::text, null::text;
    return;
  end if;
  return query
    select v_status, s.name, v_invite.display_name from public.salons s where s.id = v_invite.salon_id;
end;
$$;

-- 連携の開始: 有効な招待なら、このブラウザの進行を作る(同じブラウザ・同じ招待なら使い直す)。
create or replace function public.line_flow_start(p_token_hash text, p_binding_hash text)
returns table (status text, flow_id uuid)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_invite public.line_recipient_invites;
  v_status text;
  v_flow uuid;
begin
  select * into v_invite from public.line_recipient_invites i where i.token_hash = p_token_hash for share;
  v_status := public.line_invite_status(v_invite);
  if v_status <> 'valid' then
    return query select v_status, null::uuid;
    return;
  end if;
  insert into public.line_invite_flows (invite_id, browser_binding_hash, expires_at)
  values (v_invite.id, p_binding_hash, v_invite.expires_at)
  on conflict (invite_id, browser_binding_hash) do update set expires_at = excluded.expires_at
  returning line_invite_flows.id into v_flow;
  return query select 'valid'::text, v_flow;
end;
$$;

-- 以前の版の「このブラウザの最新の進行」を返す関数は使わない(別のタブで開いた別の招待に切り替わるため)。
drop function if exists public.line_flow_for_binding(text);

-- 画面に表示した招待の進行(id で指定)を、このブラウザ(cookie の値のハッシュ)のものであるときだけ返す。
-- 連携の開始・結果の表示・再試行は、すべてこの id で同じ招待に結び付ける(ブラウザ全体の「最新」では選ばない)。
-- 別のブラウザの id・改ざんした id・24時間より前の進行は返さない。
create or replace function public.line_flow_get(p_flow_id uuid, p_binding_hash text)
returns table (
  flow_id uuid, invite_status text, last_outcome text, salon_name text, display_name text,
  registered_label text, registered_salon_name text
)
language sql
stable
set search_path = ''
as $$
  select f.id, public.line_invite_status(i), f.last_outcome, s.name, i.display_name,
         lc.label, rs.name
    from public.line_invite_flows f
    join public.line_recipient_invites i on i.id = f.invite_id
    join public.salons s on s.id = i.salon_id
    left join public.line_connections lc on lc.id = f.line_connection_id
    left join public.salons rs on rs.id = lc.salon_id
   where f.id = p_flow_id
     and f.browser_binding_hash = p_binding_hash
     and f.created_at > now() - interval '24 hours';
$$;

-- LINE ログインの state を作る。指定した進行が、このブラウザのもので、期限内で、招待が有効で、まだ登録していない
-- ときだけ作る(作らなかったら false)。確認と作成を同じ関数で行い、画面から送られた id だけを信じない。
drop function if exists public.line_login_create_state(text, uuid, text, text, text, text, text, interval);
create or replace function public.line_login_create_state(
  p_state_hash text, p_flow_id uuid, p_binding_hash text, p_nonce_hash text,
  p_ciphertext text, p_iv text, p_tag text, p_key_version text, p_ttl interval default interval '10 minutes'
) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_ok boolean;
begin
  select true into v_ok
    from public.line_invite_flows f
    join public.line_recipient_invites i on i.id = f.invite_id
   where f.id = p_flow_id
     and f.browser_binding_hash = p_binding_hash
     and f.expires_at > now()
     and f.last_outcome is distinct from 'registered'
     and public.line_invite_status(i) = 'valid'
   for share of f, i;
  if v_ok is null then
    return false;
  end if;
  insert into public.line_login_states
    (state_hash, flow_id, nonce_hash, code_verifier_ciphertext, code_verifier_iv, code_verifier_tag, key_version, expires_at)
  values (p_state_hash, p_flow_id, p_nonce_hash, p_ciphertext, p_iv, p_tag, p_key_version, now() + p_ttl);
  return true;
end;
$$;

-- 使えなかった state(期限切れ・使用済み)が、このブラウザのどの進行のものか(結果ページで同じ招待を表示するため)。
-- 別のブラウザの state なら返さない。
create or replace function public.line_login_state_flow(p_state_hash text, p_binding_hash text)
returns uuid
language sql
stable
set search_path = ''
as $$
  select st.flow_id
    from public.line_login_states st
    join public.line_invite_flows f on f.id = st.flow_id
   where st.state_hash = p_state_hash and f.browser_binding_hash = p_binding_hash;
$$;

-- state を1回だけ消費する。同じブラウザ(cookie の値のハッシュ)からのコールバックで、期限内のときだけ返す。
create or replace function public.line_login_consume_state(p_state_hash text, p_binding_hash text)
returns table (flow_id uuid, nonce_hash text, code_verifier_ciphertext text, code_verifier_iv text, code_verifier_tag text, key_version text)
language sql
set search_path = ''
as $$
  update public.line_login_states st
     set used_at = now()
   where st.state_hash = p_state_hash
     and st.used_at is null
     and st.expires_at > now()
     and exists (
       select 1 from public.line_invite_flows f
        where f.id = st.flow_id and f.browser_binding_hash = p_binding_hash and f.expires_at > now()
     )
  returning st.flow_id, st.nonce_hash, st.code_verifier_ciphertext, st.code_verifier_iv, st.code_verifier_tag, st.key_version;
$$;

-- 進行の結果を記録する。登録が済んだ進行は、同じ招待の別のタブのキャンセル・失敗で上書きしない。
create or replace function public.line_flow_record_outcome(p_flow_id uuid, p_outcome text)
returns void
language sql
set search_path = ''
as $$
  update public.line_invite_flows f set last_outcome = p_outcome, last_outcome_at = now()
   where f.id = p_flow_id and f.last_outcome is distinct from 'registered';
$$;

-- 招待の使用(登録)。1つのトランザクションで、招待の使用済みと通知先の登録を整合させる。
--   - 招待・進行が有効でなければ、何もしない('invite_invalid')。
--   - 同じ店舗に同じ LINE の宛先が登録済み(解除していない)なら上書きせず 'already_registered'(招待は使わない)。
--   - 解除済みなら同じ行を戻し、登録の世代を進める(解除前の配信は送らない)。
--   - 運用状態・Google 連携・契約・旧サービスの切り替えの状態には触れない。
create or replace function public.line_invite_redeem(p_flow_id uuid, p_destination_id text)
returns table (outcome text, line_connection_id uuid)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_flow public.line_invite_flows;
  v_invite public.line_recipient_invites;
  v_lc public.line_connections;
  v_id uuid;
begin
  if p_destination_id is null or p_destination_id !~ '^U[0-9a-f]{32}$' then
    raise exception 'line_invite:invalid_destination' using errcode = 'P0001';
  end if;
  select * into v_flow from public.line_invite_flows f where f.id = p_flow_id for update;
  if not found or v_flow.expires_at <= now() then
    return query select 'invite_invalid'::text, null::uuid;
    return;
  end if;
  select * into v_invite from public.line_recipient_invites i where i.id = v_flow.invite_id for update;
  if public.line_invite_status(v_invite) <> 'valid' then
    update public.line_invite_flows f set last_outcome = 'invite_invalid', last_outcome_at = now()
     where f.id = p_flow_id and f.last_outcome is distinct from 'registered';
    return query select 'invite_invalid'::text, null::uuid;
    return;
  end if;

  select * into v_lc from public.line_connections lc
   where lc.salon_id = v_invite.salon_id and lc.destination_id = p_destination_id for update;
  if found and v_lc.removed_at is null then
    update public.line_invite_flows f
       set last_outcome = 'already_registered', last_outcome_at = now(), line_connection_id = v_lc.id
     where f.id = p_flow_id;
    return query select 'already_registered'::text, v_lc.id;
    return;
  end if;

  if found then
    update public.line_connections lc
       set status = 'connected', removed_at = null, removed_by = null,
           label = v_invite.display_name, new_reservation_enabled = true, cancellation_enabled = true,
           linked_at = now(), added_via = 'invite', invite_id = v_invite.id,
           registration_generation = lc.registration_generation + 1, recipient_since = now(), updated_at = now()
     where lc.id = v_lc.id;
    v_id := v_lc.id;
    perform public.line_recipient_stop_review_notifications(v_invite.salon_id, v_id);
  else
    begin
      insert into public.line_connections
        (salon_id, destination_id, label, status, new_reservation_enabled, cancellation_enabled, linked_at,
         added_via, invite_id, recipient_since)
      values
        (v_invite.salon_id, p_destination_id, v_invite.display_name, 'connected', true, true, now(),
         'invite', v_invite.id, now())
      returning id into v_id;
    exception when unique_violation then
      -- 同じ宛先が同時に登録された: 上書きせず「登録済み」(この招待は使わない)。
      select lc.id into v_id from public.line_connections lc
       where lc.salon_id = v_invite.salon_id and lc.destination_id = p_destination_id;
      update public.line_invite_flows f
         set last_outcome = 'already_registered', last_outcome_at = now(), line_connection_id = v_id
       where f.id = p_flow_id;
      return query select 'already_registered'::text, v_id;
      return;
    end;
  end if;

  update public.line_recipient_invites i set used_at = now(), used_line_connection_id = v_id where i.id = v_invite.id;
  update public.line_invite_flows f
     set last_outcome = 'registered', last_outcome_at = now(), line_connection_id = v_id
   where f.id = p_flow_id;
  return query select 'registered'::text, v_id;
end;
$$;

-- ------------------------------------------------------------------
-- 4. 配信の関数(0022 のものを置き換える): 登録の世代・解除・締切のための巻き戻し
-- ------------------------------------------------------------------

-- メールの分類と、送信先ごとの配信行の作成を1つのトランザクションで行う。
-- 送信先は、呼び出し側の一覧ではなく、挿入するときの通知先の状態で決める(解除済み・解除後に再登録した人の、
-- 登録より前に届いたメールの配信は作らない)。配信には、そのときの登録の世代と送信先を記録する。
create or replace function public.notifications_classify_email(
  p_processed_id uuid, p_event_type text, p_line_text text, p_mail_received_at timestamptz, p_recipients jsonb
) returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_salon uuid;
  v_message text;
  v_handover boolean;
  v_count integer;
begin
  update public.processed_emails
     set event_type = p_event_type, mail_received_at = p_mail_received_at
   where id = p_processed_id and event_type = 'pending'
  returning salon_id, provider_message_id, handover into v_salon, v_message, v_handover;
  if v_salon is null then
    return -1;
  end if;
  if p_recipients is null or jsonb_array_length(p_recipients) = 0 or p_line_text is null then
    return 0;
  end if;
  insert into public.notification_deliveries
    (salon_id, provider_message_id, line_connection_id, destination_id, event_type, line_text, mail_received_at, handover,
     recipient_generation)
  select v_salon, v_message, lc.id, lc.destination_id, p_event_type, p_line_text, p_mail_received_at, v_handover,
         lc.registration_generation
    from jsonb_array_elements(p_recipients) r
    join public.line_connections lc on lc.id = (r->>'line_connection_id')::uuid
   where lc.salon_id = v_salon
     and lc.status = 'connected' and lc.removed_at is null and lc.destination_id is not null
     and (lc.recipient_since is null or p_mail_received_at is null or p_mail_received_at >= lc.recipient_since)
  on conflict (provider_message_id, line_connection_id) where manual_resend_of is null do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- 配信を1件、処理権付きで取り出す(0022 から: 再試行を止めた配信を除く)。
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
      join public.salons s on s.id = o.salon_id
     where o.salon_id = p_salon_id and o.state = 'active' and s.plan = any(p_allowed_plans)
       and exists (
         select 1 from public.salon_feature_selections f
          where f.salon_id = p_salon_id and f.feature_key = 'reservation_notifications' and f.selected
       )
  ) then
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

-- 送信の直前確認(0022 から: 通知先の行を共有ロックして、解除済み・登録の世代違いを確かめる。
-- first_attempt_at を付けたときは first_attempt_token に処理権を記録する)。
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
  v_plan text;
  v_master boolean;
  v_selected boolean;
  v_salon_reason text;
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
  select s.plan into v_plan from public.salons s where s.id = v_d.salon_id;
  select coalesce((select ns.master_enabled from public.notification_settings ns where ns.salon_id = v_d.salon_id), true)
    into v_master;
  select coalesce((
    select f.selected from public.salon_feature_selections f
     where f.salon_id = v_d.salon_id and f.feature_key = 'reservation_notifications'
  ), false) into v_selected;

  v_salon_reason := case
    when v_o.salon_id is null then 'no_operations'
    when v_o.state <> 'active' then 'state_' || v_o.state
    when v_plan is null or not (v_plan = any(p_allowed_plans)) then 'plan_not_allowed'
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
         and i.kind in ('manual_feature_off', 'manual_master_off', 'operator_pause', 'contract', 'legacy_active')
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

-- 締切のため、取り出した配信を送らずに戻す(送信直前の確認の前。送信を始めていないので未送信と断定できる)。
create or replace function public.notifications_release_claim(p_id uuid, p_claim_token uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.notification_deliveries d
     set status = coalesce(d.claimed_from_status, 'pending'), claim_token = null, claimed_at = null,
         claimed_from_status = null, attempts = greatest(d.attempts - 1, 0), updated_at = now()
   where d.id = p_id and d.status = 'claimed' and d.claim_token = p_claim_token and d.send_started_at is null;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

-- 締切のため、送信直前の確認('send')のあとに LINE を呼ばずにやめた(未送信と断定できる)。
-- 送信開始の記録と、この確認で付けた最初の送信日時を戻す。LINE を呼んだあとには使わない。
create or replace function public.notifications_cancel_send_start(p_id uuid, p_claim_token uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.notification_deliveries d
     set status = coalesce(d.claimed_from_status, 'pending'),
         first_attempt_at = case when d.first_attempt_token = p_claim_token then null else d.first_attempt_at end,
         first_attempt_token = case when d.first_attempt_token = p_claim_token then null else d.first_attempt_token end,
         send_started_at = null, claim_token = null, claimed_at = null, claimed_from_status = null,
         attempts = greatest(d.attempts - 1, 0), updated_at = now()
   where d.id = p_id and d.status = 'claimed' and d.claim_token = p_claim_token and d.send_started_at is not null;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

-- ------------------------------------------------------------------
-- 5. RLS とブラウザからのアクセス拒否
-- ------------------------------------------------------------------

alter table public.line_recipient_invites enable row level security;
alter table public.line_invite_flows enable row level security;
alter table public.line_login_states enable row level security;
revoke all on table public.line_recipient_invites from anon, authenticated;
revoke all on table public.line_invite_flows from anon, authenticated;
revoke all on table public.line_login_states from anon, authenticated;

do $$
declare
  v_sig text;
begin
  foreach v_sig in array array[
    'public.salon_settings_locked_for_cutover(uuid)',
    'public.line_recipient_is_legacy(uuid, uuid)',
    'public.line_recipient_change_locked(uuid, uuid)',
    'public.line_recipient_list(uuid)',
    'public.notification_settings_set_master(uuid, boolean)',
    'public.line_recipient_update(uuid, uuid, boolean, boolean, text)',
    'public.line_recipient_stop_review_notifications(uuid, uuid)',
    'public.line_recipient_remove(uuid, uuid, text)',
    'public.line_invite_create(uuid, text, text, uuid, interval, uuid)',
    'public.line_invite_list(uuid)',
    'public.line_invite_revoke(uuid, uuid, uuid)',
    'public.line_invite_reissue(uuid, uuid, text, uuid)',
    'public.line_invite_status(public.line_recipient_invites)',
    'public.line_invite_lookup(text)',
    'public.line_flow_start(text, text)',
    'public.line_flow_get(uuid, text)',
    'public.line_login_create_state(text, uuid, text, text, text, text, text, text, interval)',
    'public.line_login_state_flow(text, text)',
    'public.line_login_consume_state(text, text)',
    'public.line_flow_record_outcome(uuid, text)',
    'public.line_invite_redeem(uuid, text)',
    'public.notifications_classify_email(uuid, text, text, timestamptz, jsonb)',
    'public.notifications_claim_delivery_v2(uuid, text[], interval, interval)',
    'public.notifications_begin_send(uuid, uuid, text[], interval, interval, interval)',
    'public.notifications_release_claim(uuid, uuid)',
    'public.notifications_cancel_send_start(uuid, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_sig);
    execute format('grant execute on function %s to service_role', v_sig);
  end loop;
end;
$$;
