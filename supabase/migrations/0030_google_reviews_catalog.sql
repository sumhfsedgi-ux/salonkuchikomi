-- 0030: 届いた口コミ(google_reviews)を、DB の機能カタログ(0024)に加える。
-- 計画: ~/.claude/plans(口コミの実装計画 第2版)§3-8・§6。
--
--   ・提供状態は coming_soon(準備中)。この migration だけでは、どの店舗も使えない
--     (salon_feature_access が lifecycle_coming_soon を返す。画面・操作・API・生成・投稿・同期は、この判定で止まる)。
--   ・口コミプラン・SalonPack プランの対象にするが、プランの標準では使えない(default_enabled = false)。
--     公開のときは、提供状態を available にしても、運営管理で店舗ごとに「利用を許可」した店舗だけが使える。
--   ・定期処理を持たない(has_runtime = false)。第1段階は利用者の操作だけで動く。期限の削除(0028)は利用可否に関係なく動く。
--   ・既存店舗の個別の設定(salon_feature_overrides)は作らない。
-- 行を足すと、0024 のトリガーで全店舗の基準行の版数が上がり、運営の変更履歴に1行ずつ残る(0024 の設計どおり)。
-- 何度実行しても同じ結果になる(on conflict do nothing。運営が変えた提供状態・標準は上書きしない)。

insert into public.feature_catalog (feature_key, lifecycle, has_runtime) values
  ('google_reviews', 'coming_soon', false)
on conflict (feature_key) do nothing;

insert into public.plan_feature_rules (plan, feature_key, default_enabled) values
  ('reviews', 'google_reviews', false),
  ('salonpack', 'google_reviews', false)
on conflict (plan, feature_key) do nothing;
