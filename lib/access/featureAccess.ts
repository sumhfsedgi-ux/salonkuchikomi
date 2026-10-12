import { notFound, redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isFeatureServedByMode, type Feature } from "@/lib/appMode";
import { isFeatureEnabledForPlan } from "@/lib/access/plan";
import { hasUserPermission } from "@/lib/access/userPermission";
import { featureAccessInputFor, isFeatureAvailable } from "@/lib/features/access";
import { FEATURE_REGISTRY } from "@/lib/features/registry";
import { getCurrentSalon } from "@/lib/supabase/queries";
import type { OwnerSalon } from "@/lib/types";

// 最終アクセス判定。APP_MODEがその機能を提供 AND 店舗の契約プランで利用可能
// AND 提供中(準備中の機能ではない)AND ユーザーに権限がある、の全てを満たした場合のみtrue。
// ホーム・メニューの判定(lib/features/access.ts の resolveFeatureAccess)と同じ材料を使う。
// 全層をここで直列に確認する(どれか1つでも欠けると穴になるため、個別に呼ばず
// 必ずこの関数を経由すること)。
export async function canAccessFeature(
  salon: Pick<OwnerSalon, "id" | "plan">,
  userId: string,
  feature: Feature
): Promise<boolean> {
  if (!isFeatureServedByMode(feature)) return false;
  if (!isFeatureEnabledForPlan(salon.plan, feature)) return false;
  const input = featureAccessInputFor(salon);
  const definitions = FEATURE_REGISTRY.filter((def) => def.accessFeature === feature);
  if (definitions.length > 0 && !definitions.some((def) => isFeatureAvailable(def, input))) return false;
  return hasUserPermission(userId, salon.id, feature);
}

/**
 * Server Action など、リダイレクトせずにエラーを返したい入口で使う。ログイン中のユーザーの店舗を解決し、
 * その機能を使えなければ、利用できない旨のエラー文を返す。
 */
export async function resolveFeatureSalon(
  supabase: SupabaseClient,
  feature: Feature
): Promise<{ ok: true; salon: OwnerSalon; userId: string } | { ok: false; error: string }> {
  const salon = await getCurrentSalon(supabase);
  if (!salon) return { ok: false, error: "店舗情報が見つかりません。" };
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !(await canAccessFeature(salon, user.id, feature))) return { ok: false, error: "この機能は利用できません。" };
  return { ok: true, salon, userId: user.id };
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
