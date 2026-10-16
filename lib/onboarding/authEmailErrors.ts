// Supabase Auth のメール送信のエラーを、記録・表示用の分類に直す(DBに触れない)。生のメッセージは保存・表示しない。
// 分類は DB(salon_invitation_attempts.error_code など)の形 ^[a-z_]{1,40}$ にそろえる。

export type AuthEmailErrorCode =
  | "rate_limited"
  | "address_not_authorized"
  | "already_confirmed"
  | "user_not_found"
  | "config_missing"
  | "send_failed";

export function classifyAuthEmailError(error: { code?: string | null; status?: number | null; name?: string | null } | null | undefined): AuthEmailErrorCode {
  const code = error?.code ?? "";
  if (code === "over_email_send_rate_limit" || code === "over_request_rate_limit" || error?.status === 429) return "rate_limited";
  if (code === "email_address_not_authorized") return "address_not_authorized";
  if (code === "email_exists" || code === "user_already_exists") return "already_confirmed";
  if (code === "user_not_found") return "user_not_found";
  return "send_failed";
}

/** 運営の画面での説明(機械向けの情報は出さない)。 */
export const AUTH_EMAIL_ERROR_LABELS: Record<AuthEmailErrorCode, string> = {
  rate_limited: "短い間に送信が続いたため、送信を受け付けてもらえませんでした。時間をおいて再送してください。",
  address_not_authorized: "メール送信の設定で、このアドレスへの送信が許可されていません(独自の送信設定が必要です)。",
  already_confirmed: "アカウントの状態が変わったため、送信できませんでした。画面を再読み込みしてから再送してください。",
  user_not_found: "アカウントが見つからないため、送信できませんでした。",
  config_missing: "メール送信の設定が完了していないため、送信できませんでした。",
  send_failed: "メールの送信サービスでエラーが発生し、送信できませんでした。時間をおいて再送してください。",
};

export function authEmailErrorLabel(code: string | null | undefined): string {
  if (code && code in AUTH_EMAIL_ERROR_LABELS) return AUTH_EMAIL_ERROR_LABELS[code as AuthEmailErrorCode];
  return AUTH_EMAIL_ERROR_LABELS.send_failed;
}
