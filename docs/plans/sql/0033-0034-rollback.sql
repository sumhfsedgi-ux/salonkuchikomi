-- 0033・0034(口コミ 第2段階)を DB から外す(必要なときだけ。手順: docs/plans/reviews-alerts-stage2-plan.md §5)。
-- 先にアプリを第2段階より前のものに戻し、cron-job.org の口コミの定期処理を止め、GBP_PUBSUB_ENABLED を空にしてから実行する。
-- Google の通知設定(SalonPack のトピック)が残っている場合は、先にアプリから解除するか、Google 側で解除する。
-- 既存の表(第1段階・予約通知)の行は消さない。消えるのは第2段階の記録(通知の設定・通知先ごとの口コミ通知・配信の記録など)だけ。
begin;

-- トリガー → 関数 → 表 の順
drop trigger if exists review_alert_on_review_index on public.gbp_review_index;
drop trigger if exists review_alert_on_location_inactive on public.gbp_locations;
drop trigger if exists review_alert_on_entitlement on public.salon_entitlement_state;

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and (p.proname like 'review_alert_%' or p.proname like 'gbp_auto_%' or p.proname like 'gbp_push_%'
            or p.proname in ('gbp_notification_registration_set', 'gbp_notification_work', 'line_flow_topics'))
  loop
    execute format('drop function %s', r.sig);
  end loop;
end;
$$;

drop table if exists
  public.review_alert_deliveries,
  public.review_alert_events,
  public.review_alert_recipients,
  public.review_alert_settings,
  public.gbp_auto_runs,
  public.gbp_auto_auth_holds,
  public.gbp_auto_sync,
  public.gbp_push_messages,
  public.gbp_notification_registrations;

commit;
