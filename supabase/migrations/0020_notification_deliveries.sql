-- 予約通知の配信を「メール単位」から「メール×送信先単位」の排他的な処理権へ
-- 拡張する(docs/plans/lavi-notification-cutover-plan.md参照)。
--
-- 【背景・直した不具合】
-- 0009のprocessed_emailsは「このメールをこの店舗向けに処理し始めたか」だけを
-- 原子的にクレームする。fan-out送信(1通のメール→複数のLINE送信先)の完了状態は
-- どこにも記録されないため、送信途中(例: 3人中1人送信後)でプロセスが終了すると、
-- 未送信のままのスタッフへは二度と配信されない(processed_emailsのクレームは
-- 既に成立しているため、再試行の対象にもならず、エラーも残らない)。
-- また既存のretrySweepはnotification_historyの'failed'行を排他制御なしに読んで
-- 再送するため、2つのcron実行が重なると同じ失敗を同時に再送できてしまう。
--
-- 【設計】
-- このmigrationは0009のテーブル定義・データを一切変更しない(0009は書き換え禁止)。
-- 新しいnotification_deliveriesテーブルを追加し、「メール×送信先」のペアごとに
-- 永続的な配信状態と排他的な処理権(リース)を持たせる。「初回送信」と「再送」を
-- 同じ原子的クレーム関数(notifications_claim_delivery)に統一することで、
-- 複数cronの同時実行があっても同じ配信行を二重に処理できない構造にする。
--
-- statusの意味:
--   pending  まだ一度も試みていない
--   claimed  いずれかのワーカーが処理中(claimed_atがリース、期限切れなら再クレーム可)
--   sent     LINEに確実に届いた(200、またはretry-keyが既に成功済みだった409)
--   failed   確定的な失敗(LINEが4xx[409を除く]を返した。再試行しない)
--   unknown  5xx・タイムアウト等で結果が確認できない(LINE公式のretry-key方式で
--            安全に再試行可能。created_atから24時間以内のみ自動再試行の対象)
--
-- line_retry_keyはLINE公式のX-Line-Retry-Keyに使う値で、1配信につき生成は
-- claim時の初回だけ(既定値gen_random_uuid())。以後の再試行は必ず同じ値を使い回す
-- (developers.line.biz/en/docs/messaging-api/retrying-api-request/: 同じ鍵での
-- 再試行は、既に成功していれば409+x-line-accepted-request-id、未確定なら
-- 実際に送信を試みて200を返す。鍵は発行から24時間だけ有効)。

create table if not exists notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references salons (id) on delete cascade,
  provider_message_id text not null,
  line_connection_id uuid not null references line_connections (id) on delete cascade,
  event_type text not null,
  line_text text not null,
  line_retry_key uuid not null default gen_random_uuid(),
  status text not null default 'pending' check (status in ('pending', 'claimed', 'sent', 'failed', 'unknown')),
  claimed_at timestamptz,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 同じメール・同じ送信先への配信行は1つだけ。fan-out時のinsertを
  -- `on conflict (provider_message_id, line_connection_id) do nothing` にすることで、
  -- 「配信行を作る」ステップ自体を何度再実行しても安全(冪等)にする土台。
  unique (provider_message_id, line_connection_id)
);

create index if not exists notification_deliveries_pending_idx
  on notification_deliveries (salon_id, created_at)
  where status in ('pending', 'claimed', 'unknown');

comment on table notification_deliveries is
  'メール×LINE送信先ごとの配信状態。processed_emails(0009)は「メールを処理し始めたか」のみを表し、fan-out配信の完了は表さない -- このテーブルが配信そのものの永続状態と排他処理権を持つ。';

-- 配信権利を原子的にクレームする(1件、無ければ空)。
--   - pending: 未着手なら無条件でクレーム対象
--   - unknown: created_atから24時間以内(LINEのretry-key有効期間)のみ自動再試行の対象。
--     それを過ぎたものはここでは拾わない(安全に再試行できる保証が無いため、
--     運用側の確認対象として残す -- notifications_stale_unknown_deliveries参照)。
--   - claimed: リース(p_lease、既定2分)が切れていれば、クラッシュ復帰のため再クレーム対象にする。
-- for update skip locked で、同時に動く複数ワーカーが同じ行を取り合わないようにする。
create or replace function notifications_claim_delivery(
  p_salon_id uuid,
  p_lease interval default interval '2 minutes',
  p_retry_key_window interval default interval '24 hours'
) returns setof notification_deliveries
language sql
as $$
  update notification_deliveries
  set status = 'claimed',
      claimed_at = now(),
      attempts = attempts + 1,
      updated_at = now()
  where id = (
    select id from notification_deliveries
    where salon_id = p_salon_id
      and (
        status = 'pending'
        or (status = 'unknown' and created_at > now() - p_retry_key_window)
        or (status = 'claimed' and claimed_at < now() - p_lease)
      )
    order by created_at
    limit 1
    for update skip locked
  )
  returning *;
$$;

-- クレームした配信の結果を記録する。claimed_atはクリアする(リース解放)。
create or replace function notifications_mark_delivery_outcome(
  p_id uuid,
  p_status text,
  p_error text default null
) returns void
language sql
as $$
  update notification_deliveries
  set status = p_status,
      claimed_at = null,
      last_error = p_error,
      updated_at = now()
  where id = p_id;
$$;

-- 運用確認用: retry-keyの24時間有効期間を過ぎてもunknownのまま残っている配信
-- (自動再試行の対象から外れているもの)。cron側では扱わず、人の確認に委ねる。
create or replace function notifications_stale_unknown_deliveries(
  p_retry_key_window interval default interval '24 hours'
) returns setof notification_deliveries
language sql
stable
as $$
  select * from notification_deliveries
  where status = 'unknown' and created_at <= now() - p_retry_key_window
  order by created_at;
$$;

alter table notification_deliveries enable row level security;

-- 【移行の一時停止ゲート】mail_connectionsのstatusに'migrating'を追加する。
-- bridgeルート(hmail、Preview専用、mainへ未マージ)が接続行を新規に書き込む際、
-- 'connected'ではなく'migrating'にすることで、「接続行をコピーしただけでは
-- cronの処理対象にならない」状態を作る(listActiveMailConnectionsの
-- status in ('connected','needs_reconnect')フィルタに自然と含まれないため、
-- アプリ側のクエリ自体は無変更で済む)。通知のON/OFF(notification_settings.
-- master_enabled)とは別軸の、運用者だけが操作する切替ゲートとして扱う。
-- 'connected'への切替(=本番有効化)は、カットオーバー手順の中で明示的なUPDATE
-- として行う(本migrationはゲートの値を追加するだけで、どの店舗も切り替えない)。
alter table mail_connections drop constraint if exists mail_connections_status_check;
alter table mail_connections add constraint mail_connections_status_check
  check (status in ('connected', 'needs_reconnect', 'migrating'));

comment on column mail_connections.status is
  'connected/needs_reconnect: 通常運用時の接続健全性。migrating: 移行中でcronの対象外にする運用者専用ゲート(通知ON/OFFとは別軸、notifications_claim_deliveryやlistActiveMailConnectionsの対象から自然に外れる)。';

-- 【段階1(分類)のクラッシュ復帰】claimMessageForProcessing後、本文取得(Gmail API)
-- やパースが一時的に失敗すると、processed_emailsの行はevent_type='pending'の
-- ままクレーム成立済みで残り、再度のGmail一覧取得でも同じprovider_message_idは
-- 既にクレーム済みのため二度と候補に上らない -- 分類が完了しなかったメールの
-- 通知が永久に失われる。stale(一定時間pendingのまま放置された)行を安全に
-- 再クレームできるようにする(notification_deliveriesと同じ for update skip locked
-- のリース方式)。
create or replace function notifications_reclaim_stuck_email(
  p_salon_id uuid,
  p_stale_after interval default interval '5 minutes'
) returns setof processed_emails
language sql
as $$
  update processed_emails
  set processed_at = now()
  where id = (
    select id from processed_emails
    where salon_id = p_salon_id
      and event_type = 'pending'
      and processed_at < now() - p_stale_after
    order by processed_at
    limit 1
    for update skip locked
  )
  returning *;
$$;

comment on function notifications_reclaim_stuck_email is
  'Gmail本文取得・パース等の一時的な失敗でevent_type=pendingのまま止まったprocessed_emails行を、一定時間後に再クレームする。claim-before-readの原則は保ったまま、分類未完了メールの通知消失を防ぐ。';

-- notification_history.statusに'unknown'を追加する。配信結果が確認できず
-- retry-keyで再試行待ちの状態を、確定失敗('failed')と区別して表示できるようにする
-- (オーナー向けの「最近の通知」一覧が実態と合うようにするため)。
alter table notification_history drop constraint if exists notification_history_status_check;
alter table notification_history add constraint notification_history_status_check
  check (status in ('sent', 'failed', 'skipped_disabled', 'test', 'unknown'));
