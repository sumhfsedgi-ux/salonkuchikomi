// メールのリンク(/auth/confirm)に付いてくる値を読む(DBに触れない。ブラウザ・サーバーのどちらからも使う)。
// トークンはフラグメント(#)に載せる形を勧める(サーバーのアクセスログに残らない)。互換のため query(?)も読む。
//   token_hash + type ..... 推奨のテンプレート({{ .TokenHash }})。ボタンを押してから verifyOtp で検証する(先読み対策)
//   code .................. ブラウザの PKCE の流れ(既定のテンプレートの新規登録など)。exchangeCodeForSession
//   access_token など ..... 既定のテンプレートで、サーバーから頼んだメール(implicit)。setSession
//   error / error_code .... Supabase が検証に失敗したときの戻り(期限切れ・使用済みなど)

export type LinkType = "email" | "signup" | "invite" | "magiclink" | "recovery";

export type AuthLink =
  | { kind: "token_hash"; tokenHash: string; type: LinkType }
  | { kind: "code"; code: string }
  | { kind: "session"; accessToken: string; refreshToken: string }
  | { kind: "error"; code: string }
  | { kind: "none" };

const LINK_TYPES: readonly LinkType[] = ["email", "signup", "invite", "magiclink", "recovery"];

export function parseAuthLink(search: string, hash: string): AuthLink {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const h = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const get = (key: string) => h.get(key) ?? q.get(key);
  const errorCode = get("error_code") ?? get("error");
  if (errorCode) return { kind: "error", code: errorCode.slice(0, 60) };
  const tokenHash = get("token_hash");
  const type = get("type");
  if (tokenHash && type && (LINK_TYPES as readonly string[]).includes(type) && /^[A-Za-z0-9_-]{8,200}$/.test(tokenHash)) {
    return { kind: "token_hash", tokenHash, type: type as LinkType };
  }
  const accessToken = h.get("access_token");
  const refreshToken = h.get("refresh_token");
  if (accessToken && refreshToken) return { kind: "session", accessToken, refreshToken };
  const code = q.get("code");
  if (code && /^[A-Za-z0-9_-]{8,200}$/.test(code)) return { kind: "code", code };
  return { kind: "none" };
}

/** 検証に失敗したときの案内の種類(期限切れ・使用済み・無効)。 */
export type LinkProblem = "expired" | "invalid" | "rate_limited" | "other_browser";

export function linkProblemOf(code: string | null | undefined): LinkProblem {
  if (!code) return "invalid";
  if (code === "otp_expired" || code === "flow_state_expired") return "expired";
  if (code === "over_request_rate_limit" || code === "over_email_send_rate_limit") return "rate_limited";
  if (code === "bad_code_verifier" || code === "flow_state_not_found" || code === "pkce_verifier_missing") return "other_browser";
  return "invalid";
}

export const LINK_PROBLEM_MESSAGES: Record<LinkProblem, string> = {
  expired: "このリンクは有効期限が切れているか、すでに使われています。",
  invalid: "このリンクを確認できませんでした。メールに届いたリンクを、そのまま開いてください。",
  rate_limited: "短い間に操作が続いたため、確認できませんでした。少し時間をおいてから、もう一度開いてください。",
  other_browser: "登録したときとは別のブラウザ・端末で開いたため、確認できませんでした。",
};

/** リンクの種類ごとの、次にすること(期限切れ・使用済み・無効のとき)。 */
export function nextActionsFor(type: LinkType | null): string[] {
  const common = "すでにパスワードを設定・登録済みの場合は、ログインしてください。";
  if (type === "invite") return ["運営からの招待のメールの場合は、運営に招待メールの再送をご依頼ください。", common];
  if (type === "recovery") return ["パスワードの再設定・本人確認のメールの場合は、ログイン画面からもう一度お手続きください。", common];
  if (type === "magiclink") return ["ログインのご案内のメールの場合は、ログイン画面からログインしてください。"];
  return ["新規登録の確認メールの場合は、ログイン画面で登録したメールアドレスとパスワードを入力すると、確認メールを再送できます。", common];
}
