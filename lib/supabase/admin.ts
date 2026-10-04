import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// service role キーでサーバーからだけアクセスするクライアント(RLS を通らない)。
// 口コミ生成のイベント記録・レート制限(0012)など、service role 専用のテーブルに使う。
// blog と予約通知はそれぞれ lib/blog/admin.ts・lib/notifications/admin.ts を使い続ける。
//
// 重要(セキュリティ):
// ・Route Handler / Server Action / Server Component からだけ使う("use client" から import しない)。
// ・salon_id などの条件は、サーバー側で確定した値(DB で照合済みの値)だけを使う。
//   クライアントから受け取った値をそのまま信用して他店舗のデータに触れないこと。

let cachedClient: SupabaseClient | null = null;

/** 環境変数が無ければ投げる(呼び出し側で、記録などを諦めて処理を続けるか決める)。 */
export function getSupabaseAdmin(): SupabaseClient {
  if (cachedClient) return cachedClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が設定されていません。");
  }

  cachedClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedClient;
}
