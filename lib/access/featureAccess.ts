import { notFound, redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isFeatureServedByMode, type Feature } from "@/lib/appMode";
import { isFeatureEnabledForPlan } from "@/lib/access/plan";
import { hasUserPermission } from "@/lib/access/userPermission";
import { getCurrentSalon } from "@/lib/supabase/queries";
import type { OwnerSalon } from "@/lib/types";

// 最終アクセス判定。APP_MODEがその機能を提供 AND 店舗の契約プランで利用可能
// AND ユーザーに権限がある、の全てを満たした場合のみtrue。3層すべてを
// ここで直列に確認する(どれか1つでも欠けると穴になるため、個別に呼ばず
// 必ずこの関数を経由すること)。
export async function canAccessFeature(
  salon: Pick<OwnerSalon, "id" | "plan">,
  userId: string,
  feature: Feature
): Promise<boolean> {
  if (!isFeatureServedByMode(feature)) return false;
  if (!isFeatureEnabledForPlan(salon.plan, feature)) return false;
  return hasUserPermission(userId, salon.id, feature);
}

/**
 * Page / Server Component・Server Action・Route Handlerの先頭で呼ぶ共通ガード。
 * getCurrentSalon()の解決も兼ねるため、既存の「salonが無ければ/login相当へ」
 * という呼び出しをこれ1つで置き換えられる。権限が無ければ404を返す
 * (ナビゲーションを隠すだけでは直接URL・Server Actionの直叩きを防げない
 * ため、ページだけでなくServer Action/Route Handlerの先頭でも必ず呼ぶこと)。
 */
export async function requireFeatureAccess(
  supabase: SupabaseClient,
  feature: Feature
): Promise<OwnerSalon> {
  const salon = await getCurrentSalon(supabase);
  if (!salon) redirect("/dashboard");

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !(await canAccessFeature(salon, user.id, feature))) notFound();

  return salon;
}
