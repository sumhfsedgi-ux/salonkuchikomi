-- 予約通知の運用状態・停止期間・旧サービス(hmail)からの切り替え記録と、配信処理の強化
-- (docs/plans/lavi-notification-cutover-plan.md 参照)。
--
-- 何度実行しても同じ結果になるように書く。0009・0020 は本番適用済みのため書き換えない。
-- 【状態】この migration(と 0021)は本番・共有 DB には未適用(2026-10-08 時点。テスト用DBにだけ適用して検証)。
--
-- 【適用順と互換性】
--   1. 0021 → 2. 0022 → 3. アプリ(このブランチ)のデプロイ。
--   現在の本番デプロイ(master)は 0020 の関数も notification_deliveries も使っていない
--   (git grep で確認済み)。この migration で追加する列はすべて既定値付き(または NULL 可)で、
--   既存の挿入はそのまま通る。アプリを現在の本番デプロイへ戻しても、このスキーマのままで動く。
--   0020 の旧関数(notifications_claim_delivery / notifications_mark_delivery_outcome /
--   notifications_stale_unknown_deliveries / notifications_reclaim_stuck_email)は、新しいコードでは
--   呼ばない。ここでは削除せず、anon/authenticated/public からの実行権限だけを取り消す
--   (削除は新しいコードの本番稼働が安定した後の別 migration で行う)。
--
-- 【旧方式の'migrating'について】0020 で mail_connections.status に追加した'migrating'は、
--   トークン移行方式の廃止に伴い使わない(mail_connections 自体を新しいコードは読み書きしない)。
--   0020 の制約はそのまま残す(本番適用済みのため)。

-- ------------------------------------------------------------------
-- 1. 停止期間(遅延通知のルールに使う)
-- ------------------------------------------------------------------

-- 意図的な停止(機能OFF・通知OFF・運営による停止・契約・旧側の再稼働検知)の間に届いた予約は、
-- 再開しても送らない。障害・認証切れ・Gmail の権限不足(kind='outage'/'auth'/'gmail_scope' または
-- 記録なし)で遅れたものは、受信から24時間以内なら送る。
create table if not exists public.reservation_stop_intervals (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons (id) on delete cascade,
  kind text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  started_by text,
  ended_by text,
  note text,
  check (ended_at is null or ended_at >= started_at)
);
alter table public.reservation_stop_intervals drop constraint if exists reservation_stop_intervals_kind_check;
alter table public.reservation_stop_intervals add constraint reservation_stop_intervals_kind_check
  check (kind in (
    'outage', 'auth', 'gmail_scope', 'manual_feature_off', 'manual_master_off', 'operator_pause', 'contract',
    'legacy_active', 'legacy_cutover'
  ));
create unique index if not exists reservation_stop_intervals_open_uniq
  on public.reservation_stop_intervals (salon_id, kind) where ended_at is null;
create index if not exists reservation_stop_intervals_salon_idx
  on public.reservation_stop_intervals (salon_id, started_at);

create or replace function public.reservation_open_stop(p_salon_id uuid, p_kind text, p_by text, p_note text)
returns void
language sql
set search_path = ''
as $$
  insert into public.reservation_stop_intervals (salon_id, kind, started_by, note)
  values (p_salon_id, p_kind, p_by, p_note)
  on conflict (salon_id, kind) where ended_at is null do nothing;
$$;

create or replace function public.reservation_close_stop(p_salon_id uuid, p_kind text, p_by text)
returns void
language sql
set search_path = ''
as $$
  update public.reservation_stop_intervals
     set ended_at = now(), ended_by = p_by
   where salon_id = p_salon_id and kind = p_kind and ended_at is null;
$$;

-- ------------------------------------------------------------------
-- 2. 旧サービスからの切り替えの記録
-- ------------------------------------------------------------------

-- 予約受信用メールアドレスの比較用の形。小文字にして前後の空白を除く。gmail.com / googlemail.com は、
-- Gmail が同じ受信箱として扱うため、ローカル部のドットと「+」以降を除き、ドメインを gmail.com にそろえる。
create or replace function public.legacy_mailbox_canonical(p_address text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when v.addr is null or v.addr not like '%_@_%' then v.addr
    when split_part(v.addr, '@', 2) in ('gmail.com', 'googlemail.com') then
      replace(split_part(split_part(v.addr, '@', 1), '+', 1), '.', '') || '@gmail.com'
    else v.addr
  end
  from (select lower(btrim(p_address)) as addr) v;
$$;

-- 運営が確認した「新側の店舗 ↔ 旧側(hmail)の予約受信用 Gmail ↔ スタッフの人数」の対応表。
--   - 新側の店舗の所有者は Gmail アドレスから推定しない。運営がお客様・契約を確認して登録したものだけを使う
--     (ログイン用のメールアドレスではなく、旧側のスタッフ行が予約メールを受け取っている Gmail)。
--   - 旧側のスタッフ行は、この受信用 Gmail(hmail.mail_connections.email_address)で見つける。
--     静的移行・旧側の停止・停止確認・開始・送信直前の監視のたびに、登録したスタッフの集合と一致することを
--     確かめ(reservation_ops_legacy_check)、増えた・減った・別の受信箱に変わった場合は「確認できない」として止める。
--   - 1つの受信用 Gmail は1店舗にだけ対応させる(unique)。
create table if not exists public.legacy_salon_mappings (
  salon_id uuid primary key references public.salons (id) on delete cascade,
  legacy_source text not null default 'hmail' check (legacy_source in ('hmail')),
  legacy_mailbox text not null
    check (legacy_mailbox like '%_@_%' and legacy_mailbox = public.legacy_mailbox_canonical(legacy_mailbox)),
  expected_staff_count integer not null check (expected_staff_count between 1 and 50),
  confirmed_by text not null,
  confirmed_at timestamptz not null default now(),
  note text,
  unique (legacy_source, legacy_mailbox)
);

-- 履歴照合(旧側の送信状態をメール×スタッフごとに取り込んだ結果)。旧側停止確認・新側開始とは別に記録する。
create table if not exists public.legacy_reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons (id) on delete cascade,
  source_schema text not null,
  window_from timestamptz,
  ran_at timestamptz not null default now(),
  ran_by text not null,
  counts jsonb not null default '{}'::jsonb,
  unresolved_count integer not null default 0,
  earliest_unhandled_mail_at timestamptz,
  accepted_at timestamptz,
  accepted_by text
);
create index if not exists legacy_reconciliation_runs_salon_idx on public.legacy_reconciliation_runs (salon_id, ran_at desc);

-- 旧側(スタッフごと)の停止前の接続状態。切り戻しで全件を無条件に connected へ戻さないために使う。
create table if not exists public.legacy_cutover_snapshots (
  salon_id uuid not null references public.salons (id) on delete cascade,
  legacy_salon_id text not null,
  original_status text,
  captured_at timestamptz not null default now(),
  stop_applied_at timestamptz,
  restored_at timestamptz,
  primary key (salon_id, legacy_salon_id)
);
-- 旧側の1人のスタッフ(行)を、2つの新側の店舗に登録しない。
create unique index if not exists legacy_cutover_snapshots_legacy_uniq on public.legacy_cutover_snapshots (legacy_salon_id);

-- ------------------------------------------------------------------
-- 3. 予約通知の運用状態
-- ------------------------------------------------------------------

-- state:
--   setup_pending     旧サービスを使っていない店舗の、開始前
--   awaiting_cutover  旧サービス(hmail)利用店舗の切り替え待ち。Google に再接続しても変わらない
--   active            稼働中
--   paused            運営(またはシステム)による停止中
-- Google 認証の状態(google_accounts.auth_state)とは別に管理する。OAuth のコールバックはこの表を変更しない。
create table if not exists public.reservation_notification_operations (
  salon_id uuid primary key references public.salons (id) on delete cascade,
  state text not null default 'setup_pending' check (state in ('setup_pending', 'awaiting_cutover', 'active', 'paused')),
  legacy_source text check (legacy_source in ('hmail')),
  legacy_schema text not null default 'hmail' check (legacy_schema ~ '^[a-z_][a-z0-9_]{0,62}$'),
  legacy_stop_confirmed_at timestamptz,
  legacy_stop_confirmed_by text,
  accepted_reconciliation_id uuid references public.legacy_reconciliation_runs (id),
  -- メール取得開始日時。接続完了日時をそのまま使わない(旧側利用店舗は運営が照合結果から決め、
  -- 新規店舗はお客様が開始した日時)。理由も記録する。
  mail_fetch_since timestamptz,
  mail_fetch_since_reason text,
  activated_at timestamptz,
  activated_by text,
  paused_at timestamptz,
  paused_by text,
  pause_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (state <> 'active' or (mail_fetch_since is not null and activated_at is not null)),
  check (state <> 'active' or legacy_source is null
         or (legacy_stop_confirmed_at is not null and accepted_reconciliation_id is not null))
);
-- mail_fetch_since を決めたときに予約メールに使っていた Google アカウント。開始後に別のアカウントへ
-- 切り替えた場合だけ、切り替えた日時より前のメールを読まない(定期処理 lib/notifications/mail/fetchStart.ts)。
-- 同じアカウントの再認証・旧側からの切り替え・新規店舗の初回開始では、接続日時で取得開始を切り詰めない。
alter table public.reservation_notification_operations
  add column if not exists mail_fetch_account_id uuid references public.google_accounts (id) on delete set null;

-- 旧側(hmail)の対象スタッフの状態と、登録したスタッフの集合が今も正しいかを確かめる(読み取りのみ)。
--   旧側の行は、対応表(legacy_salon_mappings)の予約受信用 Gmail で見つける。
--   state:
--     'not_legacy'  旧サービス利用店舗ではない
--     'stopped'     登録したスタッフ全員が旧側の処理対象外で、集合も一致している
--     'active'      登録した(または同じ受信用 Gmail の)行が1つでも旧側の処理対象(connected / needs_reconnect。
--                   hmail の listActiveMailConnections と同じ)
--     'unknown'     確認できない(対応表が無い・読めない・登録後に同じ受信用 Gmail の行が増えた・登録した行が
--                   無くなった・別の受信用 Gmail に変わった・人数が対応表と違う)
--   'unknown' と 'active' は、どちらも停止確認・開始・送信を拒否する(確認できないものは止める)。
--   drift_reason は、スタッフの集合の不一致(旧側の状態とは別)。静的移行の登録時にも使う。
create or replace function public.reservation_ops_legacy_check(p_salon_id uuid)
returns table (
  state text, reason text, drift_reason text, legacy_mailbox text, expected_staff_count integer,
  registered_ids text[], unregistered_ids text[], missing_ids text[], mailbox_mismatch_ids text[], active_ids text[]
)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_schema text;
  v_map public.legacy_salon_mappings;
  v_ids text[];
  v_rows jsonb;
  v_unreg text[];
  v_missing text[];
  v_mismatch text[];
  v_active text[];
  v_drift text;
begin
  select o.legacy_schema into v_schema
    from public.reservation_notification_operations o
   where o.salon_id = p_salon_id and o.legacy_source is not null;
  if v_schema is null then
    return query select 'not_legacy'::text, null::text, null::text, null::text, null::integer,
                        null::text[], null::text[], null::text[], null::text[], null::text[];
    return;
  end if;
  select * into v_map from public.legacy_salon_mappings m where m.salon_id = p_salon_id;
  select coalesce(array_agg(s.legacy_salon_id order by s.legacy_salon_id), '{}'::text[]) into v_ids
    from public.legacy_cutover_snapshots s where s.salon_id = p_salon_id;
  if v_map.salon_id is null or cardinality(v_ids) = 0 then
    v_drift := case when v_map.salon_id is null then 'no_mapping' else 'no_registered_staff' end;
    return query select 'unknown'::text, v_drift, v_drift, v_map.legacy_mailbox, v_map.expected_staff_count,
                        v_ids, '{}'::text[], '{}'::text[], '{}'::text[], '{}'::text[];
    return;
  end if;
  begin
    execute format(
      'select coalesce(jsonb_agg(jsonb_build_object(''id'', m.salon_id::text, ''mailbox'', public.legacy_mailbox_canonical(m.email_address), ''status'', m.status)), ''[]''::jsonb)
         from %I.mail_connections m
        where m.salon_id::text = any($1) or public.legacy_mailbox_canonical(m.email_address) = $2',
      v_schema
    ) into v_rows using v_ids, v_map.legacy_mailbox;
  exception when others then
    return query select 'unknown'::text, 'legacy_unreadable'::text, 'legacy_unreadable'::text, v_map.legacy_mailbox,
                        v_map.expected_staff_count, v_ids, '{}'::text[], '{}'::text[], '{}'::text[], '{}'::text[];
    return;
  end;

  select coalesce(array_agg(r->>'id' order by r->>'id'), '{}'::text[]) into v_unreg
    from jsonb_array_elements(v_rows) r
   where r->>'mailbox' = v_map.legacy_mailbox and not ((r->>'id') = any(v_ids));
  select coalesce(array_agg(i order by i), '{}'::text[]) into v_missing
    from unnest(v_ids) i
   where not exists (select 1 from jsonb_array_elements(v_rows) r where r->>'id' = i);
  select coalesce(array_agg(r->>'id' order by r->>'id'), '{}'::text[]) into v_mismatch
    from jsonb_array_elements(v_rows) r
   where (r->>'id') = any(v_ids) and (r->>'mailbox') is distinct from v_map.legacy_mailbox;
  select coalesce(array_agg(r->>'id' order by r->>'id'), '{}'::text[]) into v_active
    from jsonb_array_elements(v_rows) r
   where r->>'status' in ('connected', 'needs_reconnect');

  v_drift := case
    when cardinality(v_unreg) > 0 then 'unregistered_legacy_rows'
    when cardinality(v_missing) > 0 then 'registered_rows_missing'
    when cardinality(v_mismatch) > 0 then 'mailbox_changed'
    when cardinality(v_ids) <> v_map.expected_staff_count then 'staff_count_mismatch'
    else null
  end;
  return query select
    case when cardinality(v_active) > 0 then 'active' when v_drift is not null then 'unknown' else 'stopped' end,
    case when cardinality(v_active) > 0 then 'legacy_rows_active' else v_drift end,
    v_drift, v_map.legacy_mailbox, v_map.expected_staff_count, v_ids, v_unreg, v_missing, v_mismatch, v_active;
end;
$$;

-- 監視・送信直前の確認で使う短い形('not_legacy' / 'stopped' / 'active' / 'unknown')。
create or replace function public.reservation_ops_legacy_state(p_salon_id uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select c.state from public.reservation_ops_legacy_check(p_salon_id) c;
$$;

-- 開始(active への遷移)の最終防御。画面・再接続・運用 CLI のどこから来ても、ここで拒否する。
create or replace function public.reservation_ops_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_run public.legacy_reconciliation_runs;
  v_legacy text;
  v_mailbox text;
  v_gmail_email text;
begin
  new.updated_at := now();
  if new.state = 'active' and (tg_op = 'INSERT' or old.state is distinct from 'active') then
    if new.legacy_source is null and exists (
      select 1 from public.line_connections lc
       where lc.salon_id = new.salon_id and lc.migrated_from_hmail_salon_id is not null
    ) then
      raise exception 'reservation_ops:legacy_staff_without_legacy_marker' using errcode = 'P0001';
    end if;
    if new.legacy_source is not null then
      if new.legacy_stop_confirmed_at is null then
        raise exception 'reservation_ops:legacy_stop_not_confirmed' using errcode = 'P0001';
      end if;
      select * into v_run from public.legacy_reconciliation_runs r
       where r.id = new.accepted_reconciliation_id and r.salon_id = new.salon_id;
      if not found or v_run.accepted_at is null or v_run.unresolved_count <> 0
         or v_run.ran_at <= new.legacy_stop_confirmed_at then
        raise exception 'reservation_ops:reconciliation_not_accepted' using errcode = 'P0001';
      end if;
      -- 照合した範囲より前のメールは、旧側で処理済みかどうかを確かめていない(重複の恐れ)。
      if v_run.window_from is null or new.mail_fetch_since is null or new.mail_fetch_since < v_run.window_from then
        raise exception 'reservation_ops:fetch_start_before_reconciliation_window' using errcode = 'P0001';
      end if;
      -- 新側で読む受信箱が、対応表の予約受信用 Gmail(旧側が読んでいた受信箱)と同じであること。
      select m.legacy_mailbox into v_mailbox from public.legacy_salon_mappings m where m.salon_id = new.salon_id;
      select coalesce(b.account_email, a.email) into v_gmail_email
        from public.salon_google_bindings b join public.google_accounts a on a.id = b.google_account_id
       where b.salon_id = new.salon_id and b.feature = 'gmail';
      if v_mailbox is null or v_gmail_email is null
         or public.legacy_mailbox_canonical(v_gmail_email) is distinct from v_mailbox then
        raise exception 'reservation_ops:gmail_account_mismatch' using errcode = 'P0001';
      end if;
      if (tg_op = 'INSERT' or old.activated_at is null) and exists (
        select 1 from public.notification_deliveries d
         where d.salon_id = new.salon_id and d.status = 'needs_review'
      ) then
        raise exception 'reservation_ops:needs_review_remaining' using errcode = 'P0001';
      end if;
      v_legacy := public.reservation_ops_legacy_state(new.salon_id);
      if v_legacy <> 'stopped' then
        raise exception 'reservation_ops:legacy_not_stopped:%', v_legacy using errcode = 'P0001';
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists reservation_ops_guard on public.reservation_notification_operations;
create trigger reservation_ops_guard
  before insert or update on public.reservation_notification_operations
  for each row execute function public.reservation_ops_guard();

-- 旧サービス利用店舗として登録する(静的データの移行と同時に、運営が実行)。切り替え待ちになり、
-- スタッフごとの旧側の接続状態を控える。稼働中の店舗には使えない。
-- 対応表(legacy_salon_mappings)が無い店舗、登録済みと違うスタッフの集合での再登録、他の店舗に登録済みの
-- スタッフは拒否する。登録したあと、対応表の予約受信用 Gmail で見つかる旧側の行と集合が一致しなければ
-- 例外で全体を取り消す(呼び出し側の CLI も書き込みの前に同じ確認をする。ここは最後の防御)。
create or replace function public.reservation_ops_mark_legacy(
  p_salon_id uuid, p_by text, p_legacy_schema text, p_snapshots jsonb
) returns text
language plpgsql
set search_path = ''
as $$
declare
  v_state text;
  v_requested text[];
  v_registered text[];
  v_drift text;
begin
  select o.state into v_state from public.reservation_notification_operations o where o.salon_id = p_salon_id for update;
  if v_state = 'active' then
    return 'already_active';
  end if;
  if not exists (select 1 from public.legacy_salon_mappings m where m.salon_id = p_salon_id) then
    return 'no_mapping';
  end if;
  select coalesce(array_agg(distinct s->>'legacy_salon_id' order by s->>'legacy_salon_id'), '{}'::text[]) into v_requested
    from jsonb_array_elements(p_snapshots) s;
  if cardinality(v_requested) = 0 or cardinality(v_requested) <> jsonb_array_length(p_snapshots) then
    return 'invalid_staff_list';
  end if;
  if exists (
    select 1 from public.legacy_cutover_snapshots s
     where s.legacy_salon_id = any(v_requested) and s.salon_id <> p_salon_id
  ) then
    return 'staff_registered_elsewhere';
  end if;
  select coalesce(array_agg(s.legacy_salon_id order by s.legacy_salon_id), '{}'::text[]) into v_registered
    from public.legacy_cutover_snapshots s where s.salon_id = p_salon_id;
  if cardinality(v_registered) > 0 and v_registered is distinct from v_requested then
    return 'registered_set_differs';
  end if;

  insert into public.reservation_notification_operations (salon_id, state, legacy_source, legacy_schema)
  values (p_salon_id, 'awaiting_cutover', 'hmail', p_legacy_schema)
  on conflict (salon_id) do update
     set state = 'awaiting_cutover', legacy_source = 'hmail', legacy_schema = excluded.legacy_schema;
  insert into public.legacy_cutover_snapshots (salon_id, legacy_salon_id, original_status)
  select p_salon_id, s->>'legacy_salon_id', s->>'original_status'
    from jsonb_array_elements(p_snapshots) s
  on conflict (salon_id, legacy_salon_id) do nothing;

  select c.drift_reason into v_drift from public.reservation_ops_legacy_check(p_salon_id) c;
  if v_drift is not null then
    raise exception 'reservation_ops:legacy_staff_set_mismatch:%', v_drift using errcode = 'P0001';
  end if;
  perform public.reservation_open_stop(p_salon_id, 'legacy_cutover', p_by, 'awaiting cutover from hmail');
  return 'marked';
end;
$$;

-- 旧側の停止確認を記録する(運営 CLI が cron 履歴等を確認したあとに呼ぶ)。
-- 監視クエリで 'stopped' を確認できない限り記録しない。
create or replace function public.reservation_ops_confirm_legacy_stop(p_salon_id uuid, p_by text)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_legacy text;
begin
  perform 1 from public.reservation_notification_operations o
   where o.salon_id = p_salon_id and o.legacy_source is not null for update;
  if not found then
    return 'not_legacy';
  end if;
  v_legacy := public.reservation_ops_legacy_state(p_salon_id);
  if v_legacy <> 'stopped' then
    return 'legacy_' || v_legacy;
  end if;
  update public.reservation_notification_operations
     set legacy_stop_confirmed_at = now(), legacy_stop_confirmed_by = p_by
   where salon_id = p_salon_id;
  update public.legacy_cutover_snapshots
     set stop_applied_at = coalesce(stop_applied_at, now())
   where salon_id = p_salon_id;
  return 'confirmed';
end;
$$;

-- 照合結果を受け入れる(未解決ゼロ・旧側停止確認より後の照合に限る)。
create or replace function public.reservation_ops_accept_reconciliation(p_run_id uuid, p_by text)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_run public.legacy_reconciliation_runs;
  v_ops public.reservation_notification_operations;
begin
  select * into v_run from public.legacy_reconciliation_runs where id = p_run_id for update;
  if not found then
    return 'not_found';
  end if;
  select * into v_ops from public.reservation_notification_operations where salon_id = v_run.salon_id for update;
  if not found or v_ops.legacy_stop_confirmed_at is null then
    return 'legacy_stop_not_confirmed';
  end if;
  if v_run.ran_at <= v_ops.legacy_stop_confirmed_at then
    return 'run_before_stop_confirmation';
  end if;
  if v_run.unresolved_count <> 0 or exists (
    select 1 from public.notification_deliveries d where d.salon_id = v_run.salon_id and d.status = 'needs_review'
  ) then
    return 'unresolved_remaining';
  end if;
  update public.legacy_reconciliation_runs set accepted_at = now(), accepted_by = p_by where id = p_run_id;
  update public.reservation_notification_operations set accepted_reconciliation_id = p_run_id where salon_id = v_run.salon_id;
  return 'accepted';
end;
$$;

-- 予約メールに使える Google 連携(有効なアカウント・Gmail の権限・権限不足の記録なし)のアカウント。無ければ null。
create or replace function public.reservation_ops_usable_gmail_account(p_salon_id uuid)
returns uuid
language sql
stable
set search_path = ''
as $$
  select b.google_account_id
    from public.salon_google_bindings b
    join public.google_accounts a on a.id = b.google_account_id
   where b.salon_id = p_salon_id and b.feature = 'gmail' and b.scope_missing_since is null
     and a.auth_state = 'active' and 'https://www.googleapis.com/auth/gmail.readonly' = any(a.granted_scopes);
$$;

-- 運営による開始・再開。メール取得開始日時と理由を明示して記録する(接続日時をそのまま使わない)。
-- そのとき予約メールに使っているアカウントも記録する(開始後のアカウント切り替えだけを見分けるため)。
-- 旧サービス利用店舗の条件はトリガー(reservation_ops_guard)が確認する。
create or replace function public.reservation_ops_activate(
  p_salon_id uuid, p_by text, p_mail_fetch_since timestamptz, p_reason text
) returns text
language plpgsql
set search_path = ''
as $$
declare
  v_ops public.reservation_notification_operations;
  v_account uuid;
begin
  select * into v_ops from public.reservation_notification_operations where salon_id = p_salon_id for update;
  if not found then
    return 'no_operations';
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

-- お客様による開始(旧サービスを使っていない店舗だけ)。Google に接続しただけでは呼ばれない。
create or replace function public.reservation_ops_customer_start(
  p_salon_id uuid, p_user_id uuid, p_allowed_plans text[]
) returns text
language plpgsql
set search_path = ''
as $$
declare
  v_ops public.reservation_notification_operations;
  v_plan text;
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
  select s.plan into v_plan from public.salons s where s.id = p_salon_id;
  if v_plan is null or not (v_plan = any(p_allowed_plans)) then
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

-- 運営(またはシステム)による停止。停止期間を記録し、送信開始済みで結果がまだ出ていない配信の件数を返す
-- (処理権の失効は外部リクエストの取消ではない。0 になるまで「完全に停止した」とは扱わない)。
create or replace function public.reservation_ops_pause(p_salon_id uuid, p_by text, p_reason text, p_kind text)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_inflight integer;
begin
  if p_kind not in ('operator_pause', 'legacy_active') then
    raise exception 'reservation_ops:invalid_pause_kind' using errcode = 'P0001';
  end if;
  update public.reservation_notification_operations
     set state = 'paused', paused_at = now(), paused_by = p_by, pause_reason = p_reason
   where salon_id = p_salon_id and state in ('active', 'paused');
  perform public.reservation_open_stop(p_salon_id, p_kind, p_by, p_reason);
  select count(*) into v_inflight from public.notification_deliveries d
   where d.salon_id = p_salon_id and d.status = 'claimed' and d.send_started_at is not null;
  return v_inflight;
end;
$$;

-- ------------------------------------------------------------------
-- 4. 停止期間を自動で記録するトリガー(正確な時刻で残す)
-- ------------------------------------------------------------------

-- 通知の全体スイッチ(notification_settings.master_enabled)。
create or replace function public.reservation_track_master_switch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.master_enabled is distinct from old.master_enabled then
    if new.master_enabled then
      perform public.reservation_close_stop(new.salon_id, 'manual_master_off', 'trigger:master_switch');
    else
      perform public.reservation_open_stop(new.salon_id, 'manual_master_off', 'trigger:master_switch', null);
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists reservation_track_master_switch on public.notification_settings;
create trigger reservation_track_master_switch
  after insert or update of master_enabled on public.notification_settings
  for each row execute function public.reservation_track_master_switch();

-- お客様による機能の選択(予約通知を使う/使わない)。
create or replace function public.reservation_track_feature_selection()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.feature_key = 'reservation_notifications'
     and (tg_op = 'INSERT' or new.selected is distinct from old.selected) then
    if new.selected then
      perform public.reservation_close_stop(new.salon_id, 'manual_feature_off', 'trigger:feature_selection');
    else
      perform public.reservation_open_stop(new.salon_id, 'manual_feature_off', 'trigger:feature_selection', null);
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists reservation_track_feature_selection on public.salon_feature_selections;
create trigger reservation_track_feature_selection
  after insert or update of selected on public.salon_feature_selections
  for each row execute function public.reservation_track_feature_selection();

-- 契約(salons.plan)の変更。監査記録を残し、予約通知を含まない契約の間を停止期間として記録する。
-- ※ どの契約に予約通知が含まれるかは lib/access/plan.ts(PLAN_FEATURES)が正。ここは
--   'salonpack' のみが予約通知を含むという現行の対応を写したもの(__tests__/lib/access で整合を確認する)。
create table if not exists public.salon_plan_changes (
  id bigint generated always as identity primary key,
  salon_id uuid not null references public.salons (id) on delete cascade,
  old_plan text,
  new_plan text not null,
  changed_at timestamptz not null default now(),
  changed_by text not null default current_user,
  note text
);

create or replace function public.reservation_track_plan_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.plan is distinct from old.plan then
    insert into public.salon_plan_changes (salon_id, old_plan, new_plan, note)
    values (new.id, old.plan, new.plan, nullif(current_setting('salonpack.change_note', true), ''));
    if new.plan = 'salonpack' then
      perform public.reservation_close_stop(new.id, 'contract', 'trigger:plan_change');
    elsif old.plan = 'salonpack' then
      perform public.reservation_open_stop(new.id, 'contract', 'trigger:plan_change', old.plan || ' -> ' || new.plan);
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists reservation_track_plan_change on public.salons;
create trigger reservation_track_plan_change
  after update of plan on public.salons
  for each row execute function public.reservation_track_plan_change();

-- ------------------------------------------------------------------
-- 5. Gmail の取得状況(続きから再開できるように)
-- ------------------------------------------------------------------

-- watermark より新しいメールを、ページの続き(page_token)を保存しながら最後まで読み切る。
-- 読み切ったときだけ watermark を進める。同時に2つの処理が同じ店舗を読まないようリースを付ける。
create table if not exists public.gmail_scan_state (
  salon_id uuid primary key references public.salons (id) on delete cascade,
  google_account_id uuid references public.google_accounts (id) on delete set null,
  watermark timestamptz not null,
  scan_id uuid,
  scan_started_at timestamptz,
  page_token text,
  lease_token uuid,
  lease_until timestamptz,
  last_full_scan_at timestamptz,
  updated_at timestamptz not null default now()
);
-- 最後にこの店舗の処理を始めた日時。定期処理は古い順に処理する(時間切れで後回しになった店舗が次の回の先頭になる)。
alter table public.gmail_scan_state add column if not exists last_tick_at timestamptz;

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

create or replace function public.gmail_scan_progress(
  p_salon_id uuid, p_lease_token uuid, p_scan_id uuid, p_scan_started_at timestamptz, p_page_token text,
  p_completed boolean, p_completed_watermark timestamptz, p_release boolean
) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.gmail_scan_state s
     set scan_id = case when p_completed then null else p_scan_id end,
         scan_started_at = case when p_completed then null else p_scan_started_at end,
         page_token = case when p_completed then null else p_page_token end,
         watermark = case when p_completed then greatest(s.watermark, p_completed_watermark) else s.watermark end,
         last_full_scan_at = case when p_completed then now() else s.last_full_scan_at end,
         lease_token = case when p_release then null else s.lease_token end,
         lease_until = case when p_release then null else s.lease_until end,
         updated_at = now()
   where s.salon_id = p_salon_id and s.lease_token = p_lease_token;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

-- ------------------------------------------------------------------
-- 6. processed_emails / notification_deliveries の拡張
-- ------------------------------------------------------------------

alter table public.processed_emails add column if not exists classify_attempts integer not null default 0;
alter table public.processed_emails add column if not exists mail_received_at timestamptz;
-- 旧側から引き継いだ(一部スタッフに未送信の)メール。24時間を過ぎていれば自動送信せず人の確認へ回す。
alter table public.processed_emails add column if not exists handover boolean not null default false;
alter table public.processed_emails drop constraint if exists processed_emails_event_type_check;
alter table public.processed_emails add constraint processed_emails_event_type_check
  check (event_type in ('pending', 'new_reservation', 'change', 'cancellation', 'unknown', 'not_hotpepper', 'unprocessable'));

alter table public.notification_deliveries add column if not exists destination_id text;
alter table public.notification_deliveries add column if not exists mail_received_at timestamptz;
alter table public.notification_deliveries add column if not exists claim_token uuid;
alter table public.notification_deliveries add column if not exists claimed_from_status text;
alter table public.notification_deliveries add column if not exists first_attempt_at timestamptz;
alter table public.notification_deliveries add column if not exists send_started_at timestamptz;
alter table public.notification_deliveries add column if not exists next_attempt_at timestamptz;
alter table public.notification_deliveries add column if not exists line_request_id text;
alter table public.notification_deliveries add column if not exists origin text not null default 'salonpack';
alter table public.notification_deliveries add column if not exists handover boolean not null default false;
alter table public.notification_deliveries add column if not exists skip_reason text;
alter table public.notification_deliveries add column if not exists manual_resend_of uuid references public.notification_deliveries (id);
alter table public.notification_deliveries add column if not exists resend_approved_by text;
alter table public.notification_deliveries add column if not exists resolved_by text;
alter table public.notification_deliveries add column if not exists resolved_at timestamptz;
-- 運営が「送ってよい」と確認した、まだ一度も送っていない配信(人の確認待ち → 送信)。
-- これがあれば、初回送信時の遅延のルール(停止期間中の受信・24時間超)を適用しない
-- (送信先・通知のON/OFFの確認は常に行う)。
alter table public.notification_deliveries add column if not exists operator_approved_at timestamptz;

alter table public.notification_deliveries drop constraint if exists notification_deliveries_origin_check;
alter table public.notification_deliveries add constraint notification_deliveries_origin_check
  check (origin in ('salonpack', 'hmail'));
alter table public.notification_deliveries drop constraint if exists notification_deliveries_status_check;
alter table public.notification_deliveries add constraint notification_deliveries_status_check
  check (status in ('pending', 'claimed', 'sent', 'failed', 'unknown', 'skipped', 'needs_review', 'retry_wait'));
alter table public.notification_deliveries drop constraint if exists notification_deliveries_manual_resend_check;
alter table public.notification_deliveries add constraint notification_deliveries_manual_resend_check
  check (manual_resend_of is null or resend_approved_by is not null);

-- 手動再送(重複の危険を承知で新しい retry key を使う)は、元の配信とは別の行にする。
-- 0020 の unique (provider_message_id, line_connection_id) を、元の配信だけの部分一意索引に置き換える。
do $$
declare
  v_name text;
begin
  select c.conname into v_name
    from pg_constraint c
   where c.conrelid = 'public.notification_deliveries'::regclass and c.contype = 'u'
     and pg_get_constraintdef(c.oid) = 'UNIQUE (provider_message_id, line_connection_id)';
  if v_name is not null then
    execute format('alter table public.notification_deliveries drop constraint %I', v_name);
  end if;
end;
$$;
create unique index if not exists notification_deliveries_original_uniq
  on public.notification_deliveries (provider_message_id, line_connection_id) where manual_resend_of is null;
create unique index if not exists notification_deliveries_manual_resend_uniq
  on public.notification_deliveries (manual_resend_of) where manual_resend_of is not null;
create index if not exists notification_deliveries_claim_idx
  on public.notification_deliveries (salon_id, created_at)
  where status in ('pending', 'claimed', 'unknown', 'retry_wait');

-- 既存の行に送信先の控えを入れる(配信の再試行では送信先を変えないため)。
update public.notification_deliveries d
   set destination_id = lc.destination_id
  from public.line_connections lc
 where d.destination_id is null and lc.id = d.line_connection_id;

-- ------------------------------------------------------------------
-- 7. 配信処理の関数(新しい名前。0020 の関数は使わない)
-- ------------------------------------------------------------------

-- メールの分類と、送信先ごとの配信行の作成を1つのトランザクションで行う
-- (分類だけ記録されて配信行が作られないまま取り残されることがないように)。
-- p_recipients: [{"line_connection_id": "...", "destination_id": "..."}]。
-- 戻り値: 作成した配信行の数。既に分類済み(pending ではない)なら -1。
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
    (salon_id, provider_message_id, line_connection_id, destination_id, event_type, line_text, mail_received_at, handover)
  select v_salon, v_message, (r->>'line_connection_id')::uuid, r->>'destination_id', p_event_type, p_line_text,
         p_mail_received_at, v_handover
    from jsonb_array_elements(p_recipients) r
   where exists (
     select 1 from public.line_connections lc
      where lc.id = (r->>'line_connection_id')::uuid and lc.salon_id = v_salon
   )
  on conflict (provider_message_id, line_connection_id) where manual_resend_of is null do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- 分類が一時的に失敗して pending のまま残ったメールを再度処理する(上限回数を超えたら unprocessable)。
create or replace function public.notifications_reclaim_stuck_email_v2(
  p_salon_id uuid, p_stale_after interval default interval '5 minutes', p_max_attempts integer default 5
) returns setof public.processed_emails
language plpgsql
set search_path = ''
as $$
begin
  update public.processed_emails
     set event_type = 'unprocessable'
   where salon_id = p_salon_id and event_type = 'pending'
     and classify_attempts >= p_max_attempts and processed_at < now() - p_stale_after;
  return query
    update public.processed_emails
       set processed_at = now(), classify_attempts = classify_attempts + 1
     where id = (
       select id from public.processed_emails
        where salon_id = p_salon_id and event_type = 'pending' and processed_at < now() - p_stale_after
        order by processed_at
        limit 1
        for update skip locked
     )
    returning *;
end;
$$;

-- 締切のため、クレームしたメールの処理を途中でやめた(本文の取得を締切に合わせて打ち切った等)。
-- 失敗として数えずに、次の回にすぐ再クレームできる状態へ戻す(分類済みのものは対象外)。
create or replace function public.notifications_release_email_claim(p_processed_id uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.processed_emails
     set classify_attempts = greatest(classify_attempts - 1, 0),
         processed_at = now() - interval '1 hour'
   where id = p_processed_id and event_type = 'pending';
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

-- 配信を1件、処理権(claim_token)付きで取り出す。
--   - 運用状態が稼働中・機能が選択済み・契約が予約通知を含む店舗だけ
--   - 旧側から取り込んだ記録(origin='hmail')・人の確認待ち・送信済み等は取り出さない
--   - 結果不明・再試行待ちは、最初の送信から p_retry_window 以内で、待ち時間を過ぎたものだけ
--   - 処理権が切れた claimed は、送信を開始していたら結果不明、開始前なら元の状態に戻す
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
   where d.salon_id = p_salon_id and d.origin = 'salonpack'
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

-- 送信の直前確認。運用状態の行を共有ロックしたまま、処理権・店舗の条件・送信先・通知種別・遅延通知のルールを
-- 1つの文で確かめ、送ってよければ送信開始を記録する。
-- decision:
--   'send'          送ってよい(destination_id / line_text / line_retry_key を返す)
--   'skipped'       送らない(初回の送信前のみ。送信先・通知種別のOFF、停止期間中の受信、古すぎる等)
--   'needs_review'  自動では決めず人の確認へ(受信日時不明、引き継ぎで24時間超)
--   'released'      今は送らず元の状態へ戻した(店舗の条件・送信済みかもしれない配信の再試行の抑止)
--   'expired'       retry key の有効期間を過ぎた結果不明。自動再送しない(状態は変えない)
--   'lost'          処理権を失っている(別の処理が取り直した)
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

  select * into v_lc from public.line_connections lc where lc.id = v_d.line_connection_id;
  v_reason := case
    when v_lc.id is null or v_lc.status <> 'connected' or v_lc.destination_id is null then 'recipient_disconnected'
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
     set first_attempt_at = coalesce(d.first_attempt_at, now()), send_started_at = now(), claimed_at = now(), updated_at = now()
   where d.id = p_id;
  return query select 'send'::text, null::text, v_d.destination_id, v_d.line_text, v_d.line_retry_key,
                      v_d.event_type, v_d.line_connection_id;
end;
$$;

-- 定期処理で Gmail を読む店舗の一覧。稼働中・機能を選択済み・契約が予約通知を含む・全体スイッチが ON・
-- 予約メールの Google 連携があり、そのアカウントが有効で Gmail の権限が確認できている店舗だけ。
-- 停止中・切り替え待ち・開始前・利用停止中の店舗のメールは読まない(処理済みにして消費しない)。
-- Gmail だけの権限不足を記録した店舗も含める(定期処理が、権限が戻ったことに気付けるように。読めない間は送らない)。
-- 最後に処理を始めた日時の古い順(時間切れで後回しになった店舗を、次の回の先頭にする)。
drop function if exists public.notifications_list_pollable_salons(text[]);
create function public.notifications_list_pollable_salons(p_allowed_plans text[])
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
     and s.plan = any(p_allowed_plans)
     and exists (
       select 1 from public.salon_feature_selections f
        where f.salon_id = o.salon_id and f.feature_key = 'reservation_notifications' and f.selected
     )
     and coalesce((select ns.master_enabled from public.notification_settings ns where ns.salon_id = o.salon_id), true)
     and a.auth_state = 'active'
     and 'https://www.googleapis.com/auth/gmail.readonly' = any(a.granted_scopes)
   order by gs.last_tick_at nulls first, o.salon_id;
$$;

-- 送信結果の記録。処理権(claim_token)が一致する場合だけ書く。false は「処理権を失った」
-- (別の処理が結果不明として取り直した)ことを表し、外部への送信が取り消されたことは意味しない。
create or replace function public.notifications_finish_delivery(
  p_id uuid, p_claim_token uuid, p_outcome text, p_line_request_id text, p_error text, p_retry_after interval
) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_outcome not in ('sent', 'failed', 'unknown', 'retry_wait') then
    raise exception 'notifications:invalid_outcome' using errcode = 'P0001';
  end if;
  update public.notification_deliveries d
     set status = p_outcome,
         claim_token = null, claimed_at = null, send_started_at = null, claimed_from_status = null,
         line_request_id = coalesce(p_line_request_id, d.line_request_id),
         last_error = p_error,
         next_attempt_at = case when p_outcome in ('unknown', 'retry_wait')
                                then now() + coalesce(p_retry_after, interval '1 minute') else null end,
         updated_at = now()
   where d.id = p_id and d.status = 'claimed' and d.claim_token = p_claim_token;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

-- ------------------------------------------------------------------
-- 8. RLS とブラウザからのアクセス拒否
-- ------------------------------------------------------------------

alter table public.reservation_stop_intervals enable row level security;
alter table public.legacy_salon_mappings enable row level security;
alter table public.legacy_reconciliation_runs enable row level security;
alter table public.legacy_cutover_snapshots enable row level security;
alter table public.reservation_notification_operations enable row level security;
alter table public.salon_plan_changes enable row level security;
alter table public.gmail_scan_state enable row level security;

revoke all on table public.reservation_stop_intervals from anon, authenticated;
revoke all on table public.legacy_salon_mappings from anon, authenticated;
revoke all on table public.legacy_reconciliation_runs from anon, authenticated;
revoke all on table public.legacy_cutover_snapshots from anon, authenticated;
revoke all on table public.reservation_notification_operations from anon, authenticated;
revoke all on table public.salon_plan_changes from anon, authenticated;
revoke all on table public.gmail_scan_state from anon, authenticated;
revoke all on table public.notification_deliveries from anon, authenticated;
revoke all on table public.processed_emails from anon, authenticated;

revoke all on function public.reservation_open_stop(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.reservation_close_stop(uuid, text, text) from public, anon, authenticated;
revoke all on function public.legacy_mailbox_canonical(text) from public, anon, authenticated;
revoke all on function public.reservation_ops_legacy_check(uuid) from public, anon, authenticated;
revoke all on function public.reservation_ops_usable_gmail_account(uuid) from public, anon, authenticated;
revoke all on function public.reservation_ops_legacy_state(uuid) from public, anon, authenticated;
revoke all on function public.reservation_ops_mark_legacy(uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.reservation_ops_confirm_legacy_stop(uuid, text) from public, anon, authenticated;
revoke all on function public.reservation_ops_accept_reconciliation(uuid, text) from public, anon, authenticated;
revoke all on function public.reservation_ops_activate(uuid, text, timestamptz, text) from public, anon, authenticated;
revoke all on function public.reservation_ops_customer_start(uuid, uuid, text[]) from public, anon, authenticated;
revoke all on function public.reservation_ops_pause(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.gmail_scan_acquire(uuid, uuid, timestamptz, interval) from public, anon, authenticated;
revoke all on function public.gmail_scan_progress(uuid, uuid, uuid, timestamptz, text, boolean, timestamptz, boolean) from public, anon, authenticated;
revoke all on function public.notifications_classify_email(uuid, text, text, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function public.notifications_reclaim_stuck_email_v2(uuid, interval, integer) from public, anon, authenticated;
revoke all on function public.notifications_release_email_claim(uuid) from public, anon, authenticated;
revoke all on function public.notifications_claim_delivery_v2(uuid, text[], interval, interval) from public, anon, authenticated;
revoke all on function public.notifications_begin_send(uuid, uuid, text[], interval, interval, interval) from public, anon, authenticated;
revoke all on function public.notifications_finish_delivery(uuid, uuid, text, text, text, interval) from public, anon, authenticated;
revoke all on function public.notifications_list_pollable_salons(text[]) from public, anon, authenticated;

grant execute on function public.reservation_open_stop(uuid, text, text, text) to service_role;
grant execute on function public.reservation_close_stop(uuid, text, text) to service_role;
grant execute on function public.legacy_mailbox_canonical(text) to service_role;
grant execute on function public.reservation_ops_legacy_check(uuid) to service_role;
grant execute on function public.reservation_ops_usable_gmail_account(uuid) to service_role;
grant execute on function public.reservation_ops_legacy_state(uuid) to service_role;
grant execute on function public.reservation_ops_mark_legacy(uuid, text, text, jsonb) to service_role;
grant execute on function public.reservation_ops_confirm_legacy_stop(uuid, text) to service_role;
grant execute on function public.reservation_ops_accept_reconciliation(uuid, text) to service_role;
grant execute on function public.reservation_ops_activate(uuid, text, timestamptz, text) to service_role;
grant execute on function public.reservation_ops_customer_start(uuid, uuid, text[]) to service_role;
grant execute on function public.reservation_ops_pause(uuid, text, text, text) to service_role;
grant execute on function public.gmail_scan_acquire(uuid, uuid, timestamptz, interval) to service_role;
grant execute on function public.gmail_scan_progress(uuid, uuid, uuid, timestamptz, text, boolean, timestamptz, boolean) to service_role;
grant execute on function public.notifications_classify_email(uuid, text, text, timestamptz, jsonb) to service_role;
grant execute on function public.notifications_reclaim_stuck_email_v2(uuid, interval, integer) to service_role;
grant execute on function public.notifications_release_email_claim(uuid) to service_role;
grant execute on function public.notifications_claim_delivery_v2(uuid, text[], interval, interval) to service_role;
grant execute on function public.notifications_begin_send(uuid, uuid, text[], interval, interval, interval) to service_role;
grant execute on function public.notifications_finish_delivery(uuid, uuid, text, text, text, interval) to service_role;
grant execute on function public.notifications_list_pollable_salons(text[]) to service_role;

-- 0020 の旧関数: 新しいコードでは呼ばない。ブラウザ側のロールからの実行権限を取り消す(削除は後日の別 migration)。
revoke all on function public.notifications_claim_delivery(uuid, interval, interval) from public, anon, authenticated;
revoke all on function public.notifications_mark_delivery_outcome(uuid, text, text) from public, anon, authenticated;
revoke all on function public.notifications_stale_unknown_deliveries(interval) from public, anon, authenticated;
revoke all on function public.notifications_reclaim_stuck_email(uuid, interval) from public, anon, authenticated;
