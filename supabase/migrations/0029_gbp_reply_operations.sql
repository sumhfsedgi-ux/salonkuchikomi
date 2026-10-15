-- 0029: Google への返信の投稿・置き換え・削除の操作の記録と、届いた口コミの一覧・詳細。
-- 計画: ~/.claude/plans(口コミの実装計画 第2版)§2(返信の状態)・§3-A(連携の変更と処理の重なり)。
-- 旧 feature/reviews-d1-reply-engine の 0017 をもとに、次を変えた。
--   ・操作は「口コミのキー(HMAC)とロケーションの名前」で口コミを特定する(世代が替わっても、送り始めた操作を追える)。
--     口コミの索引・ロケーションの行への参照は、消えたら外れる(on delete set null)。記録(本文なし)は残る。
--   ・操作の開始と送る直前(gbp_reply_start_send)に、利用可否(salon_feature_entitled 'google_reviews'。利用可否の基準行を
--     FOR SHARE してから読む。0024 の送信の直前の確認と同じ)と、世代が使えるか(gbp_location_usable)を確かめる。
--     使えなければ送らない(送り始める前なら failed、前の試行で送り始めていたら unknown)。
--   ・終わりの記録は、処理権があれば結果(受け付け・失敗・不明)を残す。一時保存・下書きへの書き戻しは、
--     世代が今も使えるときだけ(連携が変わったあとに古い処理が書き戻さない)。
--   ・表示の状態を細かく分ける(送信中/送信結果を確認中/送信できませんでした/置き換えできませんでした/
--     削除できませんでした)。絞り込みは 未返信 / 確認が必要 / 返信済み / すべて / 新着。
--     「未返信」は、取り直した Google のデータで返信が無く、送信中・結果不明の操作が無いものだけ。
-- テーブルは RLS を有効にしてポリシーを作らない。関数は service role だけ。何度実行しても同じ結果になる。

create table if not exists public.gbp_reply_operations (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  op_id uuid not null unique,
  salon_id uuid not null references public.salons(id) on delete cascade,
  location_name text not null check (location_name ~ '^locations/[^/]+$'),
  review_key_hash text not null check (char_length(review_key_hash) between 32 and 128),
  review_index_id uuid references public.gbp_review_index(id) on delete set null,
  location_id uuid references public.gbp_locations(id) on delete set null,
  action text not null check (action in ('upsert', 'delete')),
  actor_user_id uuid not null,
  text_sha256 text check (text_sha256 ~ '^[0-9a-f]{64}$'),
  byte_len integer check (byte_len between 1 and 4096),
  base_reply_sha256 text check (base_reply_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('sending', 'accepted', 'confirmed', 'unknown', 'failed', 'conflict', 'dismissed')),
  error_code text check (char_length(error_code) <= 60),
  attempts integer not null default 1 check (attempts between 1 and 20),
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  last_attempt_at timestamptz not null default now(),
  completed_at timestamptz,
  -- Google への書き込みを始めた時刻(一度でも始めたら残す。送る前に止まったかの判断に使う)
  send_started_at timestamptz,
  check ((action = 'upsert') = (text_sha256 is not null and byte_len is not null)),
  check ((status = 'sending') = (lease_token is not null and lease_until is not null))
);
create index if not exists gbp_reply_operations_review
  on public.gbp_reply_operations (salon_id, location_name, review_key_hash, seq desc);
create index if not exists gbp_reply_operations_location_recent
  on public.gbp_reply_operations (location_name, last_attempt_at desc);
-- 1つの口コミに、送っている途中の操作は1つだけ(世代をまたいでも)。
create unique index if not exists gbp_reply_operations_one_sending
  on public.gbp_reply_operations (salon_id, location_name, review_key_hash) where status = 'sending';

alter table public.gbp_reply_operations enable row level security;
revoke all on table public.gbp_reply_operations from anon, authenticated;

-- 届いた口コミの利用可否(利用可否の基準行を FOR SHARE してから読む。権限の変更と同時に送り始めない)。
create or replace function public.gbp_reviews_entitled(p_salon_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform 1 from public.salon_entitlement_state st where st.salon_id = p_salon_id for share;
  return public.salon_feature_entitled(p_salon_id, 'google_reviews');
end;
$$;

-- 操作を始める(または、同じ op_id の操作を続ける)。
--   new / retry / done / failed / conflict / dismissed / busy / mismatch / rate_limited / not_found(旧 0017 と同じ)
--   not_entitled : 届いた口コミを使えない店舗(何も記録しない・送らない)
create or replace function public.gbp_begin_reply_operation(
  p_op_id uuid,
  p_salon_id uuid,
  p_review_index_id uuid,
  p_action text,
  p_text_sha256 text,
  p_byte_len integer,
  p_base_reply_sha256 text,
  p_actor_user_id uuid,
  p_lease_seconds integer,
  p_rate_per_minute integer
) returns table (outcome text, operation_id uuid, lease_token uuid, status text, base_reply_sha256 text)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_location_id uuid;
  v_location_name text;
  v_key text;
  o public.gbp_reply_operations%rowtype;
  v_token uuid := gen_random_uuid();
  v_recent integer;
begin
  if p_op_id is null or p_salon_id is null or p_review_index_id is null or p_actor_user_id is null
     or p_action is null or p_action not in ('upsert', 'delete')
     or (p_action = 'upsert') <> (p_text_sha256 is not null and p_byte_len is not null)
     or p_lease_seconds is null or p_lease_seconds not between 10 and 600
     or p_rate_per_minute is null or p_rate_per_minute not between 1 and 100 then
    raise exception 'gbp:invalid_arguments' using errcode = '22023';
  end if;
  -- 同じ op_id の同時の要求は、ここで1つずつにする。
  perform pg_advisory_xact_lock(hashtext('gbp:reply_op:' || p_op_id::text));

  if not public.gbp_reviews_entitled(p_salon_id) then
    return query select 'not_entitled'::text, null::uuid, null::uuid, null::text, null::text;
    return;
  end if;

  select l.id, l.location_name, i.review_key_hash into v_location_id, v_location_name, v_key
    from public.gbp_review_index i join public.gbp_locations l on l.id = i.location_id
   where i.id = p_review_index_id and i.salon_id = p_salon_id and l.salon_id = p_salon_id
     and i.deleted_on_google_at is null
     and public.gbp_location_usable(p_salon_id, l.id);
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid, null::text, null::text;
    return;
  end if;

  select * into o from public.gbp_reply_operations x where x.op_id = p_op_id for update;
  if found then
    if o.salon_id <> p_salon_id or o.location_name <> v_location_name or o.review_key_hash <> v_key
       or o.action <> p_action or o.text_sha256 is distinct from p_text_sha256 then
      return query select 'mismatch'::text, null::uuid, null::uuid, null::text, null::text;
      return;
    end if;
    if o.status = 'sending' and o.lease_until > now() then
      return query select 'busy'::text, o.id, null::uuid, o.status, o.base_reply_sha256;
      return;
    end if;
    if o.status in ('accepted', 'confirmed') then
      return query select 'done'::text, o.id, null::uuid, o.status, o.base_reply_sha256;
      return;
    end if;
    if o.status in ('failed', 'conflict', 'dismissed') then
      return query select o.status, o.id, null::uuid, o.status, o.base_reply_sha256;
      return;
    end if;
    if o.status = 'sending' and o.send_started_at is null then
      update public.gbp_reply_operations x
         set status = 'failed', lease_token = null, lease_until = null, error_code = 'expired_before_send', completed_at = now()
       where x.id = o.id;
      return query select 'failed'::text, o.id, null::uuid, 'failed'::text, o.base_reply_sha256;
      return;
    end if;
    -- unknown・送信中の停止:結果が分からないので、下の確認のあと、確かめてから続ける(呼び出し側が取り直す)。
  end if;

  perform pg_advisory_xact_lock(hashtext('gbp:reply_review:' || p_salon_id::text || ':' || v_location_name || ':' || v_key));
  -- 送っている途中のまま処理権が切れた操作を終わりにする。送り始める前なら failed、送り始めていたら unknown。
  update public.gbp_reply_operations x
     set status = case when x.send_started_at is null then 'failed' else 'unknown' end,
         lease_token = null, lease_until = null,
         error_code = case when x.send_started_at is null then 'expired_before_send' else 'lease_expired' end,
         completed_at = now()
   where x.salon_id = p_salon_id and x.location_name = v_location_name and x.review_key_hash = v_key
     and x.status = 'sending' and x.lease_until <= now();
  if exists (select 1 from public.gbp_reply_operations x
              where x.salon_id = p_salon_id and x.location_name = v_location_name and x.review_key_hash = v_key
                and x.status = 'sending') then
    return query select 'busy'::text, o.id, null::uuid, o.status, o.base_reply_sha256;
    return;
  end if;
  -- 1分の回数は、ロケーションごとに1つずつ数える(ロックの順番は op_id → 口コミ → ロケーション)。
  perform pg_advisory_xact_lock(hashtext('gbp:reply_rate:' || v_location_name));
  select count(*) into v_recent from public.gbp_reply_operations x
   where x.location_name = v_location_name and x.last_attempt_at > now() - interval '1 minute';
  if v_recent >= p_rate_per_minute then
    return query select 'rate_limited'::text, o.id, null::uuid, o.status, o.base_reply_sha256;
    return;
  end if;

  if o.id is not null then
    update public.gbp_reply_operations x
       set status = 'sending', lease_token = v_token, lease_until = now() + make_interval(secs => p_lease_seconds),
           attempts = least(x.attempts + 1, 20), last_attempt_at = now(), completed_at = null,
           review_index_id = p_review_index_id, location_id = v_location_id
     where x.id = o.id;
    return query select 'retry'::text, o.id, v_token, 'unknown'::text, o.base_reply_sha256;
    return;
  end if;
  insert into public.gbp_reply_operations as x (op_id, salon_id, location_name, review_key_hash, review_index_id, location_id,
      action, actor_user_id, text_sha256, byte_len, base_reply_sha256, status, lease_token, lease_until)
  values (p_op_id, p_salon_id, v_location_name, v_key, p_review_index_id, v_location_id,
      p_action, p_actor_user_id, p_text_sha256, p_byte_len, p_base_reply_sha256, 'sending', v_token,
      now() + make_interval(secs => p_lease_seconds))
  returning x.* into o;
  return query select 'new'::text, o.id, v_token, o.status, o.base_reply_sha256;
end;
$$;

-- Google に書き込む直前の確認。
--   ok               : 処理権・利用可否・世代のどれも有効。送信の開始を記録し、処理権を p_window_seconds に延ばす。
--                      送る直前に取り直した口コミ(p_reviews)を一時保存に入れる。
--   lease_lost       : 処理権が無い(何も変えない。呼び出し側は書き込まない)
--   not_entitled     : 届いた口コミを使えなくなった。送らない(前の試行で送り始めていれば unknown、でなければ failed)
--   location_changed : 連携・店舗が変わった(世代が使えない)。送らない(同上)
create or replace function public.gbp_reply_start_send(
  p_salon_id uuid,
  p_operation_id uuid,
  p_lease_token uuid,
  p_window_seconds integer,
  p_reviews jsonb,
  p_ttl_seconds integer
) returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  o public.gbp_reply_operations%rowtype;
  v_block text;
begin
  if p_lease_token is null or p_window_seconds is null or p_window_seconds not between 5 and 600 then
    raise exception 'gbp:invalid_arguments' using errcode = '22023';
  end if;
  select * into o from public.gbp_reply_operations x
   where x.id = p_operation_id and x.salon_id = p_salon_id
   for update;
  if not found or o.status <> 'sending' or o.lease_token is distinct from p_lease_token or o.lease_until <= now() then
    return 'lease_lost';
  end if;
  if not public.gbp_reviews_entitled(p_salon_id) then
    v_block := 'not_entitled';
  elsif o.location_id is null then
    v_block := 'location_changed';
  else
    perform 1 from public.gbp_locations l where l.id = o.location_id for share;
    if not public.gbp_location_usable(p_salon_id, o.location_id) then
      v_block := 'location_changed';
    end if;
  end if;
  if v_block is not null then
    update public.gbp_reply_operations x
       set status = case when x.send_started_at is null then 'failed' else 'unknown' end,
           error_code = v_block, lease_token = null, lease_until = null, completed_at = now()
     where x.id = o.id;
    return v_block;
  end if;
  update public.gbp_reply_operations x
     set send_started_at = coalesce(x.send_started_at, now()),
         lease_until = greatest(x.lease_until, now() + make_interval(secs => p_window_seconds))
   where x.id = o.id;
  if p_reviews is not null and jsonb_typeof(p_reviews) = 'array' and jsonb_array_length(p_reviews) > 0 then
    perform 1 from public.gbp_ingest_reviews(p_salon_id, o.location_id, null, 'manual', p_reviews, p_ttl_seconds);
  end if;
  return 'ok';
end;
$$;

-- 操作を終える(処理権を持っているときだけ)。p_status:accepted / confirmed / unknown / failed / conflict。
-- 一時保存の更新(p_reviews)と下書きの削除(下書きの更新時刻が p_clear_draft_updated_at のままのときだけ)は、
-- 世代が今も使えるときだけ行う(連携・店舗が変わったあとに書き戻さない)。処理権が無ければ false(何も変えない)。
create or replace function public.gbp_finish_reply_operation(
  p_salon_id uuid,
  p_operation_id uuid,
  p_lease_token uuid,
  p_status text,
  p_error_code text,
  p_reviews jsonb,
  p_ttl_seconds integer,
  p_clear_draft_updated_at timestamptz
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  o public.gbp_reply_operations%rowtype;
  v_usable boolean := false;
begin
  if p_lease_token is null or p_status is null or p_status not in ('accepted', 'confirmed', 'unknown', 'failed', 'conflict') then
    raise exception 'gbp:invalid_arguments' using errcode = '22023';
  end if;
  select * into o from public.gbp_reply_operations x
   where x.id = p_operation_id and x.salon_id = p_salon_id
   for update;
  if not found or o.status <> 'sending' or o.lease_token is distinct from p_lease_token or o.lease_until <= now() then
    return false;
  end if;
  if o.location_id is not null then
    perform 1 from public.gbp_locations l where l.id = o.location_id for share;
    v_usable := public.gbp_location_usable(p_salon_id, o.location_id);
  end if;
  if v_usable then
    if p_reviews is not null and jsonb_typeof(p_reviews) = 'array' and jsonb_array_length(p_reviews) > 0 then
      perform 1 from public.gbp_ingest_reviews(p_salon_id, o.location_id, null, 'manual', p_reviews, p_ttl_seconds);
    end if;
    if p_clear_draft_updated_at is not null and o.review_index_id is not null then
      delete from public.gbp_reply_drafts d
       where d.review_index_id = o.review_index_id and d.salon_id = p_salon_id
         and date_trunc('milliseconds', d.updated_at) = date_trunc('milliseconds', p_clear_draft_updated_at);
    end if;
  end if;
  update public.gbp_reply_operations x
     set status = p_status, error_code = left(p_error_code, 60), lease_token = null, lease_until = null, completed_at = now()
   where x.id = o.id;
  return true;
end;
$$;

-- Google から取り直した返信(本文の SHA-256・審査の状態・更新日時。返信が無ければ null)で、その口コミの操作の状態を確かめる
-- (旧 0017 と同じ規則。口コミはキーとロケーションの名前で特定する。使える世代の口コミのときだけ)。
create or replace function public.gbp_reconcile_reply_operations(
  p_salon_id uuid,
  p_review_index_id uuid,
  p_reply_sha256 text,
  p_reply_state text,
  p_reply_update_time timestamptz
) returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_name text;
  v_key text;
  v_count integer;
begin
  select l.location_name, i.review_key_hash into v_name, v_key
    from public.gbp_review_index i join public.gbp_locations l on l.id = i.location_id
   where i.id = p_review_index_id and i.salon_id = p_salon_id and public.gbp_location_usable(p_salon_id, l.id);
  if not found then
    return 0;
  end if;
  update public.gbp_reply_operations x
     set status = case
           when x.action = 'upsert' and x.text_sha256 = p_reply_sha256
             then case when p_reply_state in ('PENDING', 'APPROVED', 'REJECTED') then 'confirmed' else 'accepted' end
           when x.action = 'delete' and p_reply_sha256 is null then 'confirmed'
           when x.status = 'accepted' and p_reply_update_time is not null and p_reply_update_time > x.completed_at then 'dismissed'
           else x.status end,
         lease_token = null,
         lease_until = null,
         completed_at = coalesce(x.completed_at, now())
   where x.salon_id = p_salon_id and x.location_name = v_name and x.review_key_hash = v_key
     and (x.status in ('accepted', 'unknown') or (x.status = 'sending' and x.lease_until <= now()))
     and (
       (x.action = 'upsert' and x.text_sha256 = p_reply_sha256)
       or (x.action = 'delete' and p_reply_sha256 is null)
       or (x.status = 'accepted' and p_reply_update_time is not null and p_reply_update_time > x.completed_at)
     );
  get diagnostics v_count = row_count;
  update public.gbp_reply_operations x
     set status = case when x.send_started_at is null then 'failed' else 'unknown' end,
         lease_token = null, lease_until = null,
         error_code = case when x.send_started_at is null then 'expired_before_send' else coalesce(x.error_code, 'lease_expired') end,
         completed_at = now()
   where x.salon_id = p_salon_id and x.location_name = v_name and x.review_key_hash = v_key
     and x.status = 'sending' and x.lease_until <= now();
  return v_count;
end;
$$;

-- 結果不明・失敗のまま使わなくなった操作を、表示しないようにする(その店舗の、使える世代の口コミだけ)。
create or replace function public.gbp_dismiss_reply_operation(p_salon_id uuid, p_review_index_id uuid)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_name text;
  v_key text;
  v_count integer;
begin
  select l.location_name, i.review_key_hash into v_name, v_key
    from public.gbp_review_index i join public.gbp_locations l on l.id = i.location_id
   where i.id = p_review_index_id and i.salon_id = p_salon_id and public.gbp_location_usable(p_salon_id, l.id);
  if not found then
    return 0;
  end if;
  update public.gbp_reply_operations x
     set status = 'dismissed', completed_at = coalesce(x.completed_at, now())
   where x.salon_id = p_salon_id and x.location_name = v_name and x.review_key_hash = v_key
     and x.status in ('unknown', 'failed');
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- 口コミの表示に使う、いちばん新しい操作の状態。
--   sending        : 送っている途中(処理権の間)
--   unknown        : 結果が分からない(時間切れ・通信の切断・送り始めてからの停止)
--   sent_checking  : Google が受け付けた。反映(審査の状態)をまだ取り直して確かめていない
--   send_failed    : 送れなかった(反映されていないと分かっている)。Google 上に返信が無い
--   replace_failed : 置き換えが失敗し、以前の返信が Google に残っている
--   delete_failed  : 削除が失敗し、返信が Google に残っている
--   none           : 表示する操作が無い(失敗のあとに Google の返信が変わった、も含む)
create or replace function public.gbp_reply_op_display(
  p_salon_id uuid,
  p_location_name text,
  p_review_key_hash text,
  p_has_reply boolean,
  p_reply_update_time timestamptz
) returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce((
    select case
             when o.status = 'sending' and o.lease_until > now() then 'sending'
             when o.status = 'sending' and o.send_started_at is null then 'send_failed'
             when o.status in ('sending', 'unknown') then 'unknown'
             when o.status = 'accepted' then 'sent_checking'
             when o.status = 'failed' and (p_reply_update_time is null or p_reply_update_time <= o.completed_at) then
               case
                 when o.action = 'upsert' and not p_has_reply then 'send_failed'
                 when o.action = 'upsert' and o.base_reply_sha256 is not null and p_has_reply then 'replace_failed'
                 when o.action = 'delete' and p_has_reply then 'delete_failed'
                 else 'none'
               end
             else 'none'
           end
      from public.gbp_reply_operations o
     where o.salon_id = p_salon_id and o.location_name = p_location_name and o.review_key_hash = p_review_key_hash
     order by o.seq desc
     limit 1), 'none')
$$;

-- 絞り込みの分類(lib/googleReviews/replyState.ts の replyBucket と同じ規則)。
--   attention : 送信中・送信結果を確認中・置き換え/削除できなかった・公開できなかった
--   unreplied : 取り直した Google のデータで返信が無く、送信中・結果不明の操作が無い(送れなかった、を含む)
--   replied   : 返信がある(審査中・公開済み・状態なし)
create or replace function public.gbp_reply_bucket(p_operation text, p_has_reply boolean, p_reply_state text)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
           when p_operation in ('sending', 'unknown', 'sent_checking', 'replace_failed', 'delete_failed') then 'attention'
           when p_operation = 'send_failed' and not p_has_reply then 'unreplied'
           when p_has_reply and p_reply_state = 'REJECTED' then 'attention'
           when p_has_reply then 'replied'
           else 'unreplied'
         end
$$;

-- 一覧(その店舗の、使える世代のロケーションの、一時保存の期限内で Google 上で削除されていない口コミ)。
--   p_filter:unreplied / attention / replied / all / new
--   p_rating:all / 5 / 4 / 3 / low(★1〜2)、p_sort:newest(投稿日の新しい順)/ lowest(★の低い順)
-- 次のページがあるか分かるよう、p_limit + 1 件まで返す。
drop function if exists public.gbp_list_reviews(uuid, text, text, text, integer, integer);
create function public.gbp_list_reviews(
  p_salon_id uuid,
  p_filter text,
  p_rating text,
  p_sort text,
  p_offset integer,
  p_limit integer
) returns table (
  review_index_id uuid,
  location_id uuid,
  reviewer_name text,
  reviewer_photo_url text,
  is_anonymous boolean,
  star_rating smallint,
  comment text,
  create_time timestamptz,
  update_time timestamptz,
  reply_comment text,
  reply_update_time timestamptz,
  reply_state text,
  policy_violation text,
  media jsonb,
  unread boolean,
  is_new boolean,
  has_draft boolean,
  operation text,
  bucket text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with base_rows as (
    select c.review_index_id, l.id as location_id, c.reviewer_name, c.reviewer_photo_url, c.is_anonymous, c.star_rating,
           c.comment, c.create_time, c.update_time, c.reply_comment, c.reply_update_time, c.reply_state, c.policy_violation,
           c.media, i.seen_at is null as unread,
           (l.initial_sync_done_at is not null and i.first_seen_at > l.initial_sync_done_at and i.seen_at is null) as is_new,
           d.review_index_id is not null and d.expires_at > now() as has_draft,
           public.gbp_reply_op_display(p_salon_id, l.location_name, i.review_key_hash,
                                       c.reply_comment is not null, c.reply_update_time) as operation
      from public.gbp_review_cache c
      join public.gbp_review_index i on i.id = c.review_index_id
      join public.gbp_locations l on l.id = i.location_id
      left join public.gbp_reply_drafts d on d.review_index_id = i.id
     where c.salon_id = p_salon_id and i.salon_id = p_salon_id and l.salon_id = p_salon_id
       and public.gbp_location_usable(p_salon_id, l.id)
       and i.deleted_on_google_at is null and c.expires_at > now()
  ), bucketed as (
    select r.*, public.gbp_reply_bucket(r.operation, r.reply_comment is not null, r.reply_state) as bucket
      from base_rows r
  )
  select b.review_index_id, b.location_id, b.reviewer_name, b.reviewer_photo_url, b.is_anonymous, b.star_rating, b.comment,
         b.create_time, b.update_time, b.reply_comment, b.reply_update_time, b.reply_state, b.policy_violation,
         b.media, b.unread, b.is_new, b.has_draft, b.operation, b.bucket
    from bucketed b
   where (p_filter = 'all' or (p_filter = 'new' and b.is_new) or (p_filter in ('unreplied', 'attention', 'replied') and b.bucket = p_filter))
     and (p_rating = 'all'
          or (p_rating = 'low' and b.star_rating <= 2)
          or (p_rating in ('3', '4', '5') and b.star_rating = p_rating::smallint))
   order by case when p_sort = 'lowest' then coalesce(b.star_rating, 6) end asc nulls first,
            b.create_time desc, b.review_index_id
   offset greatest(coalesce(p_offset, 0), 0)
   limit least(greatest(coalesce(p_limit, 20), 1), 100) + 1
$$;

-- 1件(その店舗のものだけ)。世代が使えないとき location_usable = false。一時保存が期限切れ・無いときは、内容の列が null。
drop function if exists public.gbp_get_review(uuid, uuid);
create function public.gbp_get_review(p_salon_id uuid, p_review_index_id uuid)
returns table (
  review_index_id uuid,
  location_id uuid,
  location_usable boolean,
  deleted_on_google boolean,
  cache_alive boolean,
  review_name text,
  reviewer_name text,
  reviewer_photo_url text,
  is_anonymous boolean,
  star_rating smallint,
  comment text,
  create_time timestamptz,
  update_time timestamptz,
  reply_comment text,
  reply_update_time timestamptz,
  reply_state text,
  policy_violation text,
  media jsonb,
  reply_url text,
  unread boolean,
  is_new boolean,
  draft_text text,
  draft_updated_at timestamptz,
  operation text,
  bucket text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with r as (
    select i.id, l.id as location_id, public.gbp_location_usable(p_salon_id, l.id) as usable,
           i.deleted_on_google_at is not null as deleted, c.review_index_id is not null as alive,
           c.review_name, c.reviewer_name, c.reviewer_photo_url, c.is_anonymous, c.star_rating, c.comment,
           c.create_time, c.update_time, c.reply_comment, c.reply_update_time, c.reply_state, c.policy_violation,
           c.media, c.reply_url, i.seen_at is null as unread,
           (l.initial_sync_done_at is not null and i.first_seen_at > l.initial_sync_done_at and i.seen_at is null) as is_new,
           d.draft_text, d.updated_at as draft_updated_at,
           public.gbp_reply_op_display(p_salon_id, l.location_name, i.review_key_hash,
                                       c.reply_comment is not null, c.reply_update_time) as operation
      from public.gbp_review_index i
      join public.gbp_locations l on l.id = i.location_id
      left join public.gbp_review_cache c on c.review_index_id = i.id and c.expires_at > now()
      left join public.gbp_reply_drafts d on d.review_index_id = i.id and d.expires_at > now()
     where i.id = p_review_index_id and i.salon_id = p_salon_id and l.salon_id = p_salon_id
  )
  select r.id, r.location_id, r.usable, r.deleted, r.alive, r.review_name, r.reviewer_name, r.reviewer_photo_url,
         r.is_anonymous, r.star_rating, r.comment, r.create_time, r.update_time, r.reply_comment, r.reply_update_time,
         r.reply_state, r.policy_violation, r.media, r.reply_url, r.unread, r.is_new, r.draft_text, r.draft_updated_at,
         r.operation, public.gbp_reply_bucket(r.operation, r.reply_comment is not null, r.reply_state)
    from r
$$;

-- 連携の同意を記録した店舗か。
create or replace function public.gbp_has_connect_consent(p_salon_id uuid, p_version text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (select 1 from public.gbp_consents c
                  where c.salon_id = p_salon_id and c.consent_type = 'connect' and c.version = p_version)
$$;

revoke all on function public.gbp_reviews_entitled(uuid) from public, anon, authenticated;
revoke all on function public.gbp_begin_reply_operation(uuid, uuid, uuid, text, text, integer, text, uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.gbp_reply_start_send(uuid, uuid, uuid, integer, jsonb, integer) from public, anon, authenticated;
revoke all on function public.gbp_finish_reply_operation(uuid, uuid, uuid, text, text, jsonb, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.gbp_reconcile_reply_operations(uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.gbp_dismiss_reply_operation(uuid, uuid) from public, anon, authenticated;
revoke all on function public.gbp_reply_op_display(uuid, text, text, boolean, timestamptz) from public, anon, authenticated;
revoke all on function public.gbp_reply_bucket(text, boolean, text) from public, anon, authenticated;
revoke all on function public.gbp_list_reviews(uuid, text, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.gbp_get_review(uuid, uuid) from public, anon, authenticated;
revoke all on function public.gbp_has_connect_consent(uuid, text) from public, anon, authenticated;
grant execute on function public.gbp_reviews_entitled(uuid) to service_role;
grant execute on function public.gbp_begin_reply_operation(uuid, uuid, uuid, text, text, integer, text, uuid, integer, integer) to service_role;
grant execute on function public.gbp_reply_start_send(uuid, uuid, uuid, integer, jsonb, integer) to service_role;
grant execute on function public.gbp_finish_reply_operation(uuid, uuid, uuid, text, text, jsonb, integer, timestamptz) to service_role;
grant execute on function public.gbp_reconcile_reply_operations(uuid, uuid, text, text, timestamptz) to service_role;
grant execute on function public.gbp_dismiss_reply_operation(uuid, uuid) to service_role;
grant execute on function public.gbp_reply_op_display(uuid, text, text, boolean, timestamptz) to service_role;
grant execute on function public.gbp_reply_bucket(text, boolean, text) to service_role;
grant execute on function public.gbp_list_reviews(uuid, text, text, text, integer, integer) to service_role;
grant execute on function public.gbp_get_review(uuid, uuid) to service_role;
grant execute on function public.gbp_has_connect_consent(uuid, text) to service_role;
