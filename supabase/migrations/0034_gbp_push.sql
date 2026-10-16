-- 0034: 口コミ 第2段階 — Google の通知(Business Profile の通知設定 → Cloud Pub/Sub の push)。
-- 計画: docs/plans/reviews-alerts-stage2-plan.md §4-3・§4-5。0033 の表(gbp_auto_sync)を使う。第1段階の表・関数は変えない。
--
-- 【受信】受信の記録(messageId で一意)と、対応する選択の世代の「取り込み待ち」(gbp_auto_sync.requested_at・next_due_at)を
--   1つのトランザクションで書く(gbp_push_record)。書けてから受信側が 204 を返す(書けなければ Pub/Sub が再送する)。
--   応答の直後に処理が止まっても、取り込み待ちと未完了の受信の記録が残るので、次の定期処理が取り込む。
--   同じ messageId の再送は、まだ済んでいなければ取り込み待ちを立て直す(前回の受信の直後に止まっていても再開する)。
--   受信の記録は「その受信より後に最初から読んだ同期が最後まで終わった」ときだけ済み(done)にする(gbp_push_complete)。
--   Google の口コミの内容・口コミの名前は保存しない(振り分けに使う location 名と種類・時刻だけ。7日で消す)。
--
-- 【通知設定】Google の通知設定は GBP アカウント(accounts/{a})ごとに1つ・トピック1つ。ほかのツールのトピックが
--   入っていれば上書きしない(foreign)。SalonPack が登録した(ours)か、空(none)か、確かめられなかった(error)かを持つ。
--
-- テーブルはどれも RLS を有効にしてポリシーを作らない。関数は service role だけが実行できる。何度実行しても同じ結果になる。

create table if not exists public.gbp_push_messages (
  message_id text primary key check (char_length(message_id) between 1 and 200),
  notification_type text check (char_length(notification_type) <= 40),
  location_name text check (location_name ~ '^locations/[^/]+$'),
  location_id uuid references public.gbp_locations(id) on delete set null,
  publish_time timestamptz,
  received_at timestamptz not null default now(),
  status text not null check (status in ('received', 'done', 'ignored')),
  done_at timestamptz
);
create index if not exists gbp_push_messages_pending on public.gbp_push_messages (location_id, received_at) where status = 'received';
create index if not exists gbp_push_messages_received on public.gbp_push_messages (received_at);

create table if not exists public.gbp_notification_registrations (
  account_name text primary key check (account_name ~ '^accounts/[^/]+$'),
  state text not null check (state in ('ours', 'foreign', 'none', 'error')),
  google_account_id uuid references public.google_accounts(id) on delete set null,
  checked_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.gbp_push_messages enable row level security;
alter table public.gbp_notification_registrations enable row level security;
revoke all on table public.gbp_push_messages from anon, authenticated;
revoke all on table public.gbp_notification_registrations from anon, authenticated;

-- 取り込み待ちにする(失敗が続いて間隔を延ばしている世代は、待ちの時刻を早めない)。
create or replace function public.gbp_push_request_sync(p_location_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into public.gbp_auto_sync as s (location_id, salon_id, next_due_at, requested_at)
  select l.id, l.salon_id, now(), now() from public.gbp_locations l where l.id = p_location_id
  on conflict (location_id) do update
    set requested_at = coalesce(s.requested_at, now()),
        next_due_at = case when s.consecutive_failures = 0 then least(s.next_due_at, now()) else s.next_due_at end,
        updated_at = now();
end;
$$;

-- 受信を記録する。戻り値: recorded / ignored(どの店舗にも当たらない) / duplicate_pending(再送。取り込み待ちを立て直した)
--   / duplicate_done(再送。済み・対象外)
create or replace function public.gbp_push_record(
  p_message_id text, p_notification_type text, p_location_name text, p_publish_time timestamptz
) returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_m public.gbp_push_messages;
  v_location uuid;
begin
  if p_message_id is null or char_length(p_message_id) not between 1 and 200
     or (p_location_name is not null and p_location_name !~ '^locations/[^/]+$') then
    raise exception 'gbp_push:invalid_arguments' using errcode = '22023';
  end if;
  select * into v_m from public.gbp_push_messages m where m.message_id = p_message_id for update;
  if found then
    if v_m.status <> 'received' then
      return 'duplicate_done';
    end if;
    if v_m.location_id is not null
       and exists (select 1 from public.gbp_locations l where l.id = v_m.location_id and l.status = 'active') then
      perform public.gbp_push_request_sync(v_m.location_id);
      return 'duplicate_pending';
    end if;
    update public.gbp_push_messages m set status = 'ignored', done_at = now() where m.message_id = p_message_id;
    return 'duplicate_done';
  end if;

  select l.id into v_location from public.gbp_locations l
   where l.location_name = p_location_name and l.status = 'active';
  insert into public.gbp_push_messages (message_id, notification_type, location_name, location_id, publish_time, status, done_at)
  values (p_message_id, left(p_notification_type, 40), p_location_name, v_location, p_publish_time,
          case when v_location is null then 'ignored' else 'received' end,
          case when v_location is null then now() end)
  on conflict (message_id) do nothing;
  if v_location is null then
    return 'ignored';
  end if;
  perform public.gbp_push_request_sync(v_location);
  return 'recorded';
end;
$$;

-- その世代で、最初から読んだ同期(p_run_started_at に始めたもの)が最後まで終わった。それより前に受けた通知を済みにする。
create or replace function public.gbp_push_complete(p_location_id uuid, p_run_started_at timestamptz)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.gbp_push_messages m
     set status = 'done', done_at = now()
   where m.location_id = p_location_id and m.status = 'received' and m.received_at <= p_run_started_at;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- 7日を過ぎた受信の記録を消す(状態に関係なく)。
create or replace function public.gbp_push_purge(p_retention interval default interval '7 days')
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.gbp_push_messages m where m.received_at <= now() - p_retention;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- 通知設定の確認・登録・解除の結果を記録する。
create or replace function public.gbp_notification_registration_set(
  p_account_name text, p_state text, p_google_account_id uuid
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_account_name !~ '^accounts/[^/]+$' or p_state not in ('ours', 'foreign', 'none', 'error') then
    raise exception 'gbp_push:invalid_arguments' using errcode = '22023';
  end if;
  insert into public.gbp_notification_registrations as r (account_name, state, google_account_id, checked_at, updated_at)
  values (p_account_name, p_state, p_google_account_id, now(), now())
  on conflict (account_name) do update
    set state = excluded.state, google_account_id = excluded.google_account_id, checked_at = now(), updated_at = now();
end;
$$;

-- 通知設定の登録・解除が要る GBP アカウント。
--   register  : LINE 通知中の店舗が使っているのに、まだ SalonPack の登録が無い(未確認・空・確認できなかった。
--               確認できなかったものは1時間おいてから)。ほかのツールのトピック(foreign)は1日おいて確かめ直す
--   unregister: SalonPack が登録したが、LINE 通知中の店舗がもう無い
-- google_account_id / salon_id は、その GBP アカウントを使っている有効な世代の1つ(トークンを取るため)。
create or replace function public.gbp_notification_work()
returns table (action text, account_name text, google_account_id uuid, salon_id uuid)
language sql
stable
security invoker
set search_path = ''
as $$
  with wanted as (
    select distinct on (l.account_name) l.account_name, l.google_account_id, l.salon_id
      from public.gbp_locations l
      join public.review_alert_settings s on s.salon_id = l.salon_id and s.enabled and s.location_id = l.id
      join public.google_accounts a on a.id = l.google_account_id and a.auth_state = 'active'
     where l.status = 'active'
     order by l.account_name, l.activated_at desc
  ), usable as (
    select distinct on (l.account_name) l.account_name, l.google_account_id, l.salon_id
      from public.gbp_locations l
      join public.google_accounts a on a.id = l.google_account_id and a.auth_state = 'active'
     where l.status = 'active'
     order by l.account_name, l.activated_at desc
  )
  select 'register'::text, w.account_name, w.google_account_id, w.salon_id
    from wanted w
    left join public.gbp_notification_registrations r on r.account_name = w.account_name
   where r.account_name is null
      or r.state = 'none'
      or (r.state = 'error' and r.checked_at <= now() - interval '1 hour')
      or (r.state = 'foreign' and r.checked_at <= now() - interval '1 day')
  union all
  select 'unregister'::text, r.account_name, u.google_account_id, u.salon_id
    from public.gbp_notification_registrations r
    join usable u on u.account_name = r.account_name
   where r.state = 'ours' and not exists (select 1 from wanted w where w.account_name = r.account_name)
$$;

-- Google の通知を受けている(SalonPack が登録した)Google アカウント(自動取得の間隔を延ばす)。
create or replace function public.gbp_push_active_accounts()
returns table (google_account_id uuid)
language sql
stable
security invoker
set search_path = ''
as $$
  select distinct l.google_account_id
    from public.gbp_locations l
    join public.gbp_notification_registrations r on r.account_name = l.account_name and r.state = 'ours'
   where l.status = 'active'
$$;

revoke all on function public.gbp_push_request_sync(uuid) from public, anon, authenticated;
revoke all on function public.gbp_push_record(text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.gbp_push_complete(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.gbp_push_purge(interval) from public, anon, authenticated;
revoke all on function public.gbp_notification_registration_set(text, text, uuid) from public, anon, authenticated;
revoke all on function public.gbp_notification_work() from public, anon, authenticated;
revoke all on function public.gbp_push_active_accounts() from public, anon, authenticated;
grant execute on function public.gbp_push_request_sync(uuid) to service_role;
grant execute on function public.gbp_push_record(text, text, text, timestamptz) to service_role;
grant execute on function public.gbp_push_complete(uuid, timestamptz) to service_role;
grant execute on function public.gbp_push_purge(interval) to service_role;
grant execute on function public.gbp_notification_registration_set(text, text, uuid) to service_role;
grant execute on function public.gbp_notification_work() to service_role;
grant execute on function public.gbp_push_active_accounts() to service_role;
