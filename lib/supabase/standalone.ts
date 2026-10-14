import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// セッションを持たない(cookie を読み書きしない)anon のクライアント。サーバーから、リクエストのユーザーとは別の
// 処理(パスワードの照合・メールの送信の依頼)をするときに、呼ぶたびに新しく作る。PKCE ではなく implicit の流れにする
// (メールのリンクを開くブラウザに、このサーバーの code verifier は無いため。リンクは /auth/confirm で受け取る)。
export function createStandaloneAnonClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY が設定されていません。");
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: "implicit" },
  });
}
