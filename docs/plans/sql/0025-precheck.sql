-- 0025(新規登録・運営によるサロン登録と招待・利用区分・本人確認とセッション)を本番に適用する前の確認。
-- 読み取りのみ(SQL Editor で実行する)。書き込みはしない。結果を控えてから適用する(0025-verify.sql で同じ値と比べる)。
-- 手順: docs/plans/salon-onboarding-runbook.md

-- 1. 前提: 0024 が適用済み(1 が true)・0025 が未適用(2 と 3 が false)
select to_regclass('public.feature_catalog') is not null as has_0024,
       exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'salons' and column_name = 'service_status') as has_0025_column,
       to_regclass('public.account_verifications') is not null as has_0025_table;

-- 2. 移行の対象の店舗(この時点で存在する店舗は、すべて「無料提供」・登録経路「既存」になる)。一覧と件数を控える。
select s.id, s.name, s.plan, s.created_at, u.email as owner_email
  from public.salons s
  join public.profiles p on p.id = s.owner_id
  left join auth.users u on u.id = p.user_id
 order by s.created_at, s.id;
select count(*) as salons_to_migrate from public.salons;

-- 3. 利用可否の集計(適用の前後で同じであること。0025 は既存店舗の利用可否を変えない)
select a.feature_key, a.allowed, a.reason, count(*) as salons
  from public.salons s cross join lateral public.salon_feature_access_all(s.id) a
 group by 1, 2, 3 order by 1, 2, 3;

-- 4. 予約通知を送れる店舗の数・開いている権限による停止(適用の前後で同じであること)
select count(*) as pollable_before from public.notifications_list_pollable_salons(null);
select salon_id, feature_key, opened_at from public.salon_feature_holds where released_at is null order by salon_id, feature_key;

-- 5. 本人確認の記録(legacy)を付ける予定のアカウント: メールが確認済み、または店舗の所有者。件数を控える。
select count(*) as legacy_accounts
  from auth.users u
 where u.email_confirmed_at is not null
    or exists (select 1 from public.profiles p join public.salons s on s.owner_id = p.id where p.user_id = u.id);
-- legacy にならないアカウント(メール未確認で、店舗も持たない)。このアカウントは、0025 のあとメールのリンクで本人確認が必要になる。
select u.id, u.email, u.created_at, u.last_sign_in_at
  from auth.users u
 where u.email_confirmed_at is null
   and not exists (select 1 from public.profiles p join public.salons s on s.owner_id = p.id where p.user_id = u.id)
 order by u.created_at;

-- 6. メールが未確認なのに、店舗・ログイン・セッションがあるアカウント(Confirm email が ON だとログインできない状態)。0 件が想定。
select u.id, u.email, u.last_sign_in_at,
       exists (select 1 from public.profiles p join public.salons s on s.owner_id = p.id where p.user_id = u.id) as owns_salon,
       (select count(*) from auth.sessions se where se.user_id = u.id) as sessions
  from auth.users u
 where u.email_confirmed_at is null
   and (u.last_sign_in_at is not null
        or exists (select 1 from auth.sessions se where se.user_id = u.id)
        or exists (select 1 from public.profiles p join public.salons s on s.owner_id = p.id where p.user_id = u.id));

-- 7. 店舗を持たないアカウント(0025 のあと、このアカウントが自分で店舗を作ると「利用開始待ち」になる)。
--    運営が登録する予定のお客様なら、0025 のあとに /ops の「サロンを追加」で紐付ける(確認済みのアカウントは、
--    本人確認の記録(legacy)があれば、パスワードを変えずに紐付けられる)。
select u.id, u.email, u.email_confirmed_at is not null as confirmed, u.created_at,
       exists (select 1 from public.operator_admins a where a.user_id = u.id and a.revoked_at is null) as is_operator
  from auth.users u
 where not exists (select 1 from public.profiles p join public.salons s on s.owner_id = p.id where p.user_id = u.id)
 order by u.created_at;

-- 8. 店舗を持つ運営の管理者・複数の店舗を持つ所有者(0 件が想定。0025 のあとは、どちらも新しくは作れない)
select a.user_id from public.operator_admins a
  join public.profiles p on p.user_id = a.user_id join public.salons s on s.owner_id = p.id
 where a.revoked_at is null;
select p.user_id, count(*) from public.salons s join public.profiles p on p.id = s.owner_id group by 1 having count(*) > 1;

-- 9. セッションの数(0025 のあと、オーナーの RLS は auth.sessions に行のあるセッションだけを信頼する。目安として控える)
select count(*) as sessions, count(distinct user_id) as users_with_sessions from auth.sessions;

-- 10. migration の番号の記録(Supabase CLI の `supabase db push` を本番に使ったことがあるか)。
--     これまでの本番は SQL Editor でファイルごとに適用しており、番号は DB に残らない想定(1 が false)。
--     true のときは、記録されている番号(2)を控える。0025 を別の番号に変える・ほかの作業の migration と順番を入れ替えるときは、
--     この記録と食い違わないようにする(SQL Editor で適用したものは記録されない)。
select to_regclass('supabase_migrations.schema_migrations') is not null as has_cli_history;
-- (1 が true のときだけ実行する)
-- select version, name from supabase_migrations.schema_migrations order by version;
