import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { currentDbTimeLimitMs } from "@/lib/notifications/dbTimeLimit";

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
// ・予約通知・Google 連携の表(0009・0020・0021・0022)は RLS が有効でポリシーが無い
//   (service-role キー以外からはアクセス不可。0021・0022 の表は anon/authenticated の
//   権限も取り消してある)。Google 連携の表もこのクライアントで扱う(lib/google/db/*)。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySupabaseClient = SupabaseClient<any, any, any>;

let cachedClient: AnySupabaseClient | null = null;

// DB への1回の問い合わせの上限。定期処理(lib/notifications/jobs/runBudget.ts)が関数の実行時間の上限の内側で
// 終わるよう、応答の無い問い合わせを待ち続けない(超えたら失敗として扱い、次の回にやり直す)。
// 定期処理の中では、さらに全体の残り時間(lib/notifications/dbTimeLimit.ts)で短くする。
const DB_REQUEST_TIMEOUT_MS = 10_000;

function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const limit = currentDbTimeLimitMs();
  const ms = limit === null ? DB_REQUEST_TIMEOUT_MS : Math.min(DB_REQUEST_TIMEOUT_MS, Math.max(0, Math.floor(limit)));
  if (ms <= 0) return Promise.reject(new DOMException("db time limit reached", "TimeoutError"));
  const timeout = AbortSignal.timeout(ms);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(input, { ...init, signal });
}

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
    global: { fetch: fetchWithTimeout },
  });
  return cachedClient;
}
