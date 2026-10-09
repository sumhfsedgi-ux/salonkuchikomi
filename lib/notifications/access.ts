import "server-only";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon } from "@/lib/supabase/queries";
import { canAccessFeature } from "@/lib/access/featureAccess";
import type { OwnerSalon } from "@/lib/types";

// 予約通知の画面の Server Action で共通の入り口(Server Action のファイルから export すると、それ自体が
// 呼び出せる Server Action になってしまうため、ここに置く)。
// 認証済みユーザー → getCurrentSalon()(そのユーザーがオーナーの店舗)→ 機能の利用権(APP_MODE・契約・権限)の順に確かめる。
// 店舗の id はクライアントから受け取らない。
export async function resolveAccessibleSalon(): Promise<
  { ok: true; salon: OwnerSalon; userId: string } | { ok: false; error: string }
> {
  const supabase = await createClient();
  const salon = await getCurrentSalon(supabase);
  if (!salon) return { ok: false, error: "ログインが必要です。" };

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !(await canAccessFeature(salon, user.id, "notifications"))) {
    return { ok: false, error: "この機能は利用できません。" };
  }
  return { ok: true, salon, userId: user.id };
}
