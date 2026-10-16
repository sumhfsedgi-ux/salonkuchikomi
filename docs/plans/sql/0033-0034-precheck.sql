-- 0033・0034(口コミ 第2段階)を本番に適用する前の確認(読み取りのみ)。手順: docs/plans/reviews-alerts-stage2-plan.md §4
-- どれかが期待と違えば、適用しない(第1段階の 0027〜0032 が先に必要)。

-- 1. 第1段階の migration が適用済みであること
select to_regclass('public.review_reply_settings') is not null as m0027,
       to_regclass('public.gbp_review_index') is not null as m0028,
       to_regprocedure('public.gbp_has_connect_consent(uuid,text)') is not null as m0029,
       exists (select 1 from public.feature_catalog where feature_key = 'google_reviews') as m0030,
       (select p.prosecdef from pg_proc p where p.oid = 'public.gbp_binding_changed()'::regprocedure) as m0031,
       position('when p_feature_key = ''google_reviews'' then ''reviews''' in
                pg_get_functiondef('public.salon_feature_access(uuid,text)'::regprocedure)) > 0 as m0032;
-- 期待: すべて true

-- 2. 第2段階の表・関数がまだ無いこと
select to_regclass('public.review_alert_settings') as review_alert_settings,
       to_regclass('public.gbp_auto_sync') as gbp_auto_sync,
       to_regclass('public.gbp_push_messages') as gbp_push_messages,
       to_regprocedure('public.line_flow_topics(uuid,text)') as line_flow_topics;
-- 期待: すべて null

-- 3. 適用の前の値を控える(適用のあとの 0033-0034-verify.sql §5 と比べる)
select feature_key, lifecycle from public.feature_catalog order by feature_key;
select a.feature_key, a.allowed, a.reason, count(*) as salons
  from public.salons s cross join lateral public.salon_feature_access_all(s.id) a
 group by 1, 2, 3 order by 1, 2, 3;
select count(*) as pollable from public.notifications_list_pollable_salons(null);
select count(*) as review_index_rows from public.gbp_review_index;
select count(*) as line_connections, count(*) filter (where removed_at is null) as active from public.line_connections;
