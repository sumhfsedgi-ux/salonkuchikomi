import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

// 今のリクエストのアカウントとセッションの状態(DB の my_account_state。0025)。リクエストごとに1回だけ読む。
// 判定そのもの(セッションを信頼してよいか)は DB が行う。JWT の検証(getClaims)だけでは、サインアウトした
// セッションのトークンも有効に見えるため、画面・Server Action の入口はこの値で判断する(testdb で確認)。

export type VerificationMode = "confirm_or_set" | "set_new";

export interface AccountState {
  emailConfirmed: boolean;
  /** 本人確認の記録がある(legacy / password_confirmed / password_set)。 */
  verified: boolean;
  verificationMode: VerificationMode;
  /** このセッションを信頼してよい(本人確認のあと・auth.sessions に行がある)。 */
  sessionTrusted: boolean;
  /** このセッションは、メールのリンクで得たもの(本人確認の手続きができる)。 */
  emailLinkSession: boolean;
  isOperator: boolean;
}

interface Row {
  email_confirmed: boolean;
  verified: boolean;
  verification_mode: string;
  session_trusted: boolean;
  email_link_session: boolean;
  is_operator: boolean;
}

export function toAccountState(row: Row | null | undefined): AccountState | null {
  if (!row) return null;
  return {
    emailConfirmed: row.email_confirmed === true,
    verified: row.verified === true,
    verificationMode: row.verification_mode === "confirm_or_set" ? "confirm_or_set" : "set_new",
    sessionTrusted: row.session_trusted === true,
    emailLinkSession: row.email_link_session === true,
    isOperator: row.is_operator === true,
  };
}

/** ログインしていなければ null。読めなければ投げる(信頼できる側に倒さない)。 */
export const getAccountState = cache(async (supabase: SupabaseClient): Promise<AccountState | null> => {
  const { data, error } = await supabase.rpc("my_account_state");
  if (error) throw new Error("アカウントの状態を読み込めませんでした。");
  const rows = (Array.isArray(data) ? data : data ? [data] : []) as Row[];
  return toAccountState(rows[0]);
});
