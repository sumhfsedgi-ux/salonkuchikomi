import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resendSignupConfirmation, sendSignup, type AuthEmailDeps, type AuthEmailOutcome } from "@/lib/onboarding/authEmail";

// お客様自身の新規登録(サーバー)。アドレスの状態で分け、画面への応答はどの場合も同じにする(第三者のアカウントの有無を漏らさない)。
//   アカウントが無い ........ 新しく登録する(Confirm signup)。本人確認の手続きは「入れ直す/新しく設定する」(confirm_or_set)
//   未確認のアカウントがある .. パスワードには触れず、確認メールを送り直す。本人確認は「新しく設定する」(set_new)
//                               (先に第三者が付けた可能性のあるパスワードを、本人確認に使わせない)
//   確認済みのアカウントがある  何もしない(ログイン・パスワード再設定を案内する共通の文で足りる)
// 未認証の人の操作で、既存のパスワードを変えたり無効にしたりはしない(ユーザーの決定)。

export interface SignupLookupRow {
  user_id: string;
  email_confirmed: boolean;
  created_at: string;
  verified: boolean;
}

export type SignupOutcome = "requested" | "already_registered" | "resent" | "skipped" | "simulated" | "failed";

async function lookup(admin: SupabaseClient, email: string): Promise<SignupLookupRow[]> {
  const { data, error } = await admin.rpc("account_lookup_for_signup", { p_email: email });
  if (error) throw new Error("アカウントの確認に失敗しました。");
  return (data ?? []) as SignupLookupRow[];
}

async function setRequirement(admin: SupabaseClient, userId: string, mode: "confirm_or_set" | "set_new", reason: string, onlyIfAbsent: boolean) {
  const { error } = await admin.rpc("account_requirement_set", {
    p_user_id: userId,
    p_mode: mode,
    p_reason: reason,
    p_only_if_absent: onlyIfAbsent,
  });
  if (error) throw new Error("登録の記録に失敗しました。");
}

function summarize(o: AuthEmailOutcome): SignupOutcome {
  if (o.outcome === "failed") return "failed";
  if (o.outcome === "simulated") return "simulated";
  if (o.outcome === "skipped") return "skipped";
  return "requested";
}

export async function requestSignup(deps: AuthEmailDeps, email: string, password: string): Promise<{ result: SignupOutcome; failureCode?: string }> {
  const before = await lookup(deps.admin, email);
  if (before.length === 0) {
    const sent = await sendSignup(deps, email, password);
    if (sent.outcome === "failed") return { result: "failed", failureCode: sent.code };
    if (sent.outcome === "skipped") return { result: "skipped" };
    // 登録のあとに作られたアカウントだけを「新しく登録した」とする。同じ瞬間に別の経路で作られていた場合は set_new のまま。
    const after = await lookup(deps.admin, email);
    const created = after.find((r) => !r.email_confirmed);
    if (created) {
      const fresh = sent.userId === created.user_id;
      await setRequirement(deps.admin, created.user_id, fresh ? "confirm_or_set" : "set_new", "self_signup", true);
    }
    return { result: summarize(sent) };
  }
  const unconfirmed = before.find((r) => !r.email_confirmed);
  if (unconfirmed && before.length === 1) {
    await setRequirement(deps.admin, unconfirmed.user_id, "set_new", "self_signup_repeat", false);
    const resent = await resendSignupConfirmation(deps, email);
    if (resent.outcome === "failed") return { result: "failed", failureCode: resent.code };
    return { result: resent.outcome === "accepted" ? "resent" : summarize(resent) };
  }
  return { result: "already_registered" };
}

/** ログイン画面などからの確認メールの再送。未確認のアカウントがあるときだけ送る(応答は共通)。 */
export async function requestConfirmationResend(deps: AuthEmailDeps, email: string): Promise<{ result: SignupOutcome }> {
  const rows = await lookup(deps.admin, email);
  const unconfirmed = rows.length === 1 ? rows.find((r) => !r.email_confirmed) : undefined;
  if (!unconfirmed) return { result: "already_registered" };
  const resent = await resendSignupConfirmation(deps, email);
  return { result: resent.outcome === "accepted" ? "resent" : summarize(resent) };
}
