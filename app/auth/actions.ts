"use server";

import { headers } from "next/headers";
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
  readSessionClaims,
  resetPasswordWithRecoverySession,
  verifyByCurrentPassword,
  verifyBySettingPassword,
  type VerificationFailure,
} from "@/lib/onboarding/verification";
import { hashIp } from "@/lib/reviewGeneration/rateLimit";

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

export type FieldResult = { ok: true; message?: string; simulated?: boolean } | { ok: false; error?: string; fieldErrors?: Record<string, string> };

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

/** 新規登録・確認メールの再送の共通の応答(送らなかった場合とも食い違わない文)。 */
const SIGNUP_ACCEPTED_MESSAGE =
  "ご入力のメールアドレスでお手続きできる場合は、確認のメールをお送りしました。メールのリンクを開いて、登録を続けてください。" +
  "すでに登録済みの場合はメールは届きません。ログイン、またはパスワードの再設定をお試しください。";

export async function signupAction(input: { email: string; password: string; passwordConfirm: string }): Promise<FieldResult> {
  if (!isSelfSignupEnabled()) return { ok: false, error: "現在、新規登録は受け付けていません。" };
  const fieldErrors: Record<string, string> = {};
  const email = emailSchema.safeParse(input?.email ?? "");
  if (!email.success) fieldErrors.email = email.error.issues[0]?.message ?? "メールアドレスを確認してください。";
  const password = passwordSchema.safeParse(input?.password ?? "");
  if (!password.success) fieldErrors.password = password.error.issues[0]?.message ?? "パスワードを確認してください。";
  else if (input.password !== input.passwordConfirm) fieldErrors.passwordConfirm = "パスワードが一致しません。";
  if (Object.keys(fieldErrors).length > 0 || !email.success || !password.success) return { ok: false, fieldErrors };

  const key = await clientKey();
  if (!(await withinLimit(`signup:ip:${key}`, 60 * 60, 10)) || !(await withinLimit(`signup:email:${hashIp(email.data)}`, 60, 1))) {
    return { ok: false, error: "短い間に操作が続いています。少し時間をおいてから、もう一度お試しください。" };
  }
  try {
    const result = await requestSignup({ admin: getSupabaseAdmin() }, email.data, password.data);
    if (result.result === "failed" && result.failureCode === "rate_limited") {
      return { ok: false, error: "短い間に操作が続いています。少し時間をおいてから、もう一度お試しください。" };
    }
    if (result.result === "failed") {
      return { ok: false, error: "登録を受け付けられませんでした。時間をおいて、もう一度お試しください。" };
    }
    return { ok: true, message: SIGNUP_ACCEPTED_MESSAGE, simulated: resolveAuthEmailPolicy().mode === "simulated" };
  } catch {
    return { ok: false, error: "登録を受け付けられませんでした。時間をおいて、もう一度お試しください。" };
  }
}

export async function resendConfirmationAction(input: { email: string }): Promise<FieldResult> {
  const email = emailSchema.safeParse(input?.email ?? "");
  if (!email.success) return { ok: false, fieldErrors: { email: email.error.issues[0]?.message ?? "メールアドレスを確認してください。" } };
  const key = await clientKey();
  if (!(await withinLimit(`resend:ip:${key}`, 60 * 60, 10)) || !(await withinLimit(`resend:email:${hashIp(email.data)}`, 60, 1))) {
    return { ok: false, error: "短い間に操作が続いています。少し時間をおいてから、もう一度お試しください。" };
  }
  try {
    await requestConfirmationResend({ admin: getSupabaseAdmin() }, email.data);
  } catch {
    // 応答は共通にする(失敗の詳細は出さない)
  }
  return {
    ok: true,
    message: "ご入力のメールアドレスが確認待ちの場合は、確認のメールをお送りしました。数分たっても届かない場合は、迷惑メールのフォルダもご確認ください。",
    simulated: resolveAuthEmailPolicy().mode === "simulated",
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
  { ok: true; next: NextStep } | { ok: false; error?: string; fieldErrors?: Record<string, string>; reason?: VerificationFailure }
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
  if (!(await withinLimit(`verify-link:user:${user.id}`, 60, 1)) || !(await withinLimit(`verify-link:user-day:${user.id}`, 24 * 60 * 60, 5))) {
    return { ok: false, error: "続けて送ることはできません。少し時間をおいてから、もう一度お試しください。" };
  }
  const sent = await sendVerificationLink({ admin: getSupabaseAdmin() }, user.email);
  if (sent.outcome === "failed") return { ok: false, error: "メールを送れませんでした。時間をおいて、もう一度お試しください。" };
  return {
    ok: true,
    message: "登録のメールアドレスに、本人確認のメールをお送りしました。メールのリンクを開いて、手続きを続けてください。",
    simulated: sent.outcome !== "accepted",
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

async function nextStepFor(supabase: Awaited<ReturnType<typeof createClient>>): Promise<NextStep> {
  const account = await getAccountState(supabase);
  const salon = account?.sessionTrusted ? await getCurrentSalon(supabase) : null;
  return resolveNextStep({ account, salon });
}

/** メールのリンクを確かめたあと(/auth/confirm)、次に進む場所。 */
export async function nextStepAction(): Promise<NextStep> {
  const supabase = await createClient();
  try {
    return await nextStepFor(supabase);
  } catch {
    return "/login";
  }
}
