import "server-only";
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

// 運営がサロンを本登録するときの、紐付け先のアカウント(ログイン用のメールアドレス)。運営がパスワードを作る・見る機能は無い。
//   新しいアドレス ................. パスワード無しで作る(未確認)。本人が招待のリンクからパスワードを設定する(set_new)
//   未確認の既存のアカウント ....... 運営が明示的に紐付けるときだけ、今のパスワードを乱数にして無効にする(set_new)。
//                                    本人確認が済んでいないため、パスワードを第三者が付けた可能性がある(ユーザーの決定)
//   確認済み・本人確認済み ......... そのまま紐付ける。パスワードは変えない
//   確認済みで本人確認がまだ ....... 紐付けない(パスワードを変えずに安全を保てない。本人がログイン画面から本人確認を済ませる)
//   運営の管理者・店舗を持つ ....... 紐付けない

export type LoginAccount =
  | { kind: "new" }
  | { kind: "unconfirmed"; userId: string }
  | { kind: "verified"; userId: string }
  | { kind: "blocked"; reason: "operator" | "has_salon" | "unverified" | "ambiguous"; salonId?: string; salonName?: string };

interface LookupResult {
  result: "found" | "none" | "ambiguous" | "not_operator";
  user_id?: string;
  email_confirmed?: boolean;
  verified?: boolean;
  is_operator?: boolean;
  salon_id?: string | null;
  salon_name?: string | null;
}

export async function lookupLoginAccount(admin: SupabaseClient, operatorId: string, email: string): Promise<LoginAccount> {
  const { data, error } = await admin.rpc("admin_account_lookup", { p_actor_user_id: operatorId, p_email: email });
  if (error) throw new Error("アカウントの確認に失敗しました。");
  const r = data as LookupResult;
  if (r.result === "not_operator") throw new Error("not_operator");
  if (r.result === "none") return { kind: "new" };
  if (r.result === "ambiguous") return { kind: "blocked", reason: "ambiguous" };
  if (r.is_operator) return { kind: "blocked", reason: "operator" };
  if (r.salon_id) return { kind: "blocked", reason: "has_salon", salonId: r.salon_id, salonName: r.salon_name ?? undefined };
  if (!r.email_confirmed) return { kind: "unconfirmed", userId: r.user_id! };
  if (!r.verified) return { kind: "blocked", reason: "unverified" };
  return { kind: "verified", userId: r.user_id! };
}

/** 推測できない長さの乱数のパスワード(誰にも知らせない。パスワードの規則を満たす文字を足す)。 */
export function unusablePassword(): string {
  return `${randomBytes(48).toString("base64url")}Aa1!`;
}

async function requireSetNew(admin: SupabaseClient, userId: string, reason: "operator_invite" | "operator_rebind") {
  const { error } = await admin.rpc("account_requirement_set", { p_user_id: userId, p_mode: "set_new", p_reason: reason, p_only_if_absent: false });
  if (error) throw new Error("アカウントの記録に失敗しました。");
}

export type PreparedAccount =
  | { ok: true; userId: string; kind: "new" | "unconfirmed" | "verified" }
  | { ok: false; account: Extract<LoginAccount, { kind: "blocked" }> };

/** 本登録の直前に、紐付け先のアカウントを用意する(何度呼んでも同じ状態になる)。 */
export async function prepareLoginAccount(admin: SupabaseClient, operatorId: string, email: string): Promise<PreparedAccount> {
  let account = await lookupLoginAccount(admin, operatorId, email);
  if (account.kind === "new") {
    const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: false });
    if (error) {
      // 同時の操作で、ほかの処理が先に作った。もう一度調べる。
      if (error.code === "email_exists" || error.code === "user_already_exists") account = await lookupLoginAccount(admin, operatorId, email);
      else throw new Error("アカウントの作成に失敗しました。");
    } else {
      await requireSetNew(admin, data.user.id, "operator_invite");
      return { ok: true, userId: data.user.id, kind: "new" };
    }
  }
  if (account.kind === "blocked") return { ok: false, account };
  if (account.kind === "unconfirmed") {
    const { error } = await admin.auth.admin.updateUserById(account.userId, { password: unusablePassword() });
    if (error) throw new Error("アカウントの準備に失敗しました。");
    await requireSetNew(admin, account.userId, "operator_rebind");
    return { ok: true, userId: account.userId, kind: "unconfirmed" };
  }
  if (account.kind === "new") throw new Error("アカウントの作成に失敗しました。");
  return { ok: true, userId: account.userId, kind: "verified" };
}
