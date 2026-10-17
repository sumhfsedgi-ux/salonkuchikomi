-- 0033: 口コミ作成中の表示(お客様ページで、口コミの文章を作っている間に出す店舗の写真とキャッチコピー)。
--
-- review_generation_showcases:
--   店舗ごとに1行。表示の有効・無効、キャッチコピー、写真の保存先(Storage の review-showcase バケットのパス)を持つ。
--   行が無い店舗は「未設定・無効」として扱う(既存の店舗は行が無い状態から始まる)。
--   有効にできるのは、写真とキャッチコピーの両方があるときだけ(check で保証する)。
--   写真のパスは「<salon_id>/<uuid>.<拡張子>」に限り、先頭はその行の salon_id と一致させる(他店舗の写真を指せない)。
--   RLS を有効にしてポリシーを作らない(service role だけが読み書きする。0012・0027 と同じ方針)。
--   管理画面の Server Action は、利用可否の判定を通った店舗の salon_id だけを使う。
--
-- review_showcase_public:
--   お客様ページ(anon)が読む公開用のビュー。返すのは salon_id・キャッチコピー・写真のパスだけで、
--   有効で、写真とキャッチコピーがあり、口コミを使える店舗(salon_public.reviews_available と同じ判定)の行に限る。
--   select だけを許可する(ビューを通した書き込みはさせない)。
--
-- Storage バケット review-showcase:
--   公開読み取り(public)、1ファイル 1MB まで、JPEG / PNG / WebP だけ。アップロード・削除は service role だけが行う
--   (storage.objects にポリシーを作らない)。storage スキーマの無い DB(手元の検証用の PostgreSQL)では作らない。
--
-- ai_generation_events.kind:
--   お客様ページの「口コミをコピーして進む」(review_copied)と「Googleの投稿画面を開く」(google_opened)を
--   分けて記録できるようにする。cta_clicked(コピーと Google を同時に開いていた旧画面)は過去の記録用に残す。
--
-- 既存のテーブル・関数(0001〜0032)の中身には触れない。何度実行しても同じ結果になる。

create table if not exists public.review_generation_showcases (
  salon_id uuid primary key references public.salons(id) on delete cascade,
  enabled boolean not null default false,
  catch_copy text not null default ''
    check (char_length(catch_copy) <= 30 and catch_copy !~ '[\r\n]'),
  image_path text
    check (
      image_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$'
      and split_part(image_path, '/', 1) = salon_id::text
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint review_generation_showcases_enabled_complete
    check (not enabled or (image_path is not null and catch_copy <> ''))
);

alter table public.review_generation_showcases enable row level security;

-- anon / authenticated からは直接読み書きさせない(Supabase の既定の権限を外す。0012・0027 と同じ)。
revoke all on table public.review_generation_showcases from anon, authenticated;

create or replace view public.review_showcase_public
with (security_invoker = false) as
select s.salon_id, s.catch_copy, s.image_path
from public.review_generation_showcases s
where s.enabled
  and s.image_path is not null
  and s.catch_copy <> ''
  and public.salon_reviews_public_available(s.salon_id);

revoke all on public.review_showcase_public from public, anon, authenticated;
grant select on public.review_showcase_public to anon, authenticated, service_role;

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('review-showcase', 'review-showcase', true, 1048576, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update
      set public = excluded.public,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;
  end if;
end
$$;

alter table public.ai_generation_events drop constraint if exists ai_generation_events_kind_check;
alter table public.ai_generation_events add constraint ai_generation_events_kind_check
  check (kind in ('generated', 'regenerated', 'failed', 'shadow_verified', 'cta_clicked', 'review_copied', 'google_opened'));
