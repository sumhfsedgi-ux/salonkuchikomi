"use server";

import { cookies, headers } from "next/headers";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { createStandaloneAnonClient } from "@/lib/supabase/standalone";
import { getAuthedUser, getCurrentSalon } from "@/lib/supabase/queries";
import { getAccountState } from "@/lib/onboarding/accountState";
import { resolveNextStep, type NextStep } from "@/lib/onboarding/nextStep";
import { isSelfSignupEnabled, resolveAuthEmailPolicy } from "@/lib/onboarding/authEmailPolicy";
import { requestConfirmationResend, requestSignup } from "@/lib/onboarding/signup";
import { sendVerificationLink } from "@/lib/onboarding/authEmail";
import { normalizeEmail } from "@/lib/onboarding/salonProfile";
import {
  resendAcceptedMessage,
  secondsUntilWindowEnd,
  VERIFY_LINK_ACCEPTED_TEXT,
  VERIFY_LINK_SIMULATED_TEXT,
} from "@/lib/onboarding/signupNotice";
import {
  readSessionClaims,
  resetPasswordWithRecoverySession,
  verifyByCurrentPassword,
  verifyBySettingPassword,
  type VerificationFailure,
} from "@/lib/onboarding/verification";
import { hashIp } from "@/lib/reviewGeneration/rateLimit";
import { RETURN_COOKIE, safeReturnPath, withReturnPath } from "@/lib/auth/returnPath";

// 認証まわりの Server Action。どれもブラウザから直接呼べるため、入口で入力・セッションを確かめる。
// 応答には、アカウントの有無・送信の可否など第三者に漏れて困ることを書かない。パスワード・トークンはログに出さない。

const PASSWORD_MIN = 8;
const passwordSchema = z
  .string()
  .min(PASSWORD_MIN, `パスワードは${PASSWORD_MIN}文字以上で入力してください。`)
  .max(72, "パスワードは72文字以内で入力してください。");
const emailSchema = z
  .string()
  .transform(normalizeEmail)
  .pipe(z.string().min(3, "メールアドレスを入力してください。").max(254).regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, "メールアドレスの形式で入力してください。"));

/** 待ち時間の範囲: address = そのアドレス(ユーザー)への送信の間隔 / connection = この接続元からの回数(どのアドレスでも同じ)。 */
export type RetryScope = "address" | "connection";

export type FieldResult =
  | { ok: true; message?: string; simulated?: boolean; retryAfterSeconds?: number; retryScope?: RetryScope }
  | { ok: false; error?: string; fieldErrors?: Record<string, string>; retryAfterSeconds?: number; retryScope?: RetryScope };

const RATE_LIMITED_TEXT = "短い間に操作が続いています。少し時間をおいてから、もう一度お試しください。";
const TRY_LATER_TEXT = "処理できませんでした。時間をおいて、もう一度お試しください。";

async function clientKey(): Promise<string> {
  const h = await headers();
  const ip = h.get("x-real-ip")?.trim() || h.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  return hashIp(ip);
}

/** 0012 の rate_limit_hit。DB のエラーのときは通す(登録の受付を止めないため。Supabase の側にも上限がある)。 */
async function withinLimit(key: string, windowSeconds: number, limit: number): Promise<boolean> {
  const { data, error } = await getSupabaseAdmin().rpc("rate_limit_hit", { p_key: key, p_window_seconds: windowSeconds, p_limit: limit });
  if (error) return true;
  return data !== false;
}

/**
 * 同じアドレス・同じユーザーへの送信の間隔(秒。前回から数える)。初期値は65秒。
 * Supabase にも同じ人への最低の間隔(資料・ソースでの初期値は60秒・前回の送信から数える)がある。このプロジェクトの
 * 実際の設定値はアプリから確かめられないため、この値が Supabase の設定より長いときだけ、Supabase に断られにくくなる
 * (手順書の、一般公開の前に確かめること)。
 */
function authEmailIntervalSeconds(): number {
  const value = Number.parseInt(process.env.AUTH_EMAIL_MIN_INTERVAL_SECONDS ?? "", 10);
  return Number.isFinite(value) && value >= 1 && value <= 3600 ? value : 65;
}

type SendLimit = { ok: true; intervalSeconds: number } | { ok: false; result: FieldResult };

/**
 * 送信の前の制限(0026)。アカウントを調べる前に、どのアドレスにも同じように確かめる(登録済みかどうかで応答を変えない)。
 *   1. 接続元ごとの回数(0012 の rate_limit_hit。1時間に10回・1時間区切り。変えない)
 *   2. アドレスごとの間隔(auth_email_cooldown_take。前回から N 秒。確かめると同時に記録する)
 * 待ち時間は、サーバーが決めた残りの秒数を返す(画面はこれで数える)。間隔の記録が読めないときは、どのアドレスでも同じ応答にする。
 */
async function takeSendLimit(ipKey: string, cooldownKey: string): Promise<SendLimit> {
  if (!(await withinLimit(ipKey, 60 * 60, 10))) {
    // 1時間区切りの窓が終わるまで(アプリの時計で数えるため、1秒の余裕を足す)
    return {
      ok: false,
      result: { ok: false, error: RATE_LIMITED_TEXT, retryAfterSeconds: secondsUntilWindowEnd(Date.now(), 60 * 60) + 1, retryScope: "connection" },
    };
  }
  const intervalSeconds = authEmailIntervalSeconds();
  const { data, error } = await getSupabaseAdmin().rpc("auth_email_cooldown_take", { p_key: cooldownKey, p_seconds: intervalSeconds });
  if (error) return { ok: false, result: { ok: false, error: TRY_LATER_TEXT } };
  const left = Number(data);
  if (left > 0) return { ok: false, result: { ok: false, error: RATE_LIMITED_TEXT, retryAfterSeconds: left, retryScope: "address" } };
  return { ok: true, intervalSeconds };
}

/** アドレスごとの間隔のキー。新規登録と確認メールの再送(新規登録の画面・ログイン画面)で共用する。生のアドレスは入れない。 */
function confirmEmailKey(email: string): string {
  return `confirm:${hashIp(email)}`;
}

/** 送信の失敗のログ。失敗の種類(コード)だけを残す(メールアドレス・トークン・パスワード・リンクは残さない)。 */
function logSendFailure(where: string, code: string | undefined): void {
  console.warn(`[auth-email] ${where}: ${code ?? "unknown"}`);
}

// 新規登録・確認メールの再送の応答は、登録済みかどうかで変えない(画面の文は lib/onboarding/signupNotice.ts)。
// Supabase に断られた(429 を含む)・送信に失敗した場合も、受付と同じ応答にする(確認済みのアカウントでは送信が起きないため、
// 失敗だけを伝えると、登録済みかどうかが分かってしまう)。受付は「送った・届いた」という意味ではない。
export async function signupAction(input: { email: string; password: string; passwordConfirm: string }): Promise<FieldResult> {
  if (!isSelfSignupEnabled()) return { ok: false, error: "現在、新規登録は受け付けていません。" };
  const fieldErrors: Record<string, string> = {};
  const email = emailSchema.safeParse(input?.email ?? "");
  if (!email.success) fieldErrors.email = email.error.issues[0]?.message ?? "メールアドレスを確認してください。";
  const password = passwordSchema.safeParse(input?.password ?? "");
  if (!password.success) fieldErrors.password = password.error.issues[0]?.message ?? "パスワードを確認してください。";
  else if (input.password !== input.passwordConfirm) fieldErrors.passwordConfirm = "パスワードが一致しません。";
  if (Object.keys(fieldErrors).length > 0 || !email.success || !password.success) return { ok: false, fieldErrors };

  const limit = await takeSendLimit(`signup:ip:${await clientKey()}`, confirmEmailKey(email.data));
  if (!limit.ok) return limit.result;
  try {
    const result = await requestSignup({ admin: getSupabaseAdmin() }, email.data, password.data);
    if (result.result === "failed") logSendFailure("signup", result.failureCode);
  } catch {
    logSendFailure("signup", "exception");
  }
  return { ok: true, simulated: resolveAuthEmailPolicy().mode === "simulated", retryAfterSeconds: limit.intervalSeconds, retryScope: "address" };
}

// 確認メールの再送(新規登録の送信後の画面・ログイン画面)。新規登録の受付を閉じていても止めない
// (招待のお客様はこの経路を使わない。Supabase の再送は anon key で直接呼べるため、ここで止めても守りにならない。
// 店舗の登録は、DB の受付の設定で止まる)。
export async function resendConfirmationAction(input: { email: string }): Promise<FieldResult> {
  const email = emailSchema.safeParse(input?.email ?? "");
  if (!email.success) return { ok: false, fieldErrors: { email: email.error.issues[0]?.message ?? "メールアドレスを確認してください。" } };
  const limit = await takeSendLimit(`resend:ip:${await clientKey()}`, confirmEmailKey(email.data));
  if (!limit.ok) return limit.result;
  try {
    const result = await requestConfirmationResend({ admin: getSupabaseAdmin() }, email.data);
    if (result.result === "failed") logSendFailure("resend", undefined);
  } catch {
    logSendFailure("resend", "exception");
  }
  const mode = resolveAuthEmailPolicy().mode === "simulated" ? "simulated" : "live";
  return {
    ok: true,
    message: resendAcceptedMessage(mode),
    simulated: mode === "simulated",
    retryAfterSeconds: limit.intervalSeconds,
    retryScope: "address",
  };
}

const VERIFICATION_ERRORS: Record<VerificationFailure, string> = {
  not_signed_in: "ログインの状態を確認できませんでした。メールのリンクをもう一度開くか、ログインし直してください。",
  not_email_link: "本人確認は、メールのリンクから開いた画面でだけ行えます。下のボタンから確認のメールを受け取ってください。",
  password_mismatch: "パスワードが一致しません。新しいパスワードを設定することもできます。",
  weak_password: "このパスワードは使えません。より推測されにくいパスワードを設定してください。",
  same_password: "今と同じパスワードは設定できません。別のパスワードを入力してください。",
  update_failed: "パスワードを設定できませんでした。時間をおいて、もう一度お試しください。",
  session_expired: "このリンクの手続きは無効になりました(別の場所でパスワードが変更されたなど)。下のボタンから、新しい確認のメールを受け取ってください。",
  record_failed: "本人確認を記録できませんでした。時間をおいて、もう一度お試しください。",
  email_unconfirmed: "メールアドレスの確認が済んでいません。メールのリンクを開いてください。",
};

function verificationDeps(userClient: Awaited<ReturnType<typeof createClient>>) {
  return { userClient, admin: getSupabaseAdmin(), newAnonClient: createStandaloneAnonClient };
}

/** 本人確認(/auth/verify)。登録したパスワードを入れ直す(confirm)か、新しく設定する(set)。 */
export async function verifyIdentityAction(input: { mode: "confirm" | "set"; password: string; passwordConfirm?: string }): Promise<
  { ok: true; next: NextStep | string } | { ok: false; error?: string; fieldErrors?: Record<string, string>; reason?: VerificationFailure }
> {
  const supabase = await createClient();
  const parsed = passwordSchema.safeParse(input?.password ?? "");
  if (input?.mode === "set") {
    if (!parsed.success) return { ok: false, fieldErrors: { password: parsed.error.issues[0]?.message ?? "パスワードを確認してください。" } };
    if (input.password !== input.passwordConfirm) return { ok: false, fieldErrors: { passwordConfirm: "パスワードが一致しません。" } };
  } else if (!input?.password) {
    return { ok: false, fieldErrors: { password: "パスワードを入力してください。" } };
  }
  const claims = await readSessionClaims(supabase);
  if (claims && !(await withinLimit(`verify:user:${claims.userId}`, 15 * 60, 10))) {
    return { ok: false, error: "短い間に操作が続いています。少し時間をおいてから、もう一度お試しください。" };
  }
  const deps = verificationDeps(supabase);
  const result = input.mode === "set" ? await verifyBySettingPassword(deps, input.password) : await verifyByCurrentPassword(deps, input.password);
  if (!result.ok) {
    const fieldErrors = result.reason === "password_mismatch" || result.reason === "weak_password" || result.reason === "same_password"
      ? { password: VERIFICATION_ERRORS[result.reason] }
      : undefined;
    return { ok: false, reason: result.reason, error: fieldErrors ? undefined : VERIFICATION_ERRORS[result.reason], fieldErrors };
  }
  return { ok: true, next: await nextStepFor(supabase) };
}

/** 本人確認のリンク(パスワード再設定のテンプレート)を、このアカウントのアドレスへ送る。宛先はセッションのアドレスだけ。 */
export async function sendVerificationLinkAction(): Promise<FieldResult> {
  const supabase = await createClient();
  const user = await getAuthedUser(supabase);
  if (!user?.email) return { ok: false, error: "ログインの状態を確認できませんでした。ログインし直してください。" };
  // 同じユーザーへの間隔(前回から N 秒。0026)と、1日5回まで(0012。1日区切り)
  const intervalSeconds = authEmailIntervalSeconds();
  const { data: left, error: cooldownError } = await getSupabaseAdmin().rpc("auth_email_cooldown_take", {
    p_key: `verify-link:${user.id}`,
    p_seconds: intervalSeconds,
  });
  if (cooldownError) return { ok: false, error: TRY_LATER_TEXT };
  if (Number(left) > 0) return { ok: false, error: RATE_LIMITED_TEXT, retryAfterSeconds: Number(left), retryScope: "address" };
  if (!(await withinLimit(`verify-link:user-day:${user.id}`, 24 * 60 * 60, 5))) {
    return {
      ok: false,
      error: "今日はこれ以上送れません。時間をおいて、もう一度お試しください。",
      retryAfterSeconds: secondsUntilWindowEnd(Date.now(), 24 * 60 * 60) + 1,
      retryScope: "address",
    };
  }
  const sent = await sendVerificationLink({ admin: getSupabaseAdmin() }, user.email);
  if (sent.outcome === "failed") {
    logSendFailure("verify-link", undefined);
    return { ok: false, error: "メールを送れませんでした。時間をおいて、もう一度お試しください。", retryAfterSeconds: intervalSeconds, retryScope: "address" };
  }
  // 受付は「送った・届いた」という意味ではない。検証モードでは送っていない(文を分ける)
  return {
    ok: true,
    message: sent.outcome === "accepted" ? VERIFY_LINK_ACCEPTED_TEXT : VERIFY_LINK_SIMULATED_TEXT,
    simulated: sent.outcome !== "accepted",
    retryAfterSeconds: intervalSeconds,
    retryScope: "address",
  };
}

/** 既存のパスワード再設定の保存(画面の動きは今と同じ。保存と本人確認の記録をサーバーで行う)。 */
export async function resetPasswordAction(input: { password: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = passwordSchema.safeParse(input?.password ?? "");
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "パスワードを確認してください。" };
  const supabase = await createClient();
  const result = await resetPasswordWithRecoverySession(verificationDeps(supabase), parsed.data);
  if (!result.ok) {
    if (result.reason === "weak_password" || result.reason === "same_password") return { ok: false, error: VERIFICATION_ERRORS[result.reason] };
    return { ok: false, error: "パスワードの設定に失敗しました。もう一度お試しください。" };
  }
  return { ok: true };
}

/**
 * 次に進む場所。店舗の画面へ進むとき(/dashboard)だけ、ログインの前に開こうとしていた口コミ詳細(cookie。
 * lib/auth/returnPath.ts)に置き換え、使った戻り先は消す。本人確認・店舗の登録などの手順は先に通す。
 */
async function nextStepFor(supabase: Awaited<ReturnType<typeof createClient>>): Promise<NextStep | string> {
  const account = await getAccountState(supabase);
  const salon = account?.sessionTrusted ? await getCurrentSalon(supabase) : null;
  const next = resolveNextStep({ account, salon });
  if (next !== "/dashboard") return next;
  const store = await cookies();
  const returnPath = safeReturnPath(store.get(RETURN_COOKIE)?.value);
  if (returnPath) store.delete(RETURN_COOKIE);
  return withReturnPath(next, returnPath);
}

/** メールのリンクを確かめたあと(/auth/confirm)、次に進む場所。 */
export async function nextStepAction(): Promise<NextStep | string> {
  const supabase = await createClient();
  try {
    return await nextStepFor(supabase);
  } catch {
    return "/login";
  }
}
