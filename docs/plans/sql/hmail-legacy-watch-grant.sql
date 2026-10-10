-- 新側(SalonPack)の「旧側の監視」に必要な、最小限の読み取りの権限(本番の SQL Editor で、運営が実行する)。
--
-- 新側が service_role で旧側(hmail)を読むのは、public.reservation_ops_legacy_check(0022)の1か所だけで、
-- 読むのは hmail.mail_connections の salon_id・email_address・status の3列だけ(定期処理の店舗ごとの監視
-- (getLegacyState)・送信直前の確認(notifications_begin_send)・開始の確認がこの関数を使う)。
-- トークンなどのほかの列・ほかの表には権限を付けない。運用 CLI は postgres の接続で読むため、この権限は使わない。
-- RLS: Supabase の service_role は RLS を素通りする(BYPASSRLS)ため、ポリシーは追加しない(事前確認で確かめる)。
-- hmail の動作は変わらない(service_role への読み取りの権限を足すだけ。hmail の表・関数・データは変えない)。
-- この2文は scripts/testdb/cutover.test.ts が、テスト用DBの写しのスキーマに同じ内容で適用して検証している。
-- 取り消すとき: revoke select (salon_id, email_address, status) on hmail.mail_connections from service_role;
--             revoke usage on schema hmail from service_role;

grant usage on schema hmail to service_role;
grant select (salon_id, email_address, status) on hmail.mail_connections to service_role;
