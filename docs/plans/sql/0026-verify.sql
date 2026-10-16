-- 0026 を適用したあとの確認(読み取りのみ)。適用の前に、4 と 5 の結果を控えておき、適用のあとと比べる。
-- 手順: docs/plans/salon-onboarding-runbook.md

-- 1. 列・制約(既存の行は plan_placeholder = false。仮の値のまま利用中の店舗は無い)
select column_name, column_default, is_nullable
  from information_schema.columns
 where table_schema = 'public' and table_name = 'salons' and column_name in ('plan', 'plan_placeholder')
 order by column_name;
-- 期待: plan_placeholder の既定 false・NOT NULL
select conname, pg_get_constraintdef(oid) from pg_constraint
 where conrelid = 'public.salons'::regclass and conname = 'salons_plan_placeholder_check';
select count(*) as placeholder_in_use from public.salons where plan_placeholder and service_status <> 'pending';
-- 期待: 0

-- 2. 区分・登録経路・仮の値の件数(本番では existing / complimentary だけで、plan_placeholder はすべて false)
select service_status, registration_source, plan_placeholder, count(*) from public.salons group by 1, 2, 3 order by 1, 2, 3;

-- 3. 新規登録の受付(初期値は閉じる)
select id, open, updated_at from public.self_signup_settings;
-- 期待: 1行、open = false(本番)

-- 4. 利用可否の集計・予約通知を送れる店舗の数・権限による停止(適用の前と同じであること)
select a.feature_key, a.allowed, a.reason, count(*) as salons
  from public.salons s cross join lateral public.salon_feature_access_all(s.id) a
 group by 1, 2, 3 order by 1, 2, 3;
select count(*) as pollable from public.notifications_list_pollable_salons(null);
select salon_id, feature_key, opened_at from public.salon_feature_holds where released_at is null order by salon_id, feature_key;

-- 5. 既存の無料提供の店舗(適用の前と同じプラン・区分であること)
select s.id, s.plan, s.service_status, s.plan_placeholder from public.salons s
 where s.registration_source = 'existing' order by s.created_at, s.id;

-- 6. 表・関数がそろっていること
select to_regclass('public.auth_email_cooldowns') is not null as cooldowns,
       to_regclass('public.self_signup_settings') is not null as signup_settings,
       to_regprocedure('public.auth_email_cooldown_take(text, integer)') is not null as cooldown_fn,
       to_regprocedure('public.create_own_salon(text, text, text, text, text, text)') is not null as create_own_salon,
       to_regprocedure('public.admin_list_salons(text, text, text, boolean, timestamptz, uuid, integer, text)') is not null as list_fn;

-- 7. 権限(anon・authenticated から使えないこと。create_own_salon だけは authenticated が実行できる)
select p.oid::regprocedure as fn,
       has_function_privilege('anon', p.oid, 'execute') as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('auth_email_cooldown_take', 'create_own_salon', 'admin_register_salon', 'admin_update_salon_service_status',
                     'admin_list_salons', 'salon_draft_invalid_field')
 order by 1;
-- 期待: すべて anon = false。authenticated = true は create_own_salon だけ
select c.relname,
       has_table_privilege('anon', c.oid, 'select') as anon_select,
       has_table_privilege('authenticated', c.oid, 'select') as auth_select,
       c.relrowsecurity as rls
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname in ('auth_email_cooldowns', 'self_signup_settings');
-- 期待: anon_select = false・auth_select = false・rls = true
