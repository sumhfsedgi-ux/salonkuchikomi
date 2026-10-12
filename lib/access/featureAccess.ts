import { notFound, redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isFeatureServedByMode, type Feature } from "@/lib/appMode";
import { isFeatureEnabledForPlan } from "@/lib/access/plan";
import { hasUserPermission } from "@/lib/access/userPermission";
import { resolveFeatureAccess, type FeatureAccessStatus } from "@/lib/features/access";
import { loadFeatureAccessInput } from "@/lib/features/accessInput";
import { FEATURE_REGISTRY } from "@/lib/features/registry";
import { getCurrentSalon } from "@/lib/supabase/queries";
import type { OwnerSalon } from "@/lib/types";

// 最終アクセス判定。ホーム・メニューの判定(lib/features/access.ts の resolveFeatureAccess)と同じ材料を使う:
//   - 機能の定義がある機能: resolveFeatureAccess(DB の利用権限・APP_MODE・提供状況)が allowed
//   - 定義の無い機能(サロン設定など): APP_MODE が提供 AND 契約プランで利用可能
//   - そのうえで、ユーザーに権限がある
// 全層をここで直列に確認する(どれか1つでも欠けると穴になるため、個別に呼ばず
// 必ずこの関数を経由すること)。
export async function featureAccessStatus(
  salon: Pick<OwnerSalon, "id" | "plan">,
  userId: string,
  feature: Feature
): Promise<FeatureAccessStatus> {
  const definitions = FEATURE_REGISTRY.filter((def) => def.accessFeature === feature);
  let status: FeatureAccessStatus;
  if (definitions.length > 0) {
    const input = await loadFeatureAccessInput(salon);
    const statuses = definitions.map((def) => resolveFeatureAccess(def, input).status);
    status = statuses.includes("allowed") ? "allowed" : statuses[0];
  } else {
    status = isFeatureServedByMode(feature) && isFeatureEnabledForPlan(salon.plan, feature) ? "allowed" : "not_allowed";
  }
  if (status === "allowed" && !(await hasUserPermission(userId, salon.id, feature))) return "not_allowed";
  return status;
}

export async function canAccessFeature(
  salon: Pick<OwnerSalon, "id" | "plan">,
  userId: string,
  feature: Feature
): Promise<boolean> {
  return (await featureAccessStatus(salon, userId, feature)) === "allowed";
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
  const result = await requireFeaturePage(supabase, feature);
  if (result.status !== "allowed") notFound();
  return result.salon;
}

/**
 * 画面(Page)用。運営が利用を停止している(suspended)ときは404にせず、停止中の画面を出せるよう店舗と状態を返す
 * (口コミプランは口コミの画面へ直接進むため、404 やリダイレクトの繰り返しにしない)。それ以外の利用できない状態は404。
 * 停止中でも、その機能のデータ・操作には触れない(呼び出し側は停止中の案内だけを出す)。
 */
export async function requireFeaturePage(
  supabase: SupabaseClient,
  feature: Feature
): Promise<{ status: "allowed" | "suspended"; salon: OwnerSalon }> {
  const salon = await getCurrentSalon(supabase);
  if (!salon) redirect("/dashboard");

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) notFound();
  const status = await featureAccessStatus(salon, user.id, feature);
  if (status !== "allowed" && status !== "suspended") notFound();
  return { status, salon };
}
