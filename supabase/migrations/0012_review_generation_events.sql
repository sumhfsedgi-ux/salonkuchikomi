-- 口コミ生成のイベント記録とレート制限(docs/plans/reviews-465-plan.md §13)。
--
-- ai_generation_events:
--   品質評価・障害調査・コスト分析のためのメタデータだけを記録する。
--   お客様の回答の本文・生成した口コミの本文は保存しない(列も作らない)。
--   lint_flags / verify_flags は指摘コード(例: unsupported_satisfaction)だけで、文の内容は入れない。
--   unique(generation_id, kind) で、同じ生成の同じイベントは1件にする(再送しても増えない)。
--
-- rate_limit_buckets / rate_limit_hit():
--   固定の時間窓ごとの回数を数える。キーの IP 部分はアプリ側でハッシュにしてから渡す
--   (生の IP アドレスは保存しない)。1日の窓は UTC の 0 時(日本時間 9 時)で切り替わる。
--
-- どちらのテーブルも RLS を有効にしてポリシーを作らない(service role だけが読み書きする)。
-- 関数も service role だけが実行できるようにする(Supabase の既定では anon からも RPC で呼べるため)。
-- 既存のテーブル・hmail スキーマ・0009 の通知テーブルには触れない。

create table if not exists public.ai_generation_events (
  id bigint generated always as identity primary key,
  generation_id uuid not null,
  salon_id uuid not null references public.salons(id) on delete cascade,
  feature text not null default 'review_generation'
    check (feature in ('review_generation', 'reply_generation')),
  kind text not null
    check (kind in ('generated', 'regenerated', 'failed', 'shadow_verified', 'cta_clicked')),
  pipeline text check (pipeline in ('v1', 'v2')),
  prompt_version text check (char_length(prompt_version) <= 40),
  model text check (char_length(model) <= 100),
  verification_model text check (char_length(verification_model) <= 100),
  latency_ms integer check (latency_ms >= 0),
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  llm_calls smallint check (llm_calls >= 0),
  lint_flags text[] not null default '{}',
  verify_mode text check (verify_mode in ('none', 'sync', 'shadow')),
  verify_flags text[] not null default '{}',
  repair_action text
    check (repair_action in ('none', 'removed', 'regenerated', 'polished', 'repaired', 'own_words_fallback')),
  error_kind text check (char_length(error_kind) <= 40),
  created_at timestamptz not null default now(),
  unique (generation_id, kind)
);

create index if not exists ai_generation_events_salon_created_idx
  on public.ai_generation_events (salon_id, created_at desc);
create index if not exists ai_generation_events_created_idx
  on public.ai_generation_events (created_at desc);

alter table public.ai_generation_events enable row level security;
revoke all on table public.ai_generation_events from anon, authenticated;

create table if not exists public.rate_limit_buckets (
  bucket_key text not null check (char_length(bucket_key) between 1 and 200),
  window_start timestamptz not null,
  hit_count integer not null default 0,
  primary key (bucket_key, window_start)
);

alter table public.rate_limit_buckets enable row level security;
revoke all on table public.rate_limit_buckets from anon, authenticated;

-- 1回分を数え、上限以内なら true を返す。
create or replace function public.rate_limit_hit(p_key text, p_window_seconds integer, p_limit integer)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_window_start timestamptz;
  v_count integer;
begin
  if p_key is null or char_length(p_key) not between 1 and 200 then
    raise exception 'rate_limit_hit: invalid key' using errcode = '22023';
  end if;
  if p_window_seconds is null or p_window_seconds <= 0 or p_limit is null or p_limit <= 0 then
    raise exception 'rate_limit_hit: invalid window or limit' using errcode = '22023';
  end if;

  v_window_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into public.rate_limit_buckets as b (bucket_key, window_start, hit_count)
  values (p_key, v_window_start, 1)
  on conflict (bucket_key, window_start) do update set hit_count = b.hit_count + 1
  returning b.hit_count into v_count;

  -- 古い窓(2日より前)を、ときどき消す。テーブルが増え続けないように。
  if random() < 0.01 then
    delete from public.rate_limit_buckets where window_start < now() - interval '2 days';
  end if;

  return v_count <= p_limit;
end;
$$;

revoke all on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;
