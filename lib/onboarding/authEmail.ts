import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isRealAuthEmailAllowed, resolveAuthEmailPolicy, type AuthEmailPolicy } from "@/lib/onboarding/authEmailPolicy";
import { classifyAuthEmailError, type AuthEmailErrorCode } from "@/lib/onboarding/authEmailErrors";
import { createStandaloneAnonClient } from "@/lib/supabase/standalone";

// 今回アプリに足した、認証のメールを送る呼び出しは、すべてこのファイルだけに置く(静的テストで確かめる)。
// どの関数も、送信の方針(lib/onboarding/authEmailPolicy.ts)に従い、送らない環境では Supabase の送信の API を呼ばない。
// メールの種類は、Supabase のテンプレートの種類で分ける(ユーザーの metadata で文面を切り替えない):
//   Confirm signup ... 新規登録の確認・その再送       → sendSignup / resendSignupConfirmation
//   Invite user ...... 招待(新しい・未確認のアカウント) → sendInvite
//   Magic Link ....... 店舗登録のお知らせ(本人確認済み) → sendSalonNotice(この用途だけに使う)
//   Reset password ... 本人確認のリンク(本人確認がまだ) → sendVerificationLink(既存の再設定と同じテンプレート)
// リンクの戻り先は NEXT_PUBLIC_APP_URL の /auth/confirm。トークン・リンク・パスワード・アドレスはログに出さない。

export type AuthEmailOutcome =
  | { outcome: "accepted" }
  | { outcome: "simulated" }
  | { outcome: "skipped" }
  | { outcome: "failed"; code: AuthEmailErrorCode };

export interface AuthEmailDeps {
  admin: SupabaseClient;
  newAnonClient?: () => SupabaseClient;
  policy?: AuthEmailPolicy;
  appUrl?: string | undefined;
}

function confirmUrl(appUrl: string | undefined): string | null {
  if (!appUrl) return null;
  try {
    return `${new URL(appUrl).origin}/auth/confirm`;
  } catch {
    return null;
  }
}

function context(deps: AuthEmailDeps) {
  return {
    policy: deps.policy ?? resolveAuthEmailPolicy(),
    anon: deps.newAnonClient ?? createStandaloneAnonClient,
    redirectTo: confirmUrl(deps.appUrl ?? process.env.NEXT_PUBLIC_APP_URL),
  };
}

function failed(error: unknown): AuthEmailOutcome {
  return { outcome: "failed", code: classifyAuthEmailError(error as { code?: string; status?: number }) };
}

/**
 * 新規登録(アカウントが無いアドレス)。実際に送る環境では signUp(Confirm signup のメール)、送らない環境では
 * メールを送らない generateLink でアカウントだけ作る(開発・検証で手続きを続けられるように)。
 * verify で許可していないアドレスは、何もしない(skipped)。
 */
export async function sendSignup(deps: AuthEmailDeps, email: string, password: string): Promise<AuthEmailOutcome & { userId?: string }> {
  const { policy, anon, redirectTo } = context(deps);
  if (policy.mode === "verify" && !isRealAuthEmailAllowed(policy, email)) return { outcome: "skipped" };
  if (!isRealAuthEmailAllowed(policy, email)) {
    const { data, error } = await deps.admin.auth.admin.generateLink({ type: "signup", email, password });
    if (error) return failed(error);
    return { outcome: "simulated", userId: data.user?.id };
  }
  if (!redirectTo) return { outcome: "failed", code: "config_missing" };
  const { data, error } = await anon().auth.signUp({ email, password, options: { emailRedirectTo: redirectTo } });
  if (error) return failed(error);
  return { outcome: "accepted", userId: data.user?.id };
}

/** 確認メールの再送(未確認のアカウント)。 */
export async function resendSignupConfirmation(deps: AuthEmailDeps, email: string): Promise<AuthEmailOutcome> {
  const { policy, anon, redirectTo } = context(deps);
  if (!isRealAuthEmailAllowed(policy, email)) return policy.mode === "verify" ? { outcome: "skipped" } : { outcome: "simulated" };
  if (!redirectTo) return { outcome: "failed", code: "config_missing" };
  const { error } = await anon().auth.resend({ type: "signup", email, options: { emailRedirectTo: redirectTo } });
  return error ? failed(error) : { outcome: "accepted" };
}

/** 招待(新しい・未確認のアカウント。本人がリンクからパスワードを設定する)。 */
export async function sendInvite(deps: AuthEmailDeps, email: string): Promise<AuthEmailOutcome> {
  const { policy, redirectTo } = context(deps);
  if (!isRealAuthEmailAllowed(policy, email)) return { outcome: "simulated" };
  if (!redirectTo) return { outcome: "failed", code: "config_missing" };
  const { error } = await deps.admin.auth.admin.inviteUserByEmail(email, { redirectTo });
  return error ? failed(error) : { outcome: "accepted" };
}

/** 店舗登録のお知らせ(本人確認済みのアカウント。ログインの案内。パスワードは変えない)。 */
export async function sendSalonNotice(deps: AuthEmailDeps, email: string): Promise<AuthEmailOutcome> {
  const { policy, anon, redirectTo } = context(deps);
  if (!isRealAuthEmailAllowed(policy, email)) return { outcome: "simulated" };
  if (!redirectTo) return { outcome: "failed", code: "config_missing" };
  const { error } = await anon().auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: redirectTo } });
  return error ? failed(error) : { outcome: "accepted" };
}

/** 本人確認のリンク(メールは確認済みで、本人確認がまだのアカウント)。パスワード再設定のテンプレートで送る。 */
export async function sendVerificationLink(deps: AuthEmailDeps, email: string): Promise<AuthEmailOutcome> {
  const { policy, anon, redirectTo } = context(deps);
  if (!isRealAuthEmailAllowed(policy, email)) return { outcome: "simulated" };
  if (!redirectTo) return { outcome: "failed", code: "config_missing" };
  const { error } = await anon().auth.resetPasswordForEmail(email, { redirectTo });
  return error ? failed(error) : { outcome: "accepted" };
}
