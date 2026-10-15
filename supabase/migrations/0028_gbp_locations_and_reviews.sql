-- 0028: 届いた口コミ(Googleビジネスプロフィール)のロケーション・口コミの一時保存・同期・削除。
-- 計画: ~/.claude/plans(口コミの実装計画 第2版)§2・§3・§3-A。旧 feature/reviews-d1-reply-engine の 0015・0016 を、
-- 共通の Google 連携(0021 の google_accounts・salon_google_bindings)に合わせて作り直したもの。
--
-- 【Google の認証情報は持たない】
--   口コミ専用の接続・OAuth の state・refresh token の表(旧 0015 の gbp_connections・gbp_oauth_states)は作らない。
--   どの Google アカウントを使うかは salon_google_bindings(feature='gbp')が正。ロケーションは、選んだときの
--   Google アカウント(google_account_id)を持つ。
--
-- 【選択の世代】
--   店舗(ロケーション)を選ぶたびに gbp_locations を新しい行にする(同じロケーションを選び直しても、前の行は使わない)。
--   行の id が世代。口コミの書き込み・同期・下書き・送信は、すべて gbp_location_usable(店舗, 行)が真のときだけ通る:
--     行が active、かつ その店舗の口コミの結び付けが同じアカウントを指し、選択済み(gbp_selection_state='selected')。
--   アカウントの切り替え・口コミの結び付けの解除・選択待ちへの戻り(0021 の google_bind_features / google_unbind_features)は、
--   トリガー(gbp_binding_changed)で、その店舗の有効なロケーションを無効にし、一時保存・下書き・索引をすぐ消す。
--   無効にする処理は、ロケーションの行を更新する(書き込み中の処理はロケーションの行を FOR SHARE で持つ)ので、
--   書き込みの途中に無効化が割り込むことはない(無効化は書き込みの確定を待ち、確定した分も消す)。
--
-- 【一時保存(Google のデータ)】
--   gbp_review_cache(投稿者・★・本文・返信・写真の URL など)と、ロケーションの名前・住所・★の平均と件数は、
--   取ってから25日で消す(Google の規定「30日以内」)。gbp_purge_expired_content は、店舗の利用可否・機能のフラグ・
--   Google との接続に関係なく、期限で消す(呼び出し口は専用の秘密の値で認証する。アプリ側)。
--   gbp_review_index は SalonPack の記録(口コミのキーの HMAC・初めて見つけた時刻・既読)。ロケーションを無効にしたら消す。
--   集計の表は作らない。画像・動画の実体は保存しない(URL だけ)。
--
-- 【新着】初回の取り込み(最初の全件の取得)が終わった時刻(initial_sync_done_at)より後に初めて見つけ(first_seen_at)、
--   まだ開いていない(seen_at が空)口コミ(gbp_inbox_summary)。初回の途中は数えない(null を返す)。
--
-- テーブルはどれも RLS を有効にしてポリシーを作らない。関数は service role だけが実行できる。
-- 0001〜0026 のテーブル・関数は作り直さない(0021 の google_oauth_states の戻り先の制約に 'reviews' を足し、
-- salon_google_bindings にトリガーを足すだけ)。何度実行しても同じ結果になる。

-- ------------------------------------------------------------------
-- 0. OAuth の戻り先に「届いた口コミ」を足す(0021 の制約を置き換える。既存の値はそのまま使える)
-- ------------------------------------------------------------------
alter table public.google_oauth_states drop constraint if exists google_oauth_states_return_to_check;
alter table public.google_oauth_states add constraint google_oauth_states_return_to_check
  check (return_to in ('settings_google', 'dashboard', 'notifications', 'reviews'));

-- ------------------------------------------------------------------
-- 1. テーブル
-- ------------------------------------------------------------------
create table if not exists public.gbp_locations (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons(id) on delete cascade,
  google_account_id uuid not null references public.google_accounts(id) on delete cascade,
  account_name text not null check (account_name ~ '^accounts/[^/]+$'),
  location_name text not null check (location_name ~ '^locations/[^/]+$'),
  -- Google のデータ(ロケーションの名前・住所)。25日で消す。
  title_cache text check (char_length(title_cache) <= 200),
  address_cache text check (char_length(address_cache) <= 300),
  content_cached_at timestamptz,
  -- Google のデータ(★の平均と件数。reviews.list の averageRating / totalReviewCount = 店舗全体の値)。25日で消す。
  average_rating numeric(2, 1) check (average_rating between 0 and 5),
  total_review_count integer check (total_review_count >= 0),
  rating_cached_at timestamptz,
  -- 同期(旧 0016 と同じ意味)
  sync_watermark timestamptz,
  last_synced_at timestamptz,
  initial_sync_done_at timestamptz,
  full_sync_done_at timestamptz,
  sync_run_kind text check (sync_run_kind in ('full', 'delta')),
  sync_run_started_at timestamptz,
  sync_run_floor timestamptz,
  sync_run_newest timestamptz,
  sync_run_resume_before timestamptz,
  sync_run_page_token text check (char_length(sync_run_page_token) <= 4096),
  sync_run_failures integer not null default 0 check (sync_run_failures >= 0),
  sync_lease_token uuid,
  sync_lease_until timestamptz,
  status text not null check (status in ('active', 'disconnected')),
  selected_by_user_id uuid,
  activated_at timestamptz not null default now(),
  deactivated_at timestamptz
);
-- 店舗あたり有効なロケーションは1つ。ロケーションは有効な店舗1つにだけ(ほかの店舗による乗っ取りを防ぐ)。
create unique index if not exists gbp_locations_salon_active on public.gbp_locations (salon_id) where status = 'active';
create unique index if not exists gbp_locations_location_active on public.gbp_locations (location_name) where status = 'active';
create index if not exists gbp_locations_salon on public.gbp_locations (salon_id, activated_at desc);

-- 連携の同意(口コミの一時保存・返信は「Googleに返信する」を押したときだけ、など)の記録。
create table if not exists public.gbp_consents (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons(id) on delete cascade,
  user_id uuid not null,
  consent_type text not null check (consent_type in ('connect')),
  version text not null check (char_length(version) between 1 and 40),
  accepted_at timestamptz not null default now()
);
create index if not exists gbp_consents_salon on public.gbp_consents (salon_id, accepted_at desc);

create table if not exists public.gbp_review_index (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons(id) on delete cascade,
  location_id uuid not null references public.gbp_locations(id) on delete cascade,
  review_key_hash text not null check (char_length(review_key_hash) between 32 and 128),
  first_seen_at timestamptz not null default now(),
  detected_via text not null check (detected_via in ('manual', 'reconcile', 'pubsub')),
  seen_at timestamptz,
  last_synced_at timestamptz not null default now(),
  deleted_on_google_at timestamptz,
  unique (location_id, review_key_hash)
);
create index if not exists gbp_review_index_salon_key on public.gbp_review_index (salon_id, review_key_hash);

create table if not exists public.gbp_review_cache (
  review_index_id uuid primary key references public.gbp_review_index(id) on delete cascade,
  salon_id uuid not null references public.salons(id) on delete cascade,
  review_name text not null check (review_name ~ '^accounts/[^/]+/locations/[^/]+/reviews/[^/]+$'),
  reviewer_name text,
  reviewer_photo_url text,
  is_anonymous boolean not null default false,
  star_rating smallint check (star_rating between 1 and 5),
  comment text not null default '',
  create_time timestamptz not null,
  update_time timestamptz not null,
  reply_comment text,
  reply_update_time timestamptz,
  reply_state text check (reply_state in ('PENDING', 'APPROVED', 'REJECTED', 'UNSPECIFIED')),
  policy_violation text check (char_length(policy_violation) <= 100),
  media jsonb not null default '[]'::jsonb check (jsonb_typeof(media) = 'array'),
  reply_url text,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists gbp_review_cache_salon_created on public.gbp_review_cache (salon_id, create_time desc);
create index if not exists gbp_review_cache_expires on public.gbp_review_cache (expires_at);

create table if not exists public.gbp_reply_drafts (
  review_index_id uuid primary key references public.gbp_review_index(id) on delete cascade,
  salon_id uuid not null references public.salons(id) on delete cascade,
  draft_text text not null check (char_length(draft_text) between 1 and 5000),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists gbp_reply_drafts_expires on public.gbp_reply_drafts (expires_at);

alter table public.gbp_locations enable row level security;
alter table public.gbp_consents enable row level security;
alter table public.gbp_review_index enable row level security;
alter table public.gbp_review_cache enable row level security;
alter table public.gbp_reply_drafts enable row level security;
revoke all on table public.gbp_locations from anon, authenticated;
revoke all on table public.gbp_consents from anon, authenticated;
revoke all on table public.gbp_review_index from anon, authenticated;
revoke all on table public.gbp_review_cache from anon, authenticated;
revoke all on table public.gbp_reply_drafts from anon, authenticated;

-- ------------------------------------------------------------------
-- 2. 世代の判定・選択・無効化
-- ------------------------------------------------------------------

-- その店舗のそのロケーションの行(世代)を、今も使ってよいか。
create or replace function public.gbp_location_usable(p_salon_id uuid, p_location_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
      from public.gbp_locations l
      join public.salon_google_bindings b
        on b.salon_id = l.salon_id and b.feature = 'gbp' and b.google_account_id = l.google_account_id
     where l.id = p_location_id and l.salon_id = p_salon_id and l.status = 'active'
       and b.gbp_selection_state = 'selected')
$$;

-- その店舗の有効なロケーションを無効にし、一時保存・下書き・索引を消す(SalonPack の記録も残さない)。
-- 返信の操作の記録(0029)は、口コミ・ロケーションへの参照が外れるだけで残る(本文は持たない)。
-- 戻り値は無効にしたロケーションの数。
create or replace function public.gbp_deactivate_salon_locations(p_salon_id uuid)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  with t as (
    update public.gbp_locations l
       set status = 'disconnected', deactivated_at = now(),
           title_cache = null, address_cache = null, content_cached_at = null,
           average_rating = null, total_review_count = null, rating_cached_at = null,
           sync_run_kind = null, sync_run_started_at = null, sync_run_floor = null, sync_run_newest = null,
           sync_run_resume_before = null, sync_run_page_token = null, sync_run_failures = 0,
           sync_lease_token = null, sync_lease_until = null
     where l.salon_id = p_salon_id and l.status = 'active'
    returning l.id
  ) select coalesce(array_agg(t.id), '{}') into v_ids from t;
  -- 一時保存・下書きは索引から cascade で消える。
  delete from public.gbp_review_index i where i.location_id = any(v_ids);
  return coalesce(array_length(v_ids, 1), 0);
end;
$$;

-- 口コミの結び付けが外れた・別のアカウントに替わった・選択待ちに戻った(0021 の関数・運営の操作のどれでも)とき、
-- その店舗の有効なロケーションをすぐ無効にする。選択(gbp_select_location)の selection_pending → selected は何もしない。
create or replace function public.gbp_binding_changed()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- 店舗ごと削除されている途中(外部キーの cascade)なら何もしない(ロケーションも cascade で消える)。
  if not exists (select 1 from public.salons s where s.id = old.salon_id) then
    return null;
  end if;
  if tg_op = 'DELETE' then
    if old.feature = 'gbp' then
      perform public.gbp_deactivate_salon_locations(old.salon_id);
    end if;
    return null;
  end if;
  if new.feature = 'gbp' and (
       new.google_account_id is distinct from old.google_account_id
       or new.salon_id is distinct from old.salon_id
       or (new.gbp_selection_state is distinct from 'selected' and old.gbp_selection_state = 'selected')) then
    perform public.gbp_deactivate_salon_locations(old.salon_id);
  end if;
  return null;
end;
$$;
drop trigger if exists gbp_binding_changed on public.salon_google_bindings;
create trigger gbp_binding_changed
  after update or delete on public.salon_google_bindings
  for each row execute function public.gbp_binding_changed();

-- 店舗(ロケーション)を選ぶ。新しい世代の行を作り、前の世代は無効にして一時保存を消す。
--   ・その店舗の口コミの結び付けが p_google_account_id を指していなければ拒否(gbp:binding_changed)
--   ・ほかの店舗が有効に使っているロケーションは選べない(gbp:linked_elsewhere)
-- 戻り値は新しいロケーションの id。
create or replace function public.gbp_select_location(
  p_salon_id uuid,
  p_google_account_id uuid,
  p_account_name text,
  p_location_name text,
  p_title text,
  p_address text,
  p_user_id uuid
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_salon_id is null or p_google_account_id is null or p_account_name is null or p_location_name is null then
    raise exception 'gbp:invalid_arguments' using errcode = '22023';
  end if;
  perform 1 from public.salon_google_bindings b
   where b.salon_id = p_salon_id and b.feature = 'gbp' and b.google_account_id = p_google_account_id
   for update;
  if not found then
    raise exception 'gbp:binding_changed' using errcode = 'P0001';
  end if;
  perform public.gbp_deactivate_salon_locations(p_salon_id);
  begin
    insert into public.gbp_locations (salon_id, google_account_id, account_name, location_name, title_cache, address_cache,
                                      content_cached_at, status, selected_by_user_id)
    values (p_salon_id, p_google_account_id, p_account_name, p_location_name, left(p_title, 200), left(p_address, 300),
            case when p_title is not null then now() end, 'active', p_user_id)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'gbp:linked_elsewhere' using errcode = 'P0001';
  end;
  update public.salon_google_bindings b
     set gbp_selection_state = 'selected', updated_at = now()
   where b.salon_id = p_salon_id and b.feature = 'gbp';
  return v_id;
end;
$$;

-- そのロケーションを、ほかの店舗が有効に使っているか(選択の画面で「選べない」と出す)。
create or replace function public.gbp_location_linked_elsewhere(p_location_name text, p_salon_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (select 1 from public.gbp_locations l
                  where l.location_name = p_location_name and l.status = 'active' and l.salon_id <> p_salon_id)
$$;

-- 連携の同意(口コミの一時保存・返信は「Googleに返信する」を押したときだけ、など)を記録する。
create or replace function public.gbp_record_consent(p_salon_id uuid, p_user_id uuid, p_version text)
returns void
language sql
security invoker
set search_path = ''
as $$
  insert into public.gbp_consents (salon_id, user_id, consent_type, version) values (p_salon_id, p_user_id, 'connect', p_version)
$$;

-- ------------------------------------------------------------------
-- 3. 口コミの取り込み
-- ------------------------------------------------------------------

-- Google から取った口コミを、索引(HMAC のキー)と一時保存にまとめて入れる。
--   ・世代が使えるときだけ(gbp:location_inactive)。ロケーションの行を FOR SHARE で持ち、無効化と重ならない
--   ・p_sync_lease_token を渡したとき(同期の途中)は、その同期の処理権を持っているときだけ(gbp:sync_lease_lost)
-- p_reviews の各要素:review_key, review_name, reviewer_name, reviewer_photo_url, is_anonymous, star_rating,
--   comment, create_time, update_time, reply_comment, reply_update_time, reply_state, policy_violation, media, reply_url
create or replace function public.gbp_ingest_reviews(
  p_salon_id uuid,
  p_location_id uuid,
  p_sync_lease_token uuid,
  p_detected_via text,
  p_reviews jsonb,
  p_ttl_seconds integer
) returns table (review_index_id uuid, review_key text, created boolean)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  l public.gbp_locations%rowtype;
  r record;
  v_id uuid;
  v_created boolean;
begin
  if p_salon_id is null or p_location_id is null or p_detected_via is null
     or p_detected_via not in ('manual', 'reconcile', 'pubsub')
     or p_reviews is null or jsonb_typeof(p_reviews) <> 'array'
     or p_ttl_seconds is null or p_ttl_seconds not between 60 and 2592000 then
    raise exception 'gbp:invalid_arguments' using errcode = '22023';
  end if;
  select * into l from public.gbp_locations x where x.id = p_location_id and x.salon_id = p_salon_id for share;
  if not found or not public.gbp_location_usable(p_salon_id, p_location_id) then
    raise exception 'gbp:location_inactive' using errcode = 'P0001';
  end if;
  if p_sync_lease_token is not null
     and (l.sync_lease_token is distinct from p_sync_lease_token or l.sync_lease_until is null or l.sync_lease_until <= now()) then
    raise exception 'gbp:sync_lease_lost' using errcode = 'P0001';
  end if;

  for r in
    select * from jsonb_to_recordset(p_reviews) as x(
      review_key text, review_name text, reviewer_name text, reviewer_photo_url text, is_anonymous boolean,
      star_rating smallint, comment text, create_time timestamptz, update_time timestamptz, reply_comment text,
      reply_update_time timestamptz, reply_state text, policy_violation text, media jsonb, reply_url text)
  loop
    insert into public.gbp_review_index as i (salon_id, location_id, review_key_hash, detected_via)
    values (p_salon_id, p_location_id, r.review_key, p_detected_via)
    on conflict (location_id, review_key_hash) do update
      set last_synced_at = now(), deleted_on_google_at = null
    returning i.id, (i.xmax = 0) into v_id, v_created;

    insert into public.gbp_review_cache as c (review_index_id, salon_id, review_name, reviewer_name, reviewer_photo_url,
        is_anonymous, star_rating, comment, create_time, update_time, reply_comment, reply_update_time, reply_state,
        policy_violation, media, reply_url, fetched_at, expires_at)
    values (v_id, p_salon_id, r.review_name, r.reviewer_name, r.reviewer_photo_url, coalesce(r.is_anonymous, false),
        r.star_rating, coalesce(r.comment, ''), r.create_time, r.update_time, r.reply_comment, r.reply_update_time,
        r.reply_state, left(r.policy_violation, 100), coalesce(r.media, '[]'::jsonb), r.reply_url, now(),
        now() + make_interval(secs => p_ttl_seconds))
    on conflict (review_index_id) do update
      set review_name = excluded.review_name, reviewer_name = excluded.reviewer_name,
          reviewer_photo_url = excluded.reviewer_photo_url, is_anonymous = excluded.is_anonymous,
          star_rating = excluded.star_rating, comment = excluded.comment, create_time = excluded.create_time,
          update_time = excluded.update_time, reply_comment = excluded.reply_comment,
          reply_update_time = excluded.reply_update_time, reply_state = excluded.reply_state,
          policy_violation = excluded.policy_violation, media = excluded.media, reply_url = excluded.reply_url,
          fetched_at = excluded.fetched_at, expires_at = excluded.expires_at;

    return query select v_id, r.review_key, v_created;
  end loop;
end;
$$;

-- ------------------------------------------------------------------
-- 4. 同期(旧 0016 と同じ流れ。行が有効か、の確認を「世代が使えるか」にした)
-- ------------------------------------------------------------------

--   busy / continued / throttled / started / inactive(旧 0016 と同じ)
create or replace function public.gbp_begin_sync(
  p_salon_id uuid,
  p_location_id uuid,
  p_lease_seconds integer,
  p_full_after_seconds integer,
  p_min_interval_seconds integer,
  p_overlap_seconds integer
) returns table (
  outcome text,
  lease_token uuid,
  run_kind text,
  run_floor timestamptz,
  run_resume_before timestamptz,
  run_page_token text,
  synced_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  l public.gbp_locations%rowtype;
  v_token uuid := gen_random_uuid();
  v_full boolean;
  v_page text;
begin
  if p_salon_id is null or p_location_id is null
     or p_lease_seconds is null or p_lease_seconds not between 10 and 600
     or p_full_after_seconds is null or p_full_after_seconds not between 3600 and 2160000
     or p_min_interval_seconds is null or p_min_interval_seconds not between 0 and 86400
     or p_overlap_seconds is null or p_overlap_seconds not between 0 and 86400 then
    raise exception 'gbp:invalid_arguments' using errcode = '22023';
  end if;
  select * into l from public.gbp_locations x
   where x.id = p_location_id and x.salon_id = p_salon_id and x.status = 'active'
   for update;
  if not found or not public.gbp_location_usable(p_salon_id, p_location_id) then
    return query select 'inactive'::text, null::uuid, null::text, null::timestamptz, null::timestamptz, null::text, null::timestamptz;
    return;
  end if;
  if l.sync_lease_until is not null and l.sync_lease_until > now() then
    return query select 'busy'::text, null::uuid, null::text, null::timestamptz, null::timestamptz, null::text, l.last_synced_at;
    return;
  end if;

  if l.sync_run_kind is not null then
    v_page := case when l.sync_run_failures >= 2 then null else l.sync_run_page_token end;
    update public.gbp_locations x
       set sync_lease_token = v_token,
           sync_lease_until = now() + make_interval(secs => p_lease_seconds),
           sync_run_page_token = v_page,
           sync_run_failures = case when l.sync_run_failures >= 2 then 0 else l.sync_run_failures end
     where x.id = l.id;
    return query select 'continued'::text, v_token, l.sync_run_kind, l.sync_run_floor, l.sync_run_resume_before, v_page, l.last_synced_at;
    return;
  end if;

  if l.last_synced_at is not null and l.last_synced_at > now() - make_interval(secs => p_min_interval_seconds) then
    return query select 'throttled'::text, null::uuid, null::text, null::timestamptz, null::timestamptz, null::text, l.last_synced_at;
    return;
  end if;

  v_full := l.sync_watermark is null
    or l.full_sync_done_at is null
    or l.full_sync_done_at <= now() - make_interval(secs => p_full_after_seconds)
    or exists (
      select 1 from public.gbp_review_index i
       where i.location_id = l.id and i.salon_id = p_salon_id and i.deleted_on_google_at is null
         and not exists (
           select 1 from public.gbp_review_cache c where c.review_index_id = i.id and c.expires_at > now()));
  update public.gbp_locations x
     set sync_run_kind = case when v_full then 'full' else 'delta' end,
         sync_run_started_at = now(),
         sync_run_floor = case when v_full then null else l.sync_watermark - make_interval(secs => p_overlap_seconds) end,
         sync_run_newest = null,
         sync_run_resume_before = null,
         sync_run_page_token = null,
         sync_run_failures = 0,
         sync_lease_token = v_token,
         sync_lease_until = now() + make_interval(secs => p_lease_seconds)
   where x.id = l.id;
  return query select 'started'::text, v_token,
    case when v_full then 'full' else 'delta' end,
    case when v_full then null::timestamptz else l.sync_watermark - make_interval(secs => p_overlap_seconds) end,
    null::timestamptz, null::text, l.last_synced_at;
end;
$$;

-- 1ページ読み終えたところを記録する(処理権を持ち、世代が使えるときだけ)。false なら続けない。
create or replace function public.gbp_sync_checkpoint(
  p_salon_id uuid,
  p_location_id uuid,
  p_lease_token uuid,
  p_page_token text,
  p_resume_before timestamptz,
  p_newest timestamptz,
  p_average_rating numeric,
  p_total_review_count integer,
  p_lease_seconds integer
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_lease_token is null or p_page_token is null or char_length(p_page_token) > 4096
     or p_lease_seconds is null or p_lease_seconds not between 10 and 600 then
    raise exception 'gbp:invalid_arguments' using errcode = '22023';
  end if;
  if not public.gbp_location_usable(p_salon_id, p_location_id) then
    return false;
  end if;
  update public.gbp_locations l
     set sync_run_page_token = p_page_token,
         sync_run_resume_before = least(l.sync_run_resume_before, p_resume_before),
         sync_run_newest = greatest(l.sync_run_newest, p_newest),
         sync_run_failures = 0,
         average_rating = coalesce(p_average_rating, l.average_rating),
         total_review_count = coalesce(p_total_review_count, l.total_review_count),
         rating_cached_at = case when p_average_rating is not null or p_total_review_count is not null then now() else l.rating_cached_at end,
         sync_lease_until = now() + make_interval(secs => p_lease_seconds)
   where l.id = p_location_id and l.salon_id = p_salon_id and l.status = 'active' and l.sync_run_kind is not null
     and l.sync_lease_token = p_lease_token and l.sync_lease_until > now();
  return found;
end;
$$;

-- 最後まで読み終えた。watermark を進め、初回の取り込みを完了にする(新着の数え始め)。処理権を失っていたら null。
create or replace function public.gbp_finish_sync(
  p_salon_id uuid,
  p_location_id uuid,
  p_lease_token uuid,
  p_newest timestamptz,
  p_average_rating numeric,
  p_total_review_count integer
) returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
declare
  l public.gbp_locations%rowtype;
  v_at timestamptz := now();
begin
  if p_lease_token is null then
    raise exception 'gbp:invalid_arguments' using errcode = '22023';
  end if;
  select * into l from public.gbp_locations x
   where x.id = p_location_id and x.salon_id = p_salon_id and x.status = 'active' and x.sync_run_kind is not null
     and x.sync_lease_token = p_lease_token and x.sync_lease_until > now()
   for update;
  if not found or not public.gbp_location_usable(p_salon_id, p_location_id) then
    return null;
  end if;
  if l.sync_run_kind = 'full' then
    update public.gbp_review_index i
       set deleted_on_google_at = v_at
     where i.location_id = l.id and i.salon_id = p_salon_id and i.deleted_on_google_at is null
       and i.last_synced_at < l.sync_run_started_at
       and not exists (select 1 from public.gbp_review_cache c where c.review_index_id = i.id and c.expires_at > v_at);
  end if;
  update public.gbp_locations x
     set sync_watermark = greatest(x.sync_watermark, x.sync_run_newest, p_newest),
         last_synced_at = v_at,
         initial_sync_done_at = coalesce(x.initial_sync_done_at, v_at),
         full_sync_done_at = case when x.sync_run_kind = 'full' then v_at else x.full_sync_done_at end,
         average_rating = coalesce(p_average_rating, x.average_rating),
         total_review_count = coalesce(p_total_review_count, x.total_review_count),
         rating_cached_at = case when p_average_rating is not null or p_total_review_count is not null then v_at else x.rating_cached_at end,
         sync_run_kind = null,
         sync_run_started_at = null,
         sync_run_floor = null,
         sync_run_newest = null,
         sync_run_resume_before = null,
         sync_run_page_token = null,
         sync_run_failures = 0,
         sync_lease_token = null,
         sync_lease_until = null
   where x.id = l.id;
  return v_at;
end;
$$;

-- 途中で区切る・失敗した:処理権を返す(旧 0016 と同じ)。
create or replace function public.gbp_release_sync(
  p_salon_id uuid,
  p_location_id uuid,
  p_lease_token uuid,
  p_contacted boolean,
  p_failed boolean,
  p_hold_seconds integer
) returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_at timestamptz;
begin
  if p_lease_token is null or p_hold_seconds is null or p_hold_seconds not between 0 and 3600 then
    raise exception 'gbp:invalid_arguments' using errcode = '22023';
  end if;
  update public.gbp_locations l
     set sync_lease_token = null,
         sync_lease_until = case when p_hold_seconds > 0 then now() + make_interval(secs => p_hold_seconds) else null end,
         sync_run_failures = l.sync_run_failures + case when coalesce(p_failed, false) then 1 else 0 end,
         last_synced_at = case when coalesce(p_contacted, false) then now() else l.last_synced_at end
   where l.id = p_location_id and l.salon_id = p_salon_id and l.status = 'active' and l.sync_lease_token = p_lease_token
  returning l.last_synced_at into v_at;
  return v_at;
end;
$$;

-- ロケーションの名前・住所(Google のデータ)を取り直したとき。25日の数え直し。
create or replace function public.gbp_update_location_info(p_salon_id uuid, p_location_id uuid, p_title text, p_address text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_title is null or btrim(p_title) = '' then
    raise exception 'gbp:invalid_arguments' using errcode = '22023';
  end if;
  if not public.gbp_location_usable(p_salon_id, p_location_id) then
    return false;
  end if;
  update public.gbp_locations l
     set title_cache = left(p_title, 200), address_cache = left(p_address, 300), content_cached_at = now()
   where l.id = p_location_id and l.salon_id = p_salon_id and l.status = 'active';
  return found;
end;
$$;

-- ------------------------------------------------------------------
-- 5. 画面の上部の情報(新着・Google の値・取り込みの状態)
-- ------------------------------------------------------------------

-- その店舗の今のロケーション(使える世代)の情報。行が無ければ何も返さない。
--   new_count : 初回の取り込みが終わったあとに初めて見つけ、まだ開いていない、内容を表示できる口コミの数。
--               初回の取り込みが終わっていなければ null(数えない)。
--   average_rating / total_review_count : Google の値(取ってから25日以内のときだけ。無ければ null。0 にしない)
--   has_expired : 内容の一時保存の期限が切れた(取り直しが要る)口コミがある
create or replace function public.gbp_inbox_summary(p_salon_id uuid)
returns table (
  location_id uuid,
  google_account_id uuid,
  account_name text,
  location_name text,
  title text,
  average_rating numeric,
  total_review_count integer,
  rating_cached_at timestamptz,
  last_synced_at timestamptz,
  initial_sync_done boolean,
  sync_in_progress boolean,
  has_expired boolean,
  new_count integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  select l.id, l.google_account_id, l.account_name, l.location_name,
         case when l.content_cached_at > now() - interval '25 days' then l.title_cache end,
         case when l.rating_cached_at > now() - interval '25 days' then l.average_rating end,
         case when l.rating_cached_at > now() - interval '25 days' then l.total_review_count end,
         case when l.rating_cached_at > now() - interval '25 days' then l.rating_cached_at end,
         l.last_synced_at,
         l.initial_sync_done_at is not null,
         l.sync_run_kind is not null,
         exists (
           select 1 from public.gbp_review_index i
            where i.location_id = l.id and i.deleted_on_google_at is null
              and not exists (select 1 from public.gbp_review_cache c where c.review_index_id = i.id and c.expires_at > now())),
         case when l.initial_sync_done_at is null then null else (
           select count(*)::integer
             from public.gbp_review_index i
             join public.gbp_review_cache c on c.review_index_id = i.id and c.expires_at > now()
            where i.location_id = l.id and i.salon_id = p_salon_id and i.deleted_on_google_at is null
              and i.seen_at is null and i.first_seen_at > l.initial_sync_done_at) end
    from public.gbp_locations l
   where l.salon_id = p_salon_id and l.status = 'active'
     and public.gbp_location_usable(p_salon_id, l.id)
$$;

-- 一時保存の期限が切れた(Google 上で削除されていない)口コミがあるか。
create or replace function public.gbp_has_expired_reviews(p_salon_id uuid, p_location_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1 from public.gbp_review_index i
     where i.location_id = p_location_id and i.salon_id = p_salon_id and i.deleted_on_google_at is null
       and not exists (select 1 from public.gbp_review_cache c where c.review_index_id = i.id and c.expires_at > now()))
$$;

-- ------------------------------------------------------------------
-- 6. 既読・下書き・削除済み(どれも、使える世代の口コミだけ)
-- ------------------------------------------------------------------

create or replace function public.gbp_set_seen(p_salon_id uuid, p_review_index_id uuid, p_seen boolean)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.gbp_review_index i
     set seen_at = case when p_seen then coalesce(i.seen_at, now()) else null end
   where i.id = p_review_index_id and i.salon_id = p_salon_id
     and public.gbp_location_usable(p_salon_id, i.location_id);
  return found;
end;
$$;

-- 下書きの保存。空なら消す。戻り値は保存した時刻(消したときは now())。使える世代の口コミでなければ null(保存しない)。
create or replace function public.gbp_save_draft(p_salon_id uuid, p_review_index_id uuid, p_text text, p_ttl_seconds integer)
returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_at timestamptz := now();
  v_location uuid;
begin
  if p_ttl_seconds is null or p_ttl_seconds not between 60 and 2592000 or p_text is null or char_length(p_text) > 5000 then
    raise exception 'gbp:invalid_arguments' using errcode = '22023';
  end if;
  select i.location_id into v_location from public.gbp_review_index i
   where i.id = p_review_index_id and i.salon_id = p_salon_id;
  if not found then
    return null;
  end if;
  perform 1 from public.gbp_locations l where l.id = v_location for share;
  if not public.gbp_location_usable(p_salon_id, v_location) then
    return null;
  end if;
  if btrim(p_text) = '' then
    delete from public.gbp_reply_drafts d where d.review_index_id = p_review_index_id and d.salon_id = p_salon_id;
    return v_at;
  end if;
  insert into public.gbp_reply_drafts as d (review_index_id, salon_id, draft_text, updated_at, expires_at)
  values (p_review_index_id, p_salon_id, p_text, v_at, v_at + make_interval(secs => p_ttl_seconds))
  on conflict (review_index_id) do update
    set draft_text = excluded.draft_text, updated_at = excluded.updated_at, expires_at = excluded.expires_at
  where d.salon_id = p_salon_id;
  return v_at;
end;
$$;

-- Google 上で削除された口コミ。一時保存の内容は消し、下書きは残す(期限で消える)。
create or replace function public.gbp_mark_review_deleted(p_salon_id uuid, p_review_index_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.gbp_review_index i set deleted_on_google_at = coalesce(i.deleted_on_google_at, now())
   where i.id = p_review_index_id and i.salon_id = p_salon_id
     and public.gbp_location_usable(p_salon_id, i.location_id);
  if not found then
    return false;
  end if;
  delete from public.gbp_review_cache c where c.review_index_id = p_review_index_id and c.salon_id = p_salon_id;
  return true;
end;
$$;

-- ------------------------------------------------------------------
-- 7. 期限の削除(利用可否・機能のフラグ・Google の接続に関係なく実行する)
-- ------------------------------------------------------------------

-- 毎日の削除。
--   ・使えなくなった世代(結び付けが外れた・替わった)のロケーションを無効にし、一時保存・下書き・索引を消す
--   ・期限切れの一時保存・下書き
--   ・取ってから25日を過ぎたロケーションの名前・住所、★の平均・件数(別々に数える)
-- 戻り値は消した数。
create or replace function public.gbp_purge_expired_content()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_salon uuid;
  v_unusable integer := 0;
  v_cache integer;
  v_drafts integer;
  v_title integer;
  v_rating integer;
begin
  for v_salon in
    select distinct l.salon_id from public.gbp_locations l
     where l.status = 'active' and not public.gbp_location_usable(l.salon_id, l.id)
     order by l.salon_id
  loop
    v_unusable := v_unusable + public.gbp_deactivate_salon_locations(v_salon);
  end loop;
  delete from public.gbp_review_index i
   using public.gbp_locations l
   where l.id = i.location_id and l.status <> 'active';
  delete from public.gbp_review_cache c where c.expires_at <= now();
  get diagnostics v_cache = row_count;
  delete from public.gbp_reply_drafts d where d.expires_at <= now();
  get diagnostics v_drafts = row_count;
  update public.gbp_locations l
     set title_cache = null, address_cache = null, content_cached_at = null
   where l.content_cached_at is not null and l.content_cached_at <= now() - interval '25 days';
  get diagnostics v_title = row_count;
  update public.gbp_locations l
     set average_rating = null, total_review_count = null, rating_cached_at = null
   where l.rating_cached_at is not null and l.rating_cached_at <= now() - interval '25 days';
  get diagnostics v_rating = row_count;
  return jsonb_build_object('unusable_locations', v_unusable, 'cache', v_cache, 'drafts', v_drafts,
                            'location_titles', v_title, 'location_ratings', v_rating);
end;
$$;

-- ------------------------------------------------------------------
-- 8. 権限(service role だけ)
-- ------------------------------------------------------------------
revoke all on function public.gbp_location_usable(uuid, uuid) from public, anon, authenticated;
revoke all on function public.gbp_deactivate_salon_locations(uuid) from public, anon, authenticated;
revoke all on function public.gbp_binding_changed() from public, anon, authenticated;
revoke all on function public.gbp_select_location(uuid, uuid, text, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.gbp_location_linked_elsewhere(text, uuid) from public, anon, authenticated;
revoke all on function public.gbp_record_consent(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.gbp_ingest_reviews(uuid, uuid, uuid, text, jsonb, integer) from public, anon, authenticated;
revoke all on function public.gbp_begin_sync(uuid, uuid, integer, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.gbp_sync_checkpoint(uuid, uuid, uuid, text, timestamptz, timestamptz, numeric, integer, integer) from public, anon, authenticated;
revoke all on function public.gbp_finish_sync(uuid, uuid, uuid, timestamptz, numeric, integer) from public, anon, authenticated;
revoke all on function public.gbp_release_sync(uuid, uuid, uuid, boolean, boolean, integer) from public, anon, authenticated;
revoke all on function public.gbp_update_location_info(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.gbp_inbox_summary(uuid) from public, anon, authenticated;
revoke all on function public.gbp_has_expired_reviews(uuid, uuid) from public, anon, authenticated;
revoke all on function public.gbp_set_seen(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.gbp_save_draft(uuid, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.gbp_mark_review_deleted(uuid, uuid) from public, anon, authenticated;
revoke all on function public.gbp_purge_expired_content() from public, anon, authenticated;
grant execute on function public.gbp_location_usable(uuid, uuid) to service_role;
grant execute on function public.gbp_deactivate_salon_locations(uuid) to service_role;
grant execute on function public.gbp_binding_changed() to service_role;
grant execute on function public.gbp_select_location(uuid, uuid, text, text, text, text, uuid) to service_role;
grant execute on function public.gbp_location_linked_elsewhere(text, uuid) to service_role;
grant execute on function public.gbp_record_consent(uuid, uuid, text) to service_role;
grant execute on function public.gbp_ingest_reviews(uuid, uuid, uuid, text, jsonb, integer) to service_role;
grant execute on function public.gbp_begin_sync(uuid, uuid, integer, integer, integer, integer) to service_role;
grant execute on function public.gbp_sync_checkpoint(uuid, uuid, uuid, text, timestamptz, timestamptz, numeric, integer, integer) to service_role;
grant execute on function public.gbp_finish_sync(uuid, uuid, uuid, timestamptz, numeric, integer) to service_role;
grant execute on function public.gbp_release_sync(uuid, uuid, uuid, boolean, boolean, integer) to service_role;
grant execute on function public.gbp_update_location_info(uuid, uuid, text, text) to service_role;
grant execute on function public.gbp_inbox_summary(uuid) to service_role;
grant execute on function public.gbp_has_expired_reviews(uuid, uuid) to service_role;
grant execute on function public.gbp_set_seen(uuid, uuid, boolean) to service_role;
grant execute on function public.gbp_save_draft(uuid, uuid, text, integer) to service_role;
grant execute on function public.gbp_mark_review_deleted(uuid, uuid) to service_role;
grant execute on function public.gbp_purge_expired_content() to service_role;
