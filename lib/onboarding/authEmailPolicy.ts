// 認証のメール(新規登録の確認・確認メールの再送・招待・店舗登録のお知らせ・本人確認のリンク)を、この環境で実際に送ってよいか。
// LINE の送信の方針(lib/notifications/line/sendPolicy.ts)と同じ形にする。値は環境変数からだけ読む。
//
//   - simulated(送らない): 開発(next dev)・テスト用 DB の検証(SALONPACK_VERIFY_MODE)・Vercel のプレビュー。
//       Supabase の送信の API を呼ばない。新規登録はメールを送らない admin.generateLink でアカウントだけ作る。
//   - verify: AUTH_EMAIL_VERIFY=1 のとき、AUTH_EMAIL_VERIFY_RECIPIENTS(カンマ区切り)のアドレスにだけ送る。
//       運営が本番で、自分のアドレスに送って確かめるため。ほかのアドレスには送らない(新規登録は何もしない)。
//   - live: 本番(本番ビルド・Vercel の production・検証の設定なし)。実際に送る。
//
// この方針の対象は、今回アプリに足した・変えた送信の経路だけ。既存のパスワード再設定(ブラウザから Supabase に
// 直接頼む resetPasswordForEmail)は対象外で、どの環境でも Supabase の設定どおりに送られる。
// Supabase の API を誰かが直接呼んだ場合(新規登録など)は、Supabase の設定だけで決まる。

export type AuthEmailPolicy =
  | { mode: "live" }
  | { mode: "simulated"; reason: "development" | "testdb" | "preview" }
  | { mode: "verify"; recipients: ReadonlySet<string> };

function recipientsOf(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter((v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)),
  );
}

export function resolveAuthEmailPolicy(env: Record<string, string | undefined> = process.env): AuthEmailPolicy {
  if (env.SALONPACK_VERIFY_MODE) return { mode: "simulated", reason: "testdb" };
  if (env.AUTH_EMAIL_VERIFY === "1") return { mode: "verify", recipients: recipientsOf(env.AUTH_EMAIL_VERIFY_RECIPIENTS) };
  if (env.NODE_ENV !== "production") return { mode: "simulated", reason: "development" };
  if (env.VERCEL_ENV && env.VERCEL_ENV !== "production") return { mode: "simulated", reason: "preview" };
  return { mode: "live" };
}

/** このアドレスへ、実際にメールを送ってよいか。 */
export function isRealAuthEmailAllowed(policy: AuthEmailPolicy, email: string): boolean {
  if (policy.mode === "live") return true;
  if (policy.mode === "verify") return policy.recipients.has(email.trim().toLowerCase());
  return false;
}

/** お客様の新規登録(画面)を出すか。既定は出さない(独自の SMTP とテンプレートを整えてから SELF_SIGNUP_ENABLED=1)。 */
export function isSelfSignupEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.SELF_SIGNUP_ENABLED === "1";
}
