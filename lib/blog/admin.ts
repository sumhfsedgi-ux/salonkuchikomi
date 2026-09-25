import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ブログ機能のDBアクセス専用モジュール。service-role keyでサーバーからのみ
// アクセスする（ユーザーの認証済みセッション用クライアントとは別物）。
//
// 重要（セキュリティ）:
// ・この関数はServer Component / Server Action / Route Handlerからのみ呼び出すこと。
//   "use client" が付いたファイルからは絶対にimportしない。
// ・salon_idはこのモジュールの外側（呼び出し元）で、必ず
//   `lib/supabase/queries.ts`の`getCurrentSalon(supabase)`を使って認証済み
//   セッションから解決すること。リクエストボディ・クエリパラメータ・
//   クライアントの状態から受け取ったsalon_idをこのクライアントの引数に
//   使ってはならない（他サロンのデータへアクセスできてしまう）。
// ・blog_posts / salon_settings / salon_reference_posts / salon_style_profiles
//   の4テーブルは現在RLSが有効だがポリシーが無い状態（誰からもservice-role
//   キー以外ではアクセスできない）。将来的にRLSベースのアクセス制御へ移行する
//   ことも検討可能だが、今回のスコープでは行わない（技術的負債として記録）。
//
// Database型の自動生成（supabase CLI）はこのブログ機能では行わないため、
// スキーマ型は明示的にanyとして扱う。クエリ側（lib/blog/queries.ts）で
// 行の形をTypeScript側の型（BlogPost, SalonSettings等）にきちんとマッピングしている。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySupabaseClient = SupabaseClient<any, any, any>;

let cachedClient: AnySupabaseClient | null = null;

export function getBlogSupabaseAdmin(): AnySupabaseClient {
  if (cachedClient) return cachedClient;

  // review-appの命名規則(NEXT_PUBLIC_SUPABASE_URL)に合わせる。値そのものは
  // blog-app側が使っていたSUPABASE_URLと同一のSupabaseプロジェクトを指す。
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
