-- 予約LINE通知機能(Gmail監視 -> Hot Pepper Beautyメール判定 -> LINE通知)。
-- 別リポジトリ「hmail」(同一Supabaseプロジェクト、専用のhmail Postgresスキーマに隔離)
-- から機能を統合するにあたり、review-app独自の新しいテーブル群として作成する。
-- salon_idはhmail側の旧IDではなく、review-appの実際のsalons.idを指す
-- (1回限りの移行スクリプトでre-keyしてコピーする。まだ未実行)。
-- hmail側の"hmail"スキーマ自体はロールバックの安全網として一切変更しない。
--
-- 【2026-09-13設計変更】hmailは「1店舗1Gmail」に対して、スタッフの人数分だけ
-- 別々のhmail salon行(同じGmailアドレスを共有)を作ることで、スタッフごとに
-- 独立したLINE送信先とON/OFF設定を実現していた(テストデータではなく意図的な
-- 設計)。review-app側では「1店舗=1 salons行」を維持したまま、その下に複数の
-- LINE通知先(recipient)を持てる構造に変更する。イベント種別ごとのON/OFF
-- (new_reservation_enabled/cancellation_enabled)はline_connectionsの各行
-- (=各スタッフのLINE送信先)に持たせる。
--
-- 【2026-09-13追記】店舗全体のマスタースイッチ(hmailのmaster_enabled、
-- ダッシュボードの「予約通知 ● 通知中/停止中」表示に対応)は失えないため、
-- notification_settingsテーブルは廃止せず、salon_id毎にmaster_enabledだけを
-- 持つ小さなテーブルとして残す。master_enabled=falseの店舗は、配下の
-- line_connectionsの個別設定に関わらず全送信先への通知を止める上位スイッチ
-- として扱う(実装は各cronジョブ側で「まずmaster_enabledを見て、trueなら
-- 各line_connectionsのイベント種別トグルを見る」という二段構えにする)。

create table mail_connections (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null unique references salons (id) on delete cascade,
  provider text not null default 'gmail',
  email_address text not null,
  encrypted_refresh_token text not null,
  token_iv text not null,
  token_auth_tag text not null,
  scope text not null,
  status text not null default 'connected' check (status in ('connected', 'needs_reconnect')),
  consecutive_failure_count integer not null default 0,
  last_checked_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  -- 移行元のhmail salon idを控えておく監査用の列(FKではない、ただの記録)。
  -- 複数スタッフのうちどれを「代表のGmail接続」として採用したかを追跡できる。
  migrated_from_hmail_salon_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 1店舗につき複数行(=スタッフ人数分)を許容する、LINE通知の送信先。
-- hmailでは「スタッフ1人 = hmail salon 1行」だったものを、review-appでは
-- 「1店舗のsalons行の下にline_connectionsが複数行ぶら下がる」構造で表現する。
-- ON/OFF設定は店舗単位ではなく送信先(スタッフ)単位で持つ。
create table line_connections (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references salons (id) on delete cascade,
  destination_id text,
  label text,
  status text not null default 'not_connected' check (status in ('connected', 'not_connected')),
  new_reservation_enabled boolean not null default true,
  cancellation_enabled boolean not null default true,
  linked_at timestamptz,
  -- 移行元のhmail salon id(=このスタッフのhmail上の識別子)を控えておく
  -- 監査用の列。移行スクリプトはこのidをline_connections.id自体としても
  -- 再利用するため(notification_history.line_connection_idとの対応を
  -- 単純にするため)、実質idと同じ値になるが、明示的に見えるようにしておく。
  migrated_from_hmail_salon_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (salon_id, destination_id)
);

create index line_connections_salon_idx on line_connections (salon_id);

-- 店舗全体のマスタースイッチのみを持つ小さなテーブル(hmailのmaster_enabledに対応)。
-- イベント種別ごとのON/OFFはline_connections側(スタッフ単位)で持つため、
-- ここにはmaster_enabled以外のカラムを増やさない。
create table notification_settings (
  salon_id uuid primary key references salons (id) on delete cascade,
  master_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

-- 重複通知防止の要。claim-before-read方式(本文取得より先にこのテーブルへ
-- INSERT ... ON CONFLICT DO NOTHINGでクレームする)により、同時実行される
-- cronが同じメールを二重処理することを構造的に防ぐ。unique制約自体が
-- ロック機構を兼ねる。1通のメールにつき「店舗として1回」だけクレームし、
-- そこから複数のline_connections(スタッフ)へfan-outで送信する。
create table processed_emails (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references salons (id) on delete cascade,
  provider_message_id text not null,
  event_type text not null default 'pending'
    check (event_type in ('pending', 'new_reservation', 'change', 'cancellation', 'unknown', 'not_hotpepper')),
  processed_at timestamptz not null default now(),
  unique (salon_id, provider_message_id)
);

-- line_connection_idで「どの送信先(スタッフ)への通知/再送か」を判別する。
-- 送信先が削除された後も履歴自体は残すため on delete set null にする。
create table notification_history (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references salons (id) on delete cascade,
  line_connection_id uuid references line_connections (id) on delete set null,
  event_type text not null,
  provider_message_id text,
  line_text text,
  status text not null check (status in ('sent', 'failed', 'skipped_disabled', 'test')),
  attempts integer not null default 1,
  error_message text,
  sent_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 「最近の通知」表示用。
create index notification_history_salon_sent_at_idx on notification_history (salon_id, sent_at desc);
-- retrySweep(再送対象: status='failed'のみ、送信先ごとに再送する)用の絞り込みインデックス。
create index notification_history_retry_idx
  on notification_history (line_connection_id, sent_at)
  where status = 'failed';

-- salon_idを持たない、cron実行ごとのサマリー行(観測用途のみ)。
create table cron_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  salons_processed integer,
  salons_failed integer,
  notes text
);

-- retrySweepの「再送成功/失敗を記録しattemptsを+1する」を単一のUPDATE文で
-- 原子的に行う(Supabase JSクライアントにはattempts = attempts + 1のような
-- 生SQL式でのupdateが無いため、RPC化する)。
create or replace function notifications_mark_retry_outcome(
  p_id uuid,
  p_status text,
  p_error_message text
) returns void
language sql
as $$
  update notification_history
  set status = p_status,
      error_message = p_error_message,
      attempts = attempts + 1,
      updated_at = now()
  where id = p_id;
$$;

-- RLSは有効化するがポリシーは今回追加しない(service-roleキー経由のみ
-- アクセス可能)。lib/blog/adminのテーブル群と同じ方針で、将来の
-- RLSポリシー化は技術的負債として記録する。
alter table mail_connections enable row level security;
alter table line_connections enable row level security;
alter table notification_settings enable row level security;
alter table processed_emails enable row level security;
alter table notification_history enable row level security;
alter table cron_runs enable row level security;
