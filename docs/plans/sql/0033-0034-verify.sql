-- 0033・0034(口コミ 第2段階)を適用したあとの確認(読み取りのみ)。手順: docs/plans/reviews-alerts-stage2-plan.md §4

-- 1. 表がそろっていて、空であること
select 'review_alert_settings' as t, count(*) from public.review_alert_settings
union all select 'review_alert_recipients', count(*) from public.review_alert_recipients
union all select 'review_alert_events', count(*) from public.review_alert_events
union all select 'review_alert_deliveries', count(*) from public.review_alert_deliveries
union all select 'gbp_auto_sync', count(*) from public.gbp_auto_sync
union all select 'gbp_auto_auth_holds', count(*) from public.gbp_auto_auth_holds
union all select 'gbp_auto_runs', count(*) from public.gbp_auto_runs
union all select 'gbp_push_messages', count(*) from public.gbp_push_messages
union all select 'gbp_notification_registrations', count(*) from public.gbp_notification_registrations;
-- 期待: 9行、すべて 0

-- 2. RLS が有効で、ブラウザのロールから読めないこと
select c.relname, c.relrowsecurity,
       has_table_privilege('anon', c.oid, 'select') as anon_select,
       has_table_privilege('authenticated', c.oid, 'select') as authenticated_select
  from pg_class c
 where c.relnamespace = 'public'::regnamespace
   and c.relname in ('review_alert_settings', 'review_alert_recipients', 'review_alert_events', 'review_alert_deliveries',
                     'gbp_auto_sync', 'gbp_auto_auth_holds', 'gbp_auto_runs', 'gbp_push_messages', 'gbp_notification_registrations')
 order by 1;
-- 期待: relrowsecurity = true、anon_select・authenticated_select = false

-- 3. 関数は service role だけが実行できること
select p.proname,
       has_function_privilege('anon', p.oid, 'execute') as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
       has_function_privilege('service_role', p.oid, 'execute') as service
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and (p.proname like 'review_alert_%' or p.proname like 'gbp_auto_%' or p.proname like 'gbp_push_%'
        or p.proname like 'gbp_notification_%' or p.proname = 'line_flow_topics')
 order by 1;
-- 期待: anon・authenticated = false。service = true(トリガーの関数 review_alert_on_* は service も false でよい)

-- 4. トリガー
select tgname, tgrelid::regclass, tgenabled from pg_trigger
 where tgname in ('review_alert_on_review_index', 'review_alert_on_location_inactive', 'review_alert_on_entitlement')
 order by 1;
-- 期待: 3行(gbp_review_index・gbp_locations・salon_entitlement_state)、tgenabled = O

-- 5. 既存の値が変わっていないこと(0033-0034-precheck.sql §3 と同じ)
select feature_key, lifecycle from public.feature_catalog order by feature_key;
select a.feature_key, a.allowed, a.reason, count(*) as salons
  from public.salons s cross join lateral public.salon_feature_access_all(s.id) a
 group by 1, 2, 3 order by 1, 2, 3;
select count(*) as pollable from public.notifications_list_pollable_salons(null);
select count(*) as review_index_rows from public.gbp_review_index;
select count(*) as line_connections, count(*) filter (where removed_at is null) as active from public.line_connections;
