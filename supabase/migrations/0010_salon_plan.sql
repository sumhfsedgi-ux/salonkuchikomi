-- 店舗の契約プラン。「口コミ365(reviews)」単体版と「SalonPack(salonpack)」
-- フル版を、同一コードベース・同一Supabaseプロジェクトから出し分けるための列。
--
-- 重要: デフォルトは'reviews'にする。Vercel URL(APP_MODE)は契約情報ではない
-- ため、SalonPack側のURLを知っているだけの新規ユーザーが登録した結果、
-- 自動的に有料機能(ブログ・予約通知)を使えてしまう事態を防ぐ。列追加の
-- 時点では既存salonも含めて全行が'reviews'になる。実際に現在SalonPack機能を
-- 使っている店舗への'salonpack'への更新は、このmigrationとは別に、対象を
-- 一覧で確認したうえで個別のUPDATE文として実行する(一括自動化はしない)。
alter table salons
  add column plan text not null default 'reviews' check (plan in ('reviews', 'salonpack'));
