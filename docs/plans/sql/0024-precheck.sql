-- 0024(運営管理・利用権限)を本番に適用する前の確認(読み取りのみ。SQL Editor で実行する)。
-- 結果を記録してから適用する。書き込みはしない。

-- 1. 未適用であること(0 行なら未適用)
select table_name from information_schema.tables
 where table_schema = 'public' and table_name in ('feature_catalog', 'salon_feature_overrides', 'operator_admins');

-- 2. 契約ごとの店舗数(適用後も同じ利用可否になることの確認用)
select plan, count(*) from public.salons group by plan order by plan;

-- 3. 今の契約では予約通知を使えないのに、運用状態が開始前ではない店舗(以前 salonpack から外した店舗など)。
--    0024 はこれらに「権限による停止」を記録する(今も送っていないので稼働は変わらない。salonpack に戻しても
--    自動では再開せず、運営が管理画面で解除する)。0 件が想定。1 件以上なら、店舗ごとに扱いを確認してから適用する。
select o.salon_id, s.name, s.plan, o.state, o.activated_at
  from public.reservation_notification_operations o join public.salons s on s.id = o.salon_id
 where o.state <> 'setup_pending' and s.plan <> 'salonpack';

-- 4. 開いたままの停止期間 contract(0022 の方式。0024 以降は開閉しない)。0 件が想定。
select salon_id, started_at, note from public.reservation_stop_intervals where kind = 'contract' and ended_at is null;

-- 5. 予約通知を送れる状態の店舗数(適用の前後で同じであること。適用後にもう一度実行して比べる)
select count(*) as pollable_before from public.notifications_list_pollable_salons(array['salonpack']);
