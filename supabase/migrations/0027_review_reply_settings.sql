-- 0027: AI返信の設定(届いた口コミの返信案の作り方)。
-- 旧 feature/reviews-d1-reply-engine の 0013 と同じ内容(番号だけ変えた。0013〜0017 の番号は使わない)。
--
-- review_reply_settings:
--   店舗ごとに1行。返信のトーン・長さ・店舗名・再来店の一言・署名・低評価のときの連絡先の案内・
--   追加の指示を持つ。行が無い店舗はアプリ側の既定値を使う。
--   口コミの本文・AIの返信案は保存しない(列も作らない)。
--
-- RLS を有効にしてポリシーを作らない(service role だけが読み書きする。0012 と同じ方針)。
-- 画面・Server Action は、利用可否の判定を通った店舗の salon_id だけを使う。
-- 既存のテーブル・関数(0001〜0026)には触れない。何度実行しても同じ結果になる(if not exists)。

create table if not exists public.review_reply_settings (
  salon_id uuid primary key references public.salons(id) on delete cascade,
  tone text not null default 'soft'
    check (tone in ('polite', 'soft', 'friendly')),
  length text not null default 'normal'
    check (length in ('short', 'normal', 'long')),
  include_store_name boolean not null default false,
  revisit_line text not null default 'natural'
    check (revisit_line in ('natural', 'none')),
  signature text not null default ''
    check (char_length(signature) <= 30),
  contact_note text not null default ''
    check (char_length(contact_note) <= 80),
  extra_instructions text not null default ''
    check (char_length(extra_instructions) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.review_reply_settings enable row level security;

-- anon / authenticated からは直接読み書きさせない(Supabase の既定の権限を外す。0012 と同じ)。
revoke all on table public.review_reply_settings from anon, authenticated;
