-- 0033: 口コミ 第2段階(新着の自動取得と LINE 通知)。
-- 計画: docs/plans/reviews-alerts-stage2-plan.md。第1段階(0027〜0032)の表・関数は作り直さない(新しい表・関数・トリガーだけ)。
--
-- 【新着の起点】第1段階の gbp_ingest_reviews は、選択の世代の中で口コミ1件につき最初の1回だけ gbp_review_index に行を挿入する
--   (以後は ON CONFLICT DO UPDATE)。その AFTER INSERT のトリガーで、初回の取り込みが終わった世代(initial_sync_done_at あり。
--   第1段階の「新着」と同じ)のときだけ、通知のイベントを1行作る。手動の［更新］・自動取得・Google の通知のどれでも同じ。
--   初回の取り込みの分・投稿者の編集・25日後の取り直し・同時の取り込みは、イベントにならないか1件だけになる。
--   イベントには口コミの内容・Google の ID・HMAC を持たない(SalonPack の索引の id だけ)。
--
-- 【通知するか】イベントの評価(review_alert_evaluate)で、ロックして決める。Google の投稿日時 C が、通知の開始・再開の時刻、
--   その世代を選んだ時刻、通知先の登録時刻、通知先の口コミ通知を ON にした時刻のどれよりも後で、検知まで72時間以内のとき。
--   処理した時点で ON かどうかではなく投稿日時で決める(検知・評価が遅れても、ON にする前の口コミは届かない)。
--
-- 【LINE】通知先は予約通知と共通の line_connections(0023)。配信・停止・重複防止は口コミ専用の表で持ち、予約通知の表
--   (notification_deliveries)・旧口コミブランチの表(line_notification_preferences・review_notification_deliveries。
--   0023 の line_recipient_stop_review_notifications が参照する)とは別の名前にし、それらは読み書きしない。
--   解除・再登録・OFF の結果は、送信直前の確認(review_alert_begin_send)で 0023 の意図と同じにする
--   (送信を始めていない配信は送らない・送信を試みた配信は再試行だけ止める・再登録した通知先は OFF)。
--   送る内容は登録店舗名と SalonPack の確認用 URL だけ(口コミの本文・評価・投稿者名は送らない)。配信行の作成時に確定する。
--
-- 【利用可否】google_reviews の判定(0032: プラン・口コミの個別設定・利用区分・google_reviews の提供状態)に従う。
--   利用可から利用不可になったら、LINE 通知を止める(再許可だけでは再開しない。お客様が再開する)。
--
-- 【ロックの順】イベント・配信の行 → 利用可否の基準行(FOR SHARE) → 選択の世代(gbp_locations) → 通知の設定
--   → 通知先(line_connections) → 通知先ごとの設定。停止・OFF は配信の行を SKIP LOCKED で扱い、送信直前の確認と待ち合わせない。
--
-- テーブルはどれも RLS を有効にしてポリシーを作らない。関数は service role だけが実行できる。何度実行しても同じ結果になる。

-- ------------------------------------------------------------------
-- 1. 自動取得
-- ------------------------------------------------------------------

-- 選択の世代(gbp_locations の行)ごとの、自動取得の予定と結果。行が無い世代は「すぐ取得する」。
create table if not exists public.gbp_auto_sync (
  location_id uuid primary key references public.gbp_locations(id) on delete cascade,
  salon_id uuid not null references public.salons(id) on delete cascade,
  next_due_at timestamptz not null default now(),
  requested_at timestamptz,
  last_started_at timestamptz,
  last_success_at timestamptz,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  last_error_kind text check (char_length(last_error_kind) <= 60),
  updated_at timestamptz not null default now()
);
create index if not exists gbp_auto_sync_due on public.gbp_auto_sync (next_due_at);

-- 自動取得で見た refresh token の失効(invalid_grant)。Google アカウント × トークンの世代ごと。
-- アカウントの認証状態(google_accounts.auth_state)は変えない(予約通知の Gmail の判定・停止の記録・連絡に影響させない)。
-- 同じ世代で2回続いたら、そのアカウントの自動取得を止める。再連携でトークンの世代が変われば無効になる。
create table if not exists public.gbp_auto_auth_holds (
  google_account_id uuid primary key references public.google_accounts(id) on delete cascade,
  token_generation integer not null,
  failures integer not null default 0 check (failures >= 0),
  first_failed_at timestamptz not null default now(),
  last_failed_at timestamptz not null default now()
);

-- 定期処理の実行の記録(件数だけ。口コミの内容は持たない)。30日で消す。
create table if not exists public.gbp_auto_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  stats jsonb not null default '{}'::jsonb check (jsonb_typeof(stats) = 'object')
);
create index if not exists gbp_auto_runs_started on public.gbp_auto_runs (started_at desc);

-- ------------------------------------------------------------------
-- 2. LINE 通知
-- ------------------------------------------------------------------

-- 店舗ごとの通知の設定。開始・再開のたびに notify_from を今にし、epoch を進める。
create table if not exists public.review_alert_settings (
  salon_id uuid primary key references public.salons(id) on delete cascade,
  enabled boolean not null default false,
  notify_from timestamptz,
  epoch integer not null default 0 check (epoch >= 0),
  location_id uuid references public.gbp_locations(id) on delete set null,
  started_by uuid,
  started_at timestamptz,
  stopped_at timestamptz,
  stop_reason text check (stop_reason in ('owner', 'entitlement', 'target_changed', 'consent')),
  version integer not null default 0 check (version >= 0),
  last_test_at timestamptz,
  updated_at timestamptz not null default now()
);

-- 通知先(予約通知と共通の line_connections)ごとの口コミ通知の ON/OFF。
-- 有効なのは enabled かつ registration_generation が今の通知先の世代と同じとき(解除・再登録で自動的に OFF)。
create table if not exists public.review_alert_recipients (
  line_connection_id uuid primary key references public.line_connections(id) on delete cascade,
  salon_id uuid not null references public.salons(id) on delete cascade,
  enabled boolean not null default false,
  on_since timestamptz,
  registration_generation integer,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  check (not enabled or (on_since is not null and registration_generation is not null))
);
create index if not exists review_alert_recipients_salon on public.review_alert_recipients (salon_id);

-- 新しい口コミ1件につき1行(通知するかの判断の記録)。口コミの内容・Google の ID は持たない。
create table if not exists public.review_alert_events (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons(id) on delete cascade,
  location_id uuid not null references public.gbp_locations(id) on delete cascade,
  review_index_id uuid references public.gbp_review_index(id) on delete set null,
  detected_at timestamptz not null default now(),
  source text not null check (source in ('manual', 'reconcile', 'pubsub')),
  decision text not null default 'pending' check (decision in ('pending', 'notify', 'skipped')),
  skip_reason text check (char_length(skip_reason) <= 60),
  epoch integer,
  decided_at timestamptz,
  unique (review_index_id)
);
create index if not exists review_alert_events_pending on public.review_alert_events (detected_at) where decision = 'pending';
create index if not exists review_alert_events_salon on public.review_alert_events (salon_id, detected_at desc);

-- 通知先ごとの配信。送る内容(message)は作成時に確定し、再試行では同じ内容・同じ retry key・同じ宛先で送る。
create table if not exists public.review_alert_deliveries (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons(id) on delete cascade,
  event_id uuid references public.review_alert_events(id) on delete set null,
  line_connection_id uuid not null references public.line_connections(id) on delete cascade,
  destination_id text not null,
  recipient_generation integer not null,
  recipient_on_since timestamptz not null,
  epoch integer not null,
  location_id uuid references public.gbp_locations(id) on delete set null,
  message jsonb not null check (jsonb_typeof(message) = 'object'),
  line_retry_key uuid not null default gen_random_uuid(),
  status text not null default 'pending'
    check (status in ('pending', 'claimed', 'sent', 'unknown', 'retry_wait', 'failed', 'skipped', 'expired')),
  claim_token uuid,
  claimed_at timestamptz,
  claimed_from_status text,
  attempts integer not null default 0 check (attempts >= 0),
  first_attempt_at timestamptz,
  first_attempt_token uuid,
  send_started_at timestamptz,
  next_attempt_at timestamptz,
  line_request_id text check (char_length(line_request_id) <= 100),
  last_error text check (char_length(last_error) <= 120),
  skip_reason text check (char_length(skip_reason) <= 60),
  retry_stopped_at timestamptz,
  retry_stop_reason text check (char_length(retry_stop_reason) <= 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (event_id, line_connection_id)
);
create index if not exists review_alert_deliveries_open
  on public.review_alert_deliveries (created_at) where status in ('pending', 'claimed', 'unknown', 'retry_wait');
create index if not exists review_alert_deliveries_salon on public.review_alert_deliveries (salon_id, created_at desc);
create index if not exists review_alert_deliveries_connection
  on public.review_alert_deliveries (line_connection_id) where status in ('pending', 'claimed', 'unknown', 'retry_wait');

alter table public.gbp_auto_sync enable row level security;
alter table public.gbp_auto_auth_holds enable row level security;
alter table public.gbp_auto_runs enable row level security;
alter table public.review_alert_settings enable row level security;
alter table public.review_alert_recipients enable row level security;
alter table public.review_alert_events enable row level security;
alter table public.review_alert_deliveries enable row level security;
revoke all on table public.gbp_auto_sync from anon, authenticated;
revoke all on table public.gbp_auto_auth_holds from anon, authenticated;
revoke all on table public.gbp_auto_runs from anon, authenticated;
revoke all on table public.review_alert_settings from anon, authenticated;
revoke all on table public.review_alert_recipients from anon, authenticated;
revoke all on table public.review_alert_events from anon, authenticated;
revoke all on table public.review_alert_deliveries from anon, authenticated;

-- ------------------------------------------------------------------
-- 3. トリガー
-- ------------------------------------------------------------------

-- 新しい口コミ(索引の新しい行)。初回の取り込みが終わった世代のときだけイベントにする。
-- 通知の ON/OFF・利用可否はここでは見ない(後の評価で決める。開始の操作と取り込みが同時でも取りこぼさない)。
create or replace function public.review_alert_on_review_index()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.gbp_locations l where l.id = new.location_id and l.initial_sync_done_at is not null) then
    insert into public.review_alert_events (salon_id, location_id, review_index_id, source)
    values (new.salon_id, new.location_id, new.id, new.detected_via)
    on conflict (review_index_id) do nothing;
  end if;
  return null;
end;
$$;
drop trigger if exists review_alert_on_review_index on public.gbp_review_index;
create trigger review_alert_on_review_index
  after insert on public.gbp_review_index
  for each row execute function public.review_alert_on_review_index();

-- 選択の世代が無効になった(店舗の選び直し・アカウントの切り替え・口コミの結び付けの解除)。その世代で通知していた店舗の
-- LINE 通知を止める(再開を求める)。
create or replace function public.review_alert_on_location_inactive()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.review_alert_settings s
     set enabled = false, stopped_at = now(), stop_reason = 'target_changed', version = s.version + 1, updated_at = now()
   where s.location_id = old.id and s.enabled;
  return null;
end;
$$;
drop trigger if exists review_alert_on_location_inactive on public.gbp_locations;
create trigger review_alert_on_location_inactive
  after update of status on public.gbp_locations
  for each row
  when (old.status = 'active' and new.status is distinct from 'active')
  execute function public.review_alert_on_location_inactive();

-- 利用可否の確定(0024 の salon_entitlement_settle が committed_entitled を書く)で、google_reviews が使えなくなった。
-- LINE 通知を止める。再び使えるようになっても自動では再開しない。
create or replace function public.review_alert_on_entitlement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.review_alert_settings s
     set enabled = false, stopped_at = now(), stop_reason = 'entitlement', version = s.version + 1, updated_at = now()
   where s.salon_id = new.salon_id and s.enabled;
  return null;
end;
$$;
drop trigger if exists review_alert_on_entitlement on public.salon_entitlement_state;
create trigger review_alert_on_entitlement
  after update of committed_entitled on public.salon_entitlement_state
  for each row
  when (coalesce((old.committed_entitled ->> 'google_reviews')::boolean, false)
        and not coalesce((new.committed_entitled ->> 'google_reviews')::boolean, false))
  execute function public.review_alert_on_entitlement();

-- ------------------------------------------------------------------
-- 4. 自動取得の関数
-- ------------------------------------------------------------------

-- 自動取得の対象(期限が来た・Google の通知を受けた・途中の同期の続き)。利用可否・同意(今の版)・結び付け・アカウントの
-- 認証状態・自動取得の認証失敗の記録・同期の処理権で絞る。
create or replace function public.gbp_auto_due_locations(p_consent_version text, p_limit integer)
returns table (
  salon_id uuid, location_id uuid, google_account_id uuid, token_generation integer,
  run_in_progress boolean, requested boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  select l.salon_id, l.id, l.google_account_id, a.token_generation, l.sync_run_kind is not null, s.requested_at is not null
    from public.gbp_locations l
    join public.salon_google_bindings b
      on b.salon_id = l.salon_id and b.feature = 'gbp' and b.google_account_id = l.google_account_id
     and b.gbp_selection_state = 'selected' and b.scope_missing_since is null
    join public.google_accounts a on a.id = l.google_account_id and a.auth_state = 'active'
    left join public.gbp_auto_sync s on s.location_id = l.id
   where l.status = 'active'
     and (s.location_id is null or s.next_due_at <= now())
     and (l.sync_lease_until is null or l.sync_lease_until <= now())
     and not exists (select 1 from public.gbp_auto_auth_holds h
                      where h.google_account_id = a.id and h.token_generation = a.token_generation and h.failures >= 2)
     and public.salon_feature_entitled(l.salon_id, 'google_reviews')
     and public.gbp_has_connect_consent(l.salon_id, p_consent_version)
   order by s.requested_at is not null desc, s.next_due_at nulls first, l.id
   limit greatest(p_limit, 0)
$$;

-- 自動取得を始める(開始の時刻を記録して返す)。
create or replace function public.gbp_auto_begin(p_salon_id uuid, p_location_id uuid)
returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_at timestamptz := now();
begin
  insert into public.gbp_auto_sync as s (location_id, salon_id, last_started_at, updated_at)
  values (p_location_id, p_salon_id, v_at, v_at)
  on conflict (location_id) do update set last_started_at = v_at, updated_at = v_at;
  return v_at;
end;
$$;

-- 自動取得の結果を記録し、次の予定を決める。
--   complete: 次は p_next_seconds 後。最初から始めた同期(p_fresh_run)で、開始より前に受けた Google の通知は済みにする。
--             済みにできない通知が残っていれば、次の回にすぐ取る。
--   partial : 続きを次の回に取る。
--   throttled / busy / inactive: p_next_seconds 後(失敗に数えない)。
--   failed  : 失敗を数え、p_next_seconds × 2^(それまでの連続の失敗の数) 後(最長6時間)。
create or replace function public.gbp_auto_finish(
  p_location_id uuid, p_outcome text, p_attempt_started_at timestamptz, p_fresh_run boolean,
  p_next_seconds integer, p_error_kind text
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_outcome not in ('complete', 'partial', 'throttled', 'busy', 'inactive', 'failed')
     or p_next_seconds is null or p_next_seconds not between 0 and 86400 then
    raise exception 'gbp_auto:invalid_arguments' using errcode = '22023';
  end if;
  update public.gbp_auto_sync s
     set requested_at = case
           when p_outcome = 'complete' and coalesce(p_fresh_run, false) and s.requested_at <= p_attempt_started_at then null
           else s.requested_at end,
         last_success_at = case when p_outcome = 'complete' then now() else s.last_success_at end,
         consecutive_failures = case when p_outcome = 'failed' then s.consecutive_failures + 1
                                     when p_outcome in ('complete', 'partial') then 0
                                     else s.consecutive_failures end,
         last_error_kind = case when p_outcome = 'failed' then left(p_error_kind, 60)
                                when p_outcome in ('complete', 'partial') then null
                                else s.last_error_kind end,
         next_due_at = case when p_outcome = 'partial' then now()
                            -- 失敗が続くほど間隔を延ばす(最長6時間)
                            when p_outcome = 'failed' then now() + make_interval(secs => least(
                              p_next_seconds * power(2, least(s.consecutive_failures, 8))::integer, 21600))
                            else now() + make_interval(secs => p_next_seconds) end,
         updated_at = now()
   where s.location_id = p_location_id;
  -- 済みにできなかった Google の通知が残っていれば、次の回にすぐ取る(失敗の待ち時間の間は除く)。
  update public.gbp_auto_sync s
     set next_due_at = now()
   where s.location_id = p_location_id and p_outcome = 'complete' and s.requested_at is not null;
end;
$$;

-- 自動取得での refresh token の失効の記録(p_ok で消す)。戻り値は同じ世代での連続の回数。
create or replace function public.gbp_auto_auth_record(p_google_account_id uuid, p_token_generation integer, p_ok boolean)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_failures integer;
begin
  if p_ok then
    delete from public.gbp_auto_auth_holds h where h.google_account_id = p_google_account_id;
    return 0;
  end if;
  insert into public.gbp_auto_auth_holds as h (google_account_id, token_generation, failures)
  values (p_google_account_id, p_token_generation, 1)
  on conflict (google_account_id) do update
    set failures = case when h.token_generation = excluded.token_generation then h.failures + 1 else 1 end,
        first_failed_at = case when h.token_generation = excluded.token_generation then h.first_failed_at else now() end,
        token_generation = excluded.token_generation,
        last_failed_at = now()
  returning h.failures into v_failures;
  return v_failures;
end;
$$;

-- 定期処理の実行の記録(件数だけ)。
create or replace function public.gbp_auto_run_record(p_started_at timestamptz, p_stats jsonb)
returns uuid
language sql
security invoker
set search_path = ''
as $$
  insert into public.gbp_auto_runs (started_at, finished_at, stats)
  values (coalesce(p_started_at, now()), now(), case when jsonb_typeof(p_stats) = 'object' then p_stats else '{}'::jsonb end)
  returning id
$$;

-- ------------------------------------------------------------------
-- 5. LINE 通知の設定
-- ------------------------------------------------------------------

-- 今使える選択の世代(初回の取り込み済み)。無ければ null。
create or replace function public.review_alert_current_location(p_salon_id uuid)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select l.id from public.gbp_locations l
   where l.salon_id = p_salon_id and l.status = 'active' and l.initial_sync_done_at is not null
     and public.gbp_location_usable(p_salon_id, l.id)
   limit 1
$$;

-- 口コミ通知が有効な通知先の数(接続中・解除なし・世代が同じ・ON)。
create or replace function public.review_alert_active_recipient_count(p_salon_id uuid)
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
  select count(*)::integer
    from public.review_alert_recipients r
    join public.line_connections lc on lc.id = r.line_connection_id and lc.salon_id = r.salon_id
   where r.salon_id = p_salon_id and r.enabled and r.registration_generation = lc.registration_generation
     and lc.removed_at is null and lc.status = 'connected' and lc.destination_id is not null
$$;

-- お客様の「LINE通知を開始する」「再開する」。画面を開いた時点の版(p_expected_version)のときだけ書く。
--   started / changed / not_entitled / consent_required / not_ready(店舗の選択・初回の取り込みがまだ) / no_recipients
create or replace function public.review_alert_start(
  p_salon_id uuid, p_user_id uuid, p_expected_version integer, p_consent_version text
) returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_s public.review_alert_settings;
  v_location uuid;
begin
  -- ロックの順: 利用可否の基準行 → 選択の世代 → 通知の設定
  if not public.gbp_reviews_entitled(p_salon_id) then
    return 'not_entitled';
  end if;
  perform 1 from public.gbp_locations l where l.salon_id = p_salon_id and l.status = 'active' for share;
  insert into public.review_alert_settings (salon_id) values (p_salon_id) on conflict (salon_id) do nothing;
  select * into v_s from public.review_alert_settings s where s.salon_id = p_salon_id for update;
  if v_s.version is distinct from p_expected_version then
    return 'changed';
  end if;
  if not public.gbp_has_connect_consent(p_salon_id, p_consent_version) then
    return 'consent_required';
  end if;
  v_location := public.review_alert_current_location(p_salon_id);
  if v_location is null then
    return 'not_ready';
  end if;
  if public.review_alert_active_recipient_count(p_salon_id) = 0 then
    return 'no_recipients';
  end if;
  update public.review_alert_settings s
     set enabled = true, notify_from = now(), epoch = s.epoch + 1, location_id = v_location,
         started_by = p_user_id, started_at = now(), stopped_at = null, stop_reason = null,
         version = s.version + 1, updated_at = now()
   where s.salon_id = p_salon_id;
  return 'started';
end;
$$;

-- お客様の「LINE通知を停止する」。送信を始めていない配信は送らない(skipped)。送信を試みた配信は状態を変えずに
-- 再試行だけ止める。送信直前の確認と待ち合わせないよう、処理中の配信は SKIP LOCKED で飛ばす(送信直前の確認が止める)。
-- 戻り値: outcome(stopped / already_stopped)と、取り消せない(送信を始めた・結果が分からない)配信の数。
create or replace function public.review_alert_stop(p_salon_id uuid, p_user_id uuid)
returns table (outcome text, in_flight integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_s public.review_alert_settings;
  v_in_flight integer;
begin
  select * into v_s from public.review_alert_settings s where s.salon_id = p_salon_id for update;
  if not found or not v_s.enabled then
    return query select 'already_stopped'::text, 0;
    return;
  end if;
  update public.review_alert_settings s
     set enabled = false, stopped_at = now(), stop_reason = 'owner', version = s.version + 1, updated_at = now()
   where s.salon_id = p_salon_id;

  with t as (
    select d.id from public.review_alert_deliveries d
     where d.salon_id = p_salon_id and d.status in ('pending', 'retry_wait')
       and d.first_attempt_at is null and d.send_started_at is null
     for update skip locked
  )
  update public.review_alert_deliveries d
     set status = 'skipped', skip_reason = 'stopped_by_owner', finished_at = now(), updated_at = now()
    from t where d.id = t.id;

  with t as (
    select d.id from public.review_alert_deliveries d
     where d.salon_id = p_salon_id and d.status in ('unknown', 'retry_wait') and d.first_attempt_at is not null
       and d.retry_stopped_at is null
     for update skip locked
  )
  update public.review_alert_deliveries d
     set retry_stopped_at = now(), retry_stop_reason = 'stopped_by_owner', updated_at = now()
    from t where d.id = t.id;

  select count(*)::integer into v_in_flight
    from public.review_alert_deliveries d
   where d.salon_id = p_salon_id
     and ((d.status = 'claimed' and d.send_started_at is not null) or d.status = 'unknown');
  return query select 'stopped'::text, v_in_flight;
end;
$$;

-- 通知先ごとの口コミ通知の ON/OFF。ON にした時刻(on_since)と、そのときの通知先の世代を記録する。
-- OFF にしたら、その通知先の送信を始めていない配信は送らず、送信を試みた配信は再試行を止める(ON に戻しても復活しない)。
--   updated / unchanged / not_found(他店舗・解除済み・未接続)
create or replace function public.review_alert_set_recipient(
  p_salon_id uuid, p_line_connection_id uuid, p_enabled boolean, p_user_id uuid
) returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_lc public.line_connections;
  v_r public.review_alert_recipients;
begin
  select * into v_lc from public.line_connections lc
   where lc.id = p_line_connection_id and lc.salon_id = p_salon_id
   for share;
  if not found or v_lc.removed_at is not null then
    return 'not_found';
  end if;
  if p_enabled and (v_lc.status <> 'connected' or v_lc.destination_id is null) then
    return 'not_found';
  end if;
  select * into v_r from public.review_alert_recipients r where r.line_connection_id = p_line_connection_id for update;
  if p_enabled then
    if found and v_r.enabled and v_r.registration_generation = v_lc.registration_generation then
      return 'unchanged';
    end if;
    insert into public.review_alert_recipients as r (line_connection_id, salon_id, enabled, on_since, registration_generation,
                                                     updated_by, updated_at)
    values (p_line_connection_id, p_salon_id, true, now(), v_lc.registration_generation, p_user_id, now())
    on conflict (line_connection_id) do update
      set enabled = true, on_since = now(), registration_generation = excluded.registration_generation,
          updated_by = p_user_id, updated_at = now();
    return 'updated';
  end if;

  if not found or not v_r.enabled then
    return 'unchanged';
  end if;
  update public.review_alert_recipients r
     set enabled = false, on_since = null, registration_generation = null, updated_by = p_user_id, updated_at = now()
   where r.line_connection_id = p_line_connection_id;

  with t as (
    select d.id from public.review_alert_deliveries d
     where d.line_connection_id = p_line_connection_id and d.status in ('pending', 'retry_wait')
       and d.first_attempt_at is null and d.send_started_at is null
     for update skip locked
  )
  update public.review_alert_deliveries d
     set status = 'skipped', skip_reason = 'recipient_off', finished_at = now(), updated_at = now()
    from t where d.id = t.id;
  with t as (
    select d.id from public.review_alert_deliveries d
     where d.line_connection_id = p_line_connection_id and d.status in ('unknown', 'retry_wait')
       and d.first_attempt_at is not null and d.retry_stopped_at is null
     for update skip locked
  )
  update public.review_alert_deliveries d
     set retry_stopped_at = now(), retry_stop_reason = 'recipient_off', updated_at = now()
    from t where d.id = t.id;
  return 'updated';
end;
$$;

-- 利用可否の確認から漏れた店舗の通知を止める(トリガーの補い。定期処理が毎回呼ぶ)。止めた店舗の数を返す。
create or replace function public.review_alert_sweep_entitlement()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.review_alert_settings s
     set enabled = false, stopped_at = now(), stop_reason = 'entitlement', version = s.version + 1, updated_at = now()
   where s.enabled and not public.salon_feature_entitled(s.salon_id, 'google_reviews');
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- テスト通知の連打を防ぐ(10秒に1回)。送ってよければ true。
create or replace function public.review_alert_test_slot(p_salon_id uuid, p_min_interval interval default interval '10 seconds')
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into public.review_alert_settings (salon_id) values (p_salon_id) on conflict (salon_id) do nothing;
  update public.review_alert_settings s
     set last_test_at = now()
   where s.salon_id = p_salon_id and (s.last_test_at is null or s.last_test_at <= now() - p_min_interval);
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

-- ------------------------------------------------------------------
-- 6. 評価(通知するかを決め、通知先ごとの配信を作る)
-- ------------------------------------------------------------------

-- 戻り値: notify / skipped:<理由> / already_decided / not_found
--   p_base_url: SalonPack の本番の URL(https://…)。確認用のリンクは p_base_url || '/dashboard/reviews/google/' || 索引の id。
--   p_window: 投稿から検知までの上限(障害で遅れた分。既定72時間)。
--   p_stale_after: 検知から評価までの上限(定期処理が止まっていた分。既定24時間。過ぎたら送らない)。
create or replace function public.review_alert_evaluate(
  p_event_id uuid, p_base_url text, p_consent_version text,
  p_window interval default interval '72 hours',
  p_stale_after interval default interval '24 hours'
) returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_e public.review_alert_events;
  v_s public.review_alert_settings;
  v_l public.gbp_locations;
  v_created timestamptz;
  v_salon_name text;
  v_reason text;
  v_count integer;
  v_stop text;
begin
  if p_base_url is null or p_base_url !~ '^https?://[^/\s]+$' then
    raise exception 'review_alert:invalid_base_url' using errcode = '22023';
  end if;
  select * into v_e from public.review_alert_events e where e.id = p_event_id for update;
  if not found then
    return 'not_found';
  end if;
  if v_e.decision <> 'pending' then
    return 'already_decided';
  end if;

  -- ロックの順: 利用可否の基準行 → 選択の世代 → 通知の設定
  if not public.gbp_reviews_entitled(v_e.salon_id) then
    v_reason := 'not_entitled';
    v_stop := 'entitlement';
  end if;
  select * into v_l from public.gbp_locations l where l.id = v_e.location_id for share;
  select * into v_s from public.review_alert_settings s where s.salon_id = v_e.salon_id for update;

  if v_reason is null then
    v_reason := case
      when v_s.salon_id is null or not v_s.enabled then 'alerts_off'
      when v_s.location_id is distinct from v_e.location_id
           or not public.gbp_location_usable(v_e.salon_id, v_e.location_id) then 'target_changed'
      when not public.gbp_has_connect_consent(v_e.salon_id, p_consent_version) then 'consent_required'
      when v_e.review_index_id is null then 'review_gone'
      else null
    end;
    if v_reason = 'consent_required' then
      v_stop := 'consent';
    end if;
  end if;

  if v_reason is null then
    select c.create_time into v_created from public.gbp_review_cache c where c.review_index_id = v_e.review_index_id;
    v_reason := case
      when v_created is null then 'review_gone'
      when v_created < v_s.notify_from then 'before_start'
      when v_created < v_l.activated_at then 'before_selection'
      when v_e.detected_at - v_created > p_window then 'too_old'
      when v_e.detected_at < now() - p_stale_after then 'stale'
      else null
    end;
  end if;

  if v_stop is not null and v_s.salon_id is not null and v_s.enabled then
    update public.review_alert_settings s
       set enabled = false, stopped_at = now(), stop_reason = v_stop, version = s.version + 1, updated_at = now()
     where s.salon_id = v_e.salon_id;
  end if;

  if v_reason is null then
    select s.name into v_salon_name from public.salons s where s.id = v_e.salon_id;
    insert into public.review_alert_deliveries (salon_id, event_id, line_connection_id, destination_id, recipient_generation,
                                                recipient_on_since, epoch, location_id, message)
    select v_e.salon_id, v_e.id, lc.id, lc.destination_id, lc.registration_generation, r.on_since, v_s.epoch, v_e.location_id,
           jsonb_build_object('salon_name', left(coalesce(v_salon_name, ''), 100),
                              'url', p_base_url || '/dashboard/reviews/google/' || v_e.review_index_id::text)
      from public.review_alert_recipients r
      join public.line_connections lc on lc.id = r.line_connection_id and lc.salon_id = r.salon_id
     where r.salon_id = v_e.salon_id and r.enabled and r.registration_generation = lc.registration_generation
       and lc.removed_at is null and lc.status = 'connected' and lc.destination_id is not null
       and v_created >= r.on_since
       and (lc.recipient_since is null or v_created >= lc.recipient_since)
    on conflict (event_id, line_connection_id) do nothing;
    get diagnostics v_count = row_count;
    if v_count = 0 then
      v_reason := 'no_recipients';
    end if;
  end if;

  update public.review_alert_events e
     set decision = case when v_reason is null then 'notify' else 'skipped' end,
         skip_reason = v_reason, epoch = v_s.epoch, decided_at = now()
   where e.id = p_event_id;
  return case when v_reason is null then 'notify' else 'skipped:' || v_reason end;
end;
$$;

-- 評価を待っているイベント(古い順)。
create or replace function public.review_alert_pending_events(p_limit integer)
returns table (id uuid, salon_id uuid)
language sql
stable
security invoker
set search_path = ''
as $$
  select e.id, e.salon_id from public.review_alert_events e
   where e.decision = 'pending'
   order by e.detected_at, e.id
   limit greatest(p_limit, 0)
$$;

-- ------------------------------------------------------------------
-- 7. 配信(予約通知の notifications_* と同じ形。表は口コミ専用)
-- ------------------------------------------------------------------

-- 配信を1つ取り出す(全店舗から古い順)。取り出したまま期限の切れた配信は戻す(送信を始めていたら結果不明)。
create or replace function public.review_alert_claim(
  p_lease interval default interval '2 minutes',
  p_retry_window interval default interval '23 hours',
  p_max_attempts integer default 20
) returns setof public.review_alert_deliveries
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
begin
  update public.review_alert_deliveries
     set status = case when send_started_at is not null then 'unknown' else coalesce(claimed_from_status, 'pending') end,
         last_error = case when send_started_at is not null then 'lease_expired_after_send_start' else last_error end,
         next_attempt_at = case when send_started_at is not null then now() + interval '1 minute' else next_attempt_at end,
         claim_token = null, claimed_at = null, send_started_at = null, claimed_from_status = null, updated_at = now()
   where status = 'claimed' and claimed_at < now() - p_lease;

  select d.id into v_id
    from public.review_alert_deliveries d
   where d.retry_stopped_at is null
     and d.attempts < p_max_attempts
     and (
       (d.status = 'pending' and coalesce(d.next_attempt_at, now()) <= now())
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
    update public.review_alert_deliveries d
       set claimed_from_status = d.status, status = 'claimed', claim_token = gen_random_uuid(), claimed_at = now(),
           attempts = d.attempts + 1, updated_at = now()
     where d.id = v_id
    returning d.*;
end;
$$;

-- 送信の直前確認。decision: send / skipped / released / expired / lost
create or replace function public.review_alert_begin_send(
  p_id uuid, p_claim_token uuid, p_consent_version text,
  p_stale_after interval default interval '24 hours',
  p_retry_window interval default interval '23 hours',
  p_max_attempts integer default 20
) returns table (decision text, reason text, destination_id text, message jsonb, line_retry_key uuid)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_d public.review_alert_deliveries;
  v_entitled boolean;
  v_l public.gbp_locations;
  v_s public.review_alert_settings;
  v_review uuid;
  v_lc public.line_connections;
  v_r public.review_alert_recipients;
  v_reason text;
begin
  select * into v_d from public.review_alert_deliveries d where d.id = p_id for update;
  if not found or v_d.status <> 'claimed' or v_d.claim_token is distinct from p_claim_token then
    return query select 'lost'::text, 'lease_lost'::text, null::text, null::jsonb, null::uuid;
    return;
  end if;

  -- ロックの順: 利用可否の基準行 → 選択の世代 → 通知の設定 → 通知先 → 通知先ごとの設定
  v_entitled := public.gbp_reviews_entitled(v_d.salon_id);
  select * into v_l from public.gbp_locations l where l.id = v_d.location_id for share;
  select * into v_s from public.review_alert_settings s where s.salon_id = v_d.salon_id for share;
  select e.review_index_id into v_review from public.review_alert_events e where e.id = v_d.event_id;
  select * into v_lc from public.line_connections lc where lc.id = v_d.line_connection_id for share;
  select * into v_r from public.review_alert_recipients r where r.line_connection_id = v_d.line_connection_id for share;

  v_reason := case
    when not v_entitled then 'not_entitled'
    when v_s.salon_id is null or not v_s.enabled then 'alerts_off'
    when v_s.epoch <> v_d.epoch then 'restarted'
    when v_l.id is null or v_s.location_id is distinct from v_d.location_id
         or not public.gbp_location_usable(v_d.salon_id, v_d.location_id) then 'target_changed'
    when not public.gbp_has_connect_consent(v_d.salon_id, p_consent_version) then 'consent_required'
    when v_review is null or not exists (select 1 from public.gbp_review_index i where i.id = v_review) then 'review_gone'
    when v_lc.id is null or v_lc.removed_at is not null then 'recipient_removed'
    when v_lc.registration_generation <> v_d.recipient_generation then 'recipient_reregistered'
    when v_lc.status <> 'connected' or v_lc.destination_id is null then 'recipient_disconnected'
    when v_lc.destination_id <> v_d.destination_id then 'destination_changed'
    when v_r.line_connection_id is null or not v_r.enabled
         or v_r.registration_generation is distinct from v_d.recipient_generation
         or v_r.on_since is distinct from v_d.recipient_on_since then 'recipient_off'
    else null
  end;

  if v_d.first_attempt_at is null then
    if v_reason is null and v_d.created_at < now() - p_stale_after then
      v_reason := 'stale';
    end if;
    if v_reason is not null then
      -- 一度も送信を始めていない: 未送信と断定できるので skipped。
      update public.review_alert_deliveries d
         set status = 'skipped', skip_reason = v_reason, claim_token = null, claimed_at = null, claimed_from_status = null,
             finished_at = now(), updated_at = now()
       where d.id = p_id;
      return query select 'skipped'::text, v_reason, null::text, null::jsonb, null::uuid;
      return;
    end if;
  else
    -- 送信を試みたことがある: 状態は書き換えない(送ったかもしれない)。
    if v_d.first_attempt_at <= now() - p_retry_window or v_d.attempts > p_max_attempts then
      update public.review_alert_deliveries d
         set status = 'expired', claim_token = null, claimed_at = null, claimed_from_status = null,
             last_error = coalesce(d.last_error, 'retry_window_expired'), finished_at = now(), updated_at = now()
       where d.id = p_id;
      return query select 'expired'::text, 'retry_window_expired'::text, null::text, null::jsonb, null::uuid;
      return;
    end if;
    if v_reason is not null then
      update public.review_alert_deliveries d
         set status = coalesce(d.claimed_from_status, 'unknown'), claim_token = null, claimed_at = null,
             claimed_from_status = null, retry_stopped_at = now(), retry_stop_reason = v_reason, updated_at = now()
       where d.id = p_id;
      return query select 'released'::text, 'retry_stopped:' || v_reason, null::text, null::jsonb, null::uuid;
      return;
    end if;
  end if;

  update public.review_alert_deliveries d
     set first_attempt_token = case when d.first_attempt_at is null then p_claim_token else d.first_attempt_token end,
         first_attempt_at = coalesce(d.first_attempt_at, now()), send_started_at = now(), claimed_at = now(), updated_at = now()
   where d.id = p_id;
  return query select 'send'::text, null::text, v_d.destination_id, v_d.message, v_d.line_retry_key;
end;
$$;

-- 送信結果の記録(処理権が一致するときだけ)。p_outcome: sent / failed / unknown / retry_wait
create or replace function public.review_alert_finish(
  p_id uuid, p_claim_token uuid, p_outcome text, p_line_request_id text, p_error text, p_retry_after interval
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_outcome not in ('sent', 'failed', 'unknown', 'retry_wait') then
    raise exception 'review_alert:invalid_outcome' using errcode = 'P0001';
  end if;
  update public.review_alert_deliveries d
     set status = p_outcome,
         claim_token = null, claimed_at = null, send_started_at = null, claimed_from_status = null,
         line_request_id = coalesce(left(p_line_request_id, 100), d.line_request_id),
         last_error = left(p_error, 120),
         next_attempt_at = case when p_outcome in ('unknown', 'retry_wait')
                                then now() + coalesce(p_retry_after, interval '1 minute') else null end,
         finished_at = case when p_outcome in ('sent', 'failed') then now() else d.finished_at end,
         updated_at = now()
   where d.id = p_id and d.status = 'claimed' and d.claim_token = p_claim_token;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

-- 締切のため、取り出した配信を送らずに戻す(送信直前の確認の前)。
create or replace function public.review_alert_release_claim(p_id uuid, p_claim_token uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.review_alert_deliveries d
     set status = coalesce(d.claimed_from_status, 'pending'), claim_token = null, claimed_at = null,
         claimed_from_status = null, attempts = greatest(d.attempts - 1, 0), updated_at = now()
   where d.id = p_id and d.status = 'claimed' and d.claim_token = p_claim_token and d.send_started_at is null;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

-- 締切のため、送信直前の確認('send')のあとに LINE を呼ばずにやめた(未送信と断定できる)。
create or replace function public.review_alert_cancel_send_start(p_id uuid, p_claim_token uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.review_alert_deliveries d
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
-- 8. 期限の削除(利用可否・通知の停止・連携・機能のフラグに関係なく実行する)
-- ------------------------------------------------------------------
--   ・送信を試みてから23時間を過ぎた結果不明・再試行待ち → expired(自動では送り直さない)
--   ・作ってから24時間を過ぎても送信を始めていない配信 → skipped(stale)
--   ・終わってから30日を過ぎた配信・判断済みのイベント・実行の記録・古い認証失敗の記録を消す
create or replace function public.review_alert_purge(
  p_retention interval default interval '30 days',
  p_retry_window interval default interval '23 hours',
  p_stale_after interval default interval '24 hours'
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_expired integer;
  v_stale integer;
  v_deliveries integer;
  v_events integer;
  v_runs integer;
  v_holds integer;
begin
  with t as (
    select d.id from public.review_alert_deliveries d
     where d.status in ('unknown', 'retry_wait') and d.first_attempt_at is not null
       and d.first_attempt_at <= now() - p_retry_window
     for update skip locked
  )
  update public.review_alert_deliveries d
     set status = 'expired', last_error = coalesce(d.last_error, 'retry_window_expired'), finished_at = now(), updated_at = now()
    from t where d.id = t.id;
  get diagnostics v_expired = row_count;

  with t as (
    select d.id from public.review_alert_deliveries d
     where d.status in ('pending', 'retry_wait') and d.first_attempt_at is null and d.send_started_at is null
       and d.created_at <= now() - p_stale_after
     for update skip locked
  )
  update public.review_alert_deliveries d
     set status = 'skipped', skip_reason = 'stale', finished_at = now(), updated_at = now()
    from t where d.id = t.id;
  get diagnostics v_stale = row_count;

  delete from public.review_alert_deliveries d
   where d.created_at <= now() - p_retention
     and (d.status in ('sent', 'failed', 'skipped', 'expired') or d.updated_at <= now() - p_retention);
  get diagnostics v_deliveries = row_count;
  delete from public.review_alert_events e
   where e.detected_at <= now() - p_retention
     and not exists (select 1 from public.review_alert_deliveries d where d.event_id = e.id);
  get diagnostics v_events = row_count;
  delete from public.gbp_auto_runs r where r.started_at <= now() - p_retention;
  get diagnostics v_runs = row_count;
  delete from public.gbp_auto_auth_holds h where h.last_failed_at <= now() - p_retention;
  get diagnostics v_holds = row_count;
  return jsonb_build_object('expired', v_expired, 'stale', v_stale, 'deliveries', v_deliveries, 'events', v_events,
                            'runs', v_runs, 'auth_holds', v_holds);
end;
$$;

-- ------------------------------------------------------------------
-- 8b. 招待ページの文言の出し分け(予約・口コミのどちらのお知らせが届き得るか)
-- ------------------------------------------------------------------
-- 0023 の line_flow_get と同じ条件(このブラウザの進行・24時間以内)で、招待の店舗が予約通知・Google口コミを
-- 使えるかだけを返す(店舗の id・通知先の情報は返さない)。line_flow_get は変えない。
create or replace function public.line_flow_topics(p_flow_id uuid, p_binding_hash text)
returns table (reservations boolean, reviews boolean)
language sql
stable
security invoker
set search_path = ''
as $$
  select public.salon_feature_entitled(i.salon_id, 'reservation_notifications'),
         public.salon_feature_entitled(i.salon_id, 'google_reviews')
    from public.line_invite_flows f
    join public.line_recipient_invites i on i.id = f.invite_id
   where f.id = p_flow_id
     and f.browser_binding_hash = p_binding_hash
     and f.created_at > now() - interval '24 hours';
$$;

-- ------------------------------------------------------------------
-- 9. 権限(service role だけ)
-- ------------------------------------------------------------------
revoke all on function public.review_alert_on_review_index() from public, anon, authenticated;
revoke all on function public.review_alert_on_location_inactive() from public, anon, authenticated;
revoke all on function public.review_alert_on_entitlement() from public, anon, authenticated;
revoke all on function public.gbp_auto_due_locations(text, integer) from public, anon, authenticated;
revoke all on function public.gbp_auto_begin(uuid, uuid) from public, anon, authenticated;
revoke all on function public.gbp_auto_finish(uuid, text, timestamptz, boolean, integer, text) from public, anon, authenticated;
revoke all on function public.gbp_auto_auth_record(uuid, integer, boolean) from public, anon, authenticated;
revoke all on function public.gbp_auto_run_record(timestamptz, jsonb) from public, anon, authenticated;
revoke all on function public.review_alert_pending_events(integer) from public, anon, authenticated;
revoke all on function public.review_alert_current_location(uuid) from public, anon, authenticated;
revoke all on function public.review_alert_active_recipient_count(uuid) from public, anon, authenticated;
revoke all on function public.review_alert_start(uuid, uuid, integer, text) from public, anon, authenticated;
revoke all on function public.review_alert_stop(uuid, uuid) from public, anon, authenticated;
revoke all on function public.review_alert_set_recipient(uuid, uuid, boolean, uuid) from public, anon, authenticated;
revoke all on function public.review_alert_sweep_entitlement() from public, anon, authenticated;
revoke all on function public.review_alert_test_slot(uuid, interval) from public, anon, authenticated;
revoke all on function public.review_alert_evaluate(uuid, text, text, interval, interval) from public, anon, authenticated;
revoke all on function public.review_alert_claim(interval, interval, integer) from public, anon, authenticated;
revoke all on function public.review_alert_begin_send(uuid, uuid, text, interval, interval, integer) from public, anon, authenticated;
revoke all on function public.review_alert_finish(uuid, uuid, text, text, text, interval) from public, anon, authenticated;
revoke all on function public.review_alert_release_claim(uuid, uuid) from public, anon, authenticated;
revoke all on function public.review_alert_cancel_send_start(uuid, uuid) from public, anon, authenticated;
revoke all on function public.review_alert_purge(interval, interval, interval) from public, anon, authenticated;
revoke all on function public.line_flow_topics(uuid, text) from public, anon, authenticated;
grant execute on function public.gbp_auto_due_locations(text, integer) to service_role;
grant execute on function public.gbp_auto_begin(uuid, uuid) to service_role;
grant execute on function public.gbp_auto_finish(uuid, text, timestamptz, boolean, integer, text) to service_role;
grant execute on function public.gbp_auto_auth_record(uuid, integer, boolean) to service_role;
grant execute on function public.gbp_auto_run_record(timestamptz, jsonb) to service_role;
grant execute on function public.review_alert_pending_events(integer) to service_role;
grant execute on function public.review_alert_current_location(uuid) to service_role;
grant execute on function public.review_alert_active_recipient_count(uuid) to service_role;
grant execute on function public.review_alert_start(uuid, uuid, integer, text) to service_role;
grant execute on function public.review_alert_stop(uuid, uuid) to service_role;
grant execute on function public.review_alert_set_recipient(uuid, uuid, boolean, uuid) to service_role;
grant execute on function public.review_alert_sweep_entitlement() to service_role;
grant execute on function public.review_alert_test_slot(uuid, interval) to service_role;
grant execute on function public.review_alert_evaluate(uuid, text, text, interval, interval) to service_role;
grant execute on function public.review_alert_claim(interval, interval, integer) to service_role;
grant execute on function public.review_alert_begin_send(uuid, uuid, text, interval, interval, integer) to service_role;
grant execute on function public.review_alert_finish(uuid, uuid, text, text, text, interval) to service_role;
grant execute on function public.review_alert_release_claim(uuid, uuid) to service_role;
grant execute on function public.review_alert_cancel_send_start(uuid, uuid) to service_role;
grant execute on function public.review_alert_purge(interval, interval, interval) to service_role;
grant execute on function public.line_flow_topics(uuid, text) to service_role;
