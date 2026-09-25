import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// 予約通知機能のDBアクセス専用モジュール。service-role keyでサーバーからのみ
// アクセスする(lib/blog/admin.tsと同じパターン)。
//
// 重要(セキュリティ):
// ・この関数はServer Component / Server Action / Route Handlerからのみ呼び出すこと。
//   "use client" が付いたファイルからは絶対にimportしない。
// ・salon_idはこのモジュールの外側(呼び出し元)で解決すること。
//   ダッシュボード側は`lib/supabase/queries.ts`の`getCurrentSalon(supabase)`、
//   cron側は各接続テーブル自身が持つsalon_id(移行時にreview-appの実IDへ
//   re-key済み)を使う。リクエストボディ・クエリパラメータ・クライアントの
//   状態から受け取ったsalon_idをこのクライアントの引数に使ってはならない。
// ・mail_connections / line_connections / notification_settings /
//   processed_emails / notification_history / cron_runs の6テーブルは
//   RLSが有効だがポリシーが無い状態(service-roleキー以外からはアクセス
//   不可)。ブログ機能のテーブルと同じ方針で、将来的なRLSポリシー化は
//   技術的負債として記録する(今回のスコープでは行わない)。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySupabaseClient = SupabaseClient<any, any, any>;

let cachedClient: AnySupabaseClient | null = null;

export function getNotificationsSupabaseAdmin(): AnySupabaseClient {
  if (cachedClient) return cachedClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が設定されていません。.env.local を確認してください。"
    );
  }

  cachedClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedClient;
}
