-- 0025 のあとに、アプリを 0025 より前の版に戻す必要が出たときの補助。
-- すべて読み取りのみ。
-- 0025 そのものを戻す SQL は用意しない(0024 の判定に戻すと、利用開始待ちの店舗が使えるようになるため)。
-- 判断の手順: docs/plans/salon-onboarding-runbook.md の「切り戻しの条件」

-- 1. 新しい方式のデータが無いか(すべて 0 なら、アプリだけを戻せる条件の1つを満たす)
select
  (select count(*) from public.salon_drafts) as drafts,
  (select count(*) from public.salons where registration_source <> 'existing') as new_salons,
  (select count(*) from public.account_verifications where method <> 'legacy') as new_verifications,
  (select count(*) from public.account_verification_requirements) as requirements,
  (select count(*) from public.salon_invitations) as invitations,
  (select count(*) from public.salons where service_status = 'pending') as pending_salons;

-- 2. 新しい方式で作られた店舗とアカウント(戻す前に、店舗ごとの対応を決めるための一覧)
select s.id, s.name, s.registration_source, s.service_status, s.created_at, u.email as owner_email,
       u.email_confirmed_at is not null as email_confirmed,
       exists (select 1 from public.account_verifications v where v.user_id = u.id) as verified
  from public.salons s
  join public.profiles p on p.id = s.owner_id
  left join auth.users u on u.id = p.user_id
 where s.registration_source <> 'existing' or s.service_status = 'pending'
 order by s.created_at;

-- 3. 本人確認の済んでいないアカウント(旧アプリでは、理由の表示なしに店舗の画面が空になる)
select u.id, u.email, u.created_at, r.mode, r.reason
  from auth.users u
  left join public.account_verification_requirements r on r.user_id = u.id
 where not exists (select 1 from public.account_verifications v where v.user_id = u.id)
 order by u.created_at;

-- 4. ポリシーを戻す SQL は用意しない。0025 の書き込みの制限(salons_client_write_guard)が、ブラウザからの店舗の作成を
--    拒否するため、owner_insert を戻しても旧アプリで店舗を作ることはできない(旧アプリに戻した期間は、新しい店舗の登録を止める)。
--    旧アプリは店舗の削除を使っていないため、owner_delete も戻さない。
