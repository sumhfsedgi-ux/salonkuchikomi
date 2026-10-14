import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getAuthedUser } from "@/lib/supabase/queries";
import { getAccountState } from "@/lib/onboarding/accountState";

// 運営管理(/ops)の利用者の判定。メールアドレスの文字列ではなく、サーバーで認証したユーザーの ID
// (supabase.auth.getUser())が operator_admins に登録されていて、取り消されていないかで判定する。
// operator_admins はブラウザのロールから読み書きできない(0024)。登録は運営が CLI・SQL Editor で行う。

/** そのユーザー ID が有効な管理者か(リクエストごとに1回だけ読む)。読めなければ管理者ではないとして扱う。 */
export const isOperatorUser = cache(async (userId: string): Promise<boolean> => {
  const { data, error } = await getSupabaseAdmin()
    .from("operator_admins")
    .select("user_id")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .maybeSingle();
  if (error) return false;
  return Boolean(data);
});

export interface Operator {
  userId: string;
  email: string | null;
}

/** 管理者でなければ null(画面の存在を知らせないため、呼び出し側は 404 にする)。 */
export async function getOperator(supabase?: SupabaseClient): Promise<Operator | null> {
  const client = supabase ?? (await createClient());
  const user: User | null = await getAuthedUser(client);
  if (!user) return null;
  if (!(await isOperatorUser(user.id))) return null;
  // サインアウトしたセッション・本人確認より前のセッションの古いトークンでは、管理画面を使わせない(0025。DB で判定)。
  const account = await getAccountState(client).catch(() => null);
  if (!account?.sessionTrusted) return null;
  return { userId: user.id, email: user.email ?? null };
}

/**
 * /ops の layout・各ページ・各 Server Action の先頭で呼ぶ。管理者でなければ 404(URL・API の直接呼び出しでも同じ)。
 * 戻り値の userId だけを、保存の関数に「操作した管理者」として渡す(ブラウザから受け取った値は使わない)。
 */
export async function requireOperator(): Promise<Operator> {
  const operator = await getOperator();
  if (!operator) notFound();
  return operator;
}
