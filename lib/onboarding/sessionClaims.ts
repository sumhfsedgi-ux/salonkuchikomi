// 検証済みの JWT(supabase.auth.getClaims() の結果)から、本人確認に要る値だけを取り出す(DB に触れない)。
//   - session_id: Supabase Auth のセッション(DB の auth.sessions の行)。サインアウトすると行が消える
//   - amr: そのセッションをどの方法で認証したか。メールのリンク(招待・確認・Magic Link・パスワード再設定)か、パスワードか
// ここでの判定は画面の出し分けと、サーバーの Action の入口の確認に使う。記録の可否は DB(account_verification_record)でも
// auth.mfa_amr_claims を見て確かめる(この判定だけに頼らない)。

/**
 * メールのリンクで得たセッションの認証方法(Supabase Auth の amr)。testdb で確かめた実際の値:
 *   token_hash を verifyOtp で検証したセッションは、招待・確認・Magic Link・パスワード再設定のどれも otp。
 *   パスワードでのログインは password。
 *   ブラウザの PKCE の流れ(既存のパスワード再設定)は recovery(scripts/testdb/password-reset-walkthrough.ts。GoTrue v2.197.0)。
 * Supabase Auth の実装では、PKCE の流れでほかに invite・magiclink・email/signup も記録するため、これらもメールのリンクとして扱う。
 */
export const EMAIL_LINK_METHODS = ["otp", "magiclink", "recovery", "invite", "email/signup"] as const;

export interface SessionClaims {
  userId: string;
  sessionId: string;
  email: string | null;
  /** 認証方法(新しい順とは限らない)。 */
  methods: string[];
}

type AmrValue = Array<{ method?: unknown; timestamp?: unknown } | string> | undefined | null;

export function amrMethods(amr: AmrValue): string[] {
  if (!Array.isArray(amr)) return [];
  const out: string[] = [];
  for (const entry of amr) {
    if (typeof entry === "string") out.push(entry);
    else if (entry && typeof entry === "object" && typeof entry.method === "string") out.push(entry.method);
  }
  return out;
}

export function isEmailLinkSession(methods: readonly string[]): boolean {
  return methods.some((m) => (EMAIL_LINK_METHODS as readonly string[]).includes(m));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** getClaims() の claims を読む。必要な値が無い・形が違うときは null(本人確認の手続きに使わない)。 */
export function parseSessionClaims(claims: Record<string, unknown> | null | undefined): SessionClaims | null {
  if (!claims) return null;
  const sub = claims.sub;
  const sessionId = claims.session_id;
  if (typeof sub !== "string" || !UUID.test(sub)) return null;
  if (typeof sessionId !== "string" || !UUID.test(sessionId)) return null;
  return {
    userId: sub,
    sessionId,
    email: typeof claims.email === "string" && claims.email ? claims.email : null,
    methods: amrMethods(claims.amr as AmrValue),
  };
}
