import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isEmailLinkSession, parseSessionClaims, type SessionClaims } from "@/lib/onboarding/sessionClaims";

// 本人確認の手続き(/auth/verify・パスワード再設定)のサーバー側。記録だけを行う入口は作らない。
// 1つの処理の中で、次の順に行う(どこかで失敗したら、それより後は行わない)。
//   1. 検証済みの JWT から session_id と認証方法を読み、メールのリンクで得たセッションかを確かめる
//   2. 本人の操作をサーバーで行い、成功をサーバーで確かめる
//        入れ直す: セッションを持たないクライアントで、登録済みのパスワードを照合する(照合で作ったセッションはすぐ消す)
//        新しく設定する: このリクエストのセッションで updateUser する
//   3. service_role の account_verification_record で記録する(DB でも、メール確認済み・本人のセッション・メールのリンクの
//      認証方法かを確かめる。最初の1回だけ記録する)
//   4. ほかのセッションをサインアウトする(安全性はこれに頼らない。DB の current_session_trusted が、本人確認より前の
//      セッションを信頼しない)
// パスワード・トークンはログに出さない。エラーは分類した理由だけを返す。

export type VerificationFailure =
  | "not_signed_in"
  | "not_email_link"
  | "password_mismatch"
  | "weak_password"
  | "same_password"
  | "update_failed"
  | "session_expired"
  | "record_failed"
  | "email_unconfirmed";

export type VerificationResult = { ok: true; status: "recorded" | "already_verified" } | { ok: false; reason: VerificationFailure };

export interface VerificationDeps {
  /** このリクエストのセッションのクライアント(サーバーでは cookie から作ったもの)。 */
  userClient: SupabaseClient;
  /** service_role のクライアント。 */
  admin: SupabaseClient;
  /** セッションを持たない anon のクライアントを、呼ぶたびに新しく作る(照合のため)。 */
  newAnonClient: () => SupabaseClient;
}

/** 検証済みの JWT の値(署名の確認は getClaims が行う)。読めなければ null。 */
export async function readSessionClaims(client: SupabaseClient): Promise<SessionClaims | null> {
  try {
    const { data, error } = await client.auth.getClaims();
    if (error || !data?.claims) return null;
    return parseSessionClaims(data.claims as Record<string, unknown>);
  } catch {
    return null;
  }
}

async function requireEmailLinkSession(client: SupabaseClient): Promise<SessionClaims | VerificationFailure> {
  const claims = await readSessionClaims(client);
  if (!claims) return "not_signed_in";
  if (!isEmailLinkSession(claims.methods)) return "not_email_link";
  return claims;
}

function updateFailure(error: { code?: string; status?: number; name?: string }): VerificationFailure {
  if (error.code === "weak_password") return "weak_password";
  if (error.code === "same_password") return "same_password";
  // このセッションが消えている(別の場所でパスワードが変わった・サインアウトした)。Supabase Auth は、ほかの場所で
  // パスワードを変えると、それ以外のセッションを消す(testdb で確認)。新しいメールのリンクから手続きし直す。
  // supabase-js は、サーバーが session_not_found を返すと、セッションを捨てて AuthSessionMissingError を返す(testdb で確認)。
  if (error.code === "session_not_found" || error.name === "AuthSessionMissingError" || error.status === 401 || error.status === 403) {
    return "session_expired";
  }
  return "update_failed";
}

async function recordAndSignOutOthers(
  deps: VerificationDeps,
  claims: SessionClaims,
  method: "password_confirmed" | "password_set",
): Promise<VerificationResult> {
  const { data, error } = await deps.admin.rpc("account_verification_record", {
    p_user_id: claims.userId,
    p_session_id: claims.sessionId,
    p_method: method,
  });
  if (error) return { ok: false, reason: "record_failed" };
  if (data === "recorded" || data === "already_verified") {
    await signOutOthers(deps.userClient);
    return { ok: true, status: data };
  }
  if (data === "email_unconfirmed") return { ok: false, reason: "email_unconfirmed" };
  // JWT ではメールのリンクのセッションだったのに、DB で見つからない = 処理の途中でセッションが消えた
  // (別の場所でのパスワードの変更など)。新しいリンクから手続きし直してもらう。
  if (data === "not_email_link") return { ok: false, reason: "session_expired" };
  return { ok: false, reason: "record_failed" };
}

async function signOutOthers(client: SupabaseClient): Promise<void> {
  try {
    await client.auth.signOut({ scope: "others" });
  } catch {
    // 失敗しても、本人確認より前のセッションは DB で信頼されない(current_session_trusted)。
  }
}

/** 新しいパスワードを設定して本人確認を記録する。 */
export async function verifyBySettingPassword(deps: VerificationDeps, password: string): Promise<VerificationResult> {
  const claims = await requireEmailLinkSession(deps.userClient);
  if (typeof claims === "string") return { ok: false, reason: claims };
  const { error } = await deps.userClient.auth.updateUser({ password });
  if (error) return { ok: false, reason: updateFailure(error) };
  return recordAndSignOutOthers(deps, claims, "password_set");
}

/** 登録済みのパスワードを入れ直して本人確認を記録する(照合に失敗したら記録しない)。 */
export async function verifyByCurrentPassword(deps: VerificationDeps, password: string): Promise<VerificationResult> {
  const claims = await requireEmailLinkSession(deps.userClient);
  if (typeof claims === "string") return { ok: false, reason: claims };
  if (!claims.email) return { ok: false, reason: "password_mismatch" };
  const anon = deps.newAnonClient();
  const { data, error } = await anon.auth.signInWithPassword({ email: claims.email, password });
  const matched = !error && data.user?.id === claims.userId;
  if (data?.session) {
    try {
      await anon.auth.signOut({ scope: "local" });
    } catch {
      // 照合のためのセッション。消せなくても、本人確認より前に作られたため信頼されない。
    }
  }
  if (!matched) return { ok: false, reason: "password_mismatch" };
  return recordAndSignOutOthers(deps, claims, "password_confirmed");
}

/**
 * パスワード再設定(既存の画面の保存をサーバーに移したもの)。設定はどのアカウントでも行い、
 * 本人確認の記録は「メールのリンクで得たセッション」のときだけ行う(記録は最初の1回だけ。すでにあれば変えない)。
 */
export async function resetPasswordWithRecoverySession(
  deps: VerificationDeps,
  password: string,
): Promise<{ ok: true; verified: boolean } | { ok: false; reason: VerificationFailure }> {
  const claims = await readSessionClaims(deps.userClient);
  if (!claims) return { ok: false, reason: "not_signed_in" };
  const { error } = await deps.userClient.auth.updateUser({ password });
  if (error) return { ok: false, reason: updateFailure(error) };
  // パスワード再設定のリンクのセッションの認証方法は、検証の方式で変わる(token_hash の検証は otp、
  // 既存の画面の PKCE の流れは recovery。どちらも testdb で確認)。どちらもメールのリンクで得たセッション。
  if (!isEmailLinkSession(claims.methods)) {
    await signOutOthers(deps.userClient);
    return { ok: true, verified: false };
  }
  const recorded = await recordAndSignOutOthers(deps, claims, "password_set");
  if (!recorded.ok) {
    // パスワードは設定できている。本人確認の記録だけ残せなかった(次のログインで本人確認の手続きに進む)。
    await signOutOthers(deps.userClient);
    return { ok: true, verified: false };
  }
  return { ok: true, verified: true };
}
