-- 0025 を適用したあとの確認(読み取りのみ)。0025-precheck.sql の結果と比べる。
-- 手順: docs/plans/salon-onboarding-runbook.md

-- 1. 列・既定値(新しい店舗の既定は 利用開始待ち・お客様による登録)
select column_name, column_default, is_nullable
  from information_schema.columns
 where table_schema = 'public' and table_name = 'salons'
   and column_name in ('service_status', 'registration_source', 'contact_name', 'contact_email', 'contact_phone')
 order by column_name;
-- 期待: service_status の既定 'pending'・NOT NULL / registration_source の既定 'self_signup'・NOT NULL / 連絡先は NULL 可

-- 2. 既存店舗の移行(件数が precheck の salons_to_migrate と同じ。すべて complimentary / existing)
select service_status, registration_source, count(*) from public.salons group by 1, 2 order by 1, 2;
select count(*) as migration_logs from public.operator_audit_log where actor_label = 'migration:0025' and target = 'service_status';

-- 3. 本人確認の記録(legacy の件数が precheck の legacy_accounts と同じ)
select method, count(*) from public.account_verifications group by 1 order by 1;

-- 4. 利用可否の集計・予約通知を送れる店舗の数・権限による停止(precheck と同じであること)
select a.feature_key, a.allowed, a.reason, count(*) as salons
  from public.salons s cross join lateral public.salon_feature_access_all(s.id) a
 group by 1, 2, 3 order by 1, 2, 3;
select count(*) as pollable_after from public.notifications_list_pollable_salons(null);
select salon_id, feature_key, opened_at from public.salon_feature_holds where released_at is null order by salon_id, feature_key;

-- 5. 表・関数・ポリシーがそろっていること
select to_regclass('public.account_verifications') is not null as verifications,
       to_regclass('public.account_verification_requirements') is not null as requirements,
       to_regclass('public.salon_drafts') is not null as drafts,
       to_regclass('public.salon_invitations') is not null as invitations,
       to_regclass('public.salon_invitation_attempts') is not null as attempts,
       to_regprocedure('public.current_session_trusted()') is not null as trusted_fn,
       to_regprocedure('public.create_own_salon(text, text, text, text, text, text)') is not null as create_own_salon,
       to_regprocedure('public.admin_register_salon(uuid, uuid, bigint, uuid, text, uuid)') is not null as register_fn,
       to_regprocedure('public.admin_list_salons(text, text, text, boolean, timestamptz, uuid, integer, text)') is not null as list_fn,
       to_regprocedure('public.admin_list_salons(text, text, text, boolean, timestamptz, uuid, integer)') is null as old_list_dropped;
select tablename, policyname, cmd, roles::text from pg_policies
 where schemaname = 'public' and tablename in ('salons', 'surveys', 'questions', 'question_options', 'salon_feature_overrides')
 order by 1, 2;
-- 期待: salons に owner_insert / owner_delete が無い。owner_select・owner_update は to authenticated で owner_salon_ids() を使う

-- 6. ブラウザのロール(anon / authenticated)が実行できる security definer の関数(許可したものだけ)
select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as authenticated
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace and p.prosecdef
   and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
   and pg_get_function_result(p.oid) <> 'trigger'
 order by 1;
-- 期待: create_own_salon・my_account_state・owner_active_salon_ids・owner_feature_salon_ids・owner_salon_ids(authenticated)、
--       salon_reviews_public_available(anon・authenticated)だけ
