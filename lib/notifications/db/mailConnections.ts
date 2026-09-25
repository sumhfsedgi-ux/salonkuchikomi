import { getNotificationsSupabaseAdmin } from "@/lib/notifications/admin";
import { decrypt } from "@/lib/notifications/crypto";

// (hmailの lib/db/mailConnections.ts を review-app のSupabaseクライアント方式へ
// 移植。Drizzleの生Postgres接続の代わりに service-role Supabaseクライアントを使う。
// OAuth接続フロー自体(upsertMailConnection相当)は今回のスコープ外
// -- 既存1ユーザーの移行は1回限りの移行スクリプトが直接書き込むため、
// ここには「接続済みの状態を読み取り/更新する」関数のみを持つ。)

export interface MailConnection {
  id: string;
  salonId: string;
  provider: string;
  emailAddress: string;
  encryptedRefreshToken: string;
  tokenIv: string;
  tokenAuthTag: string;
  scope: string;
  status: "connected" | "needs_reconnect";
  consecutiveFailureCount: number;
  createdAt: string;
  updatedAt: string;
}

interface MailConnectionRow {
  id: string;
  salon_id: string;
  provider: string;
  email_address: string;
  encrypted_refresh_token: string;
  token_iv: string;
  token_auth_tag: string;
  scope: string;
  status: string;
  consecutive_failure_count: number;
  created_at: string;
  updated_at: string;
}

const MAIL_CONNECTION_COLUMNS =
  "id, salon_id, provider, email_address, encrypted_refresh_token, token_iv, token_auth_tag, scope, status, consecutive_failure_count, created_at, updated_at";

function rowToMailConnection(row: MailConnectionRow): MailConnection {
  return {
    id: row.id,
    salonId: row.salon_id,
    provider: row.provider,
    emailAddress: row.email_address,
    encryptedRefreshToken: row.encrypted_refresh_token,
    tokenIv: row.token_iv,
    tokenAuthTag: row.token_auth_tag,
    scope: row.scope,
    status: row.status as MailConnection["status"],
    consecutiveFailureCount: row.consecutive_failure_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * cronが今回のtickで処理すべき全接続。'needs_reconnect'も含める
 * (オーナーが再接続すれば次回成功時に自動で'connected'へ自己修復するため、
 * 手動でのリセット操作を不要にする)。
 */
export async function listActiveMailConnections(): Promise<MailConnection[]> {
  const supabase = getNotificationsSupabaseAdmin();
  const { data, error } = await supabase
    .from("mail_connections")
    .select(MAIL_CONNECTION_COLUMNS)
    .in("status", ["connected", "needs_reconnect"]);

  if (error) {
    console.error("listActiveMailConnections failed:", error);
    throw new Error("メール接続の取得に失敗しました。");
  }
  return (data ?? []).map(rowToMailConnection);
}

export async function getMailConnection(salonId: string): Promise<MailConnection | null> {
  const supabase = getNotificationsSupabaseAdmin();
  const { data, error } = await supabase
    .from("mail_connections")
    .select(MAIL_CONNECTION_COLUMNS)
    .eq("salon_id", salonId)
    .maybeSingle();

  if (error) {
    console.error("getMailConnection failed:", error);
    throw new Error("メール接続の取得に失敗しました。");
  }
  return data ? rowToMailConnection(data) : null;
}

export function decryptRefreshToken(row: MailConnection): string {
  return decrypt({
    ciphertext: row.encryptedRefreshToken,
    iv: row.tokenIv,
    authTag: row.tokenAuthTag,
  });
}

export async function recordMailCheckSuccess(salonId: string): Promise<void> {
  const supabase = getNotificationsSupabaseAdmin();
  const { error } = await supabase
    .from("mail_connections")
    .update({
      status: "connected",
      consecutive_failure_count: 0,
      last_checked_at: new Date().toISOString(),
      last_error: null,
      last_error_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("salon_id", salonId);

  if (error) console.error("recordMailCheckSuccess failed:", error);
}

const FAILURES_BEFORE_NEEDS_RECONNECT = 2;

/**
 * invalid_grant系の失敗を記録する。連続2回失敗して初めて'needs_reconnect'へ
 * 遷移させる(単発の一時的な失敗でオーナーへ誤って「接続が切れた」と
 * 警告しないため)。
 *
 * 戻り値がtrueなのは、まさに今回の呼び出しで初めて'needs_reconnect'へ
 * 遷移した場合のみ -- 呼び出し元はこれを使って「壊れた」アラートを
 * 1回だけ送る(壊れたままの間、毎回再アラートしない)。
 */
export async function recordMailAuthFailure(
  salonId: string,
  errorMessage: string
): Promise<boolean> {
  const current = await getMailConnection(salonId);
  const nextCount = (current?.consecutiveFailureCount ?? 0) + 1;
  const wasAlreadyBroken = current?.status === "needs_reconnect";
  const nowBroken = nextCount >= FAILURES_BEFORE_NEEDS_RECONNECT;

  const supabase = getNotificationsSupabaseAdmin();
  const { error } = await supabase
    .from("mail_connections")
    .update({
      consecutive_failure_count: nextCount,
      status: nowBroken ? "needs_reconnect" : (current?.status ?? "connected"),
      last_error: errorMessage,
      last_error_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("salon_id", salonId);

  if (error) console.error("recordMailAuthFailure failed:", error);

  return nowBroken && !wasAlreadyBroken;
}
