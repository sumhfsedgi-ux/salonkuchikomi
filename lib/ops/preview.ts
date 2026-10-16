import type { SalonPlan } from "@/lib/access/plan";
import type { EntitlementReason, FeatureLifecycle, OverrideMode } from "@/lib/features/entitlements";
import { isServiceActive, type ServiceStatus } from "@/lib/onboarding/serviceStatus";

// 管理画面の確認ダイアログで「保存したらどうなるか」を見せるための予測(DBに触れない)。
// 判定の順は DB の salon_feature_access(supabase/migrations/0024)と同じ。保存の可否・保存後の値は DB が決め、
// 保存のあとは DB から読み直して表示する(この予測で保存はしない)。DB と一致することは
// scripts/localdb/entitlements.test.ts で全組み合わせを確かめる。

export interface CatalogEntry {
  lifecycle: FeatureLifecycle;
  hasRuntime: boolean;
}

/** プランごとの対象機能と標準({ salonpack: { blog: true } } = salonpack は blog の対象で、標準で使える)。 */
export type PlanRules = Record<SalonPlan, Partial<Record<string, boolean>>>;

export function previewAccess(
  catalog: CatalogEntry | undefined,
  rules: PlanRules,
  plan: SalonPlan,
  key: string,
  override: OverrideMode,
): { allowed: boolean; reason: EntitlementReason } {
  if (!catalog) return { allowed: false, reason: "unknown_feature" };
  const rule = rules[plan]?.[key];
  if (rule === undefined) return { allowed: false, reason: "not_in_plan" };
  if (catalog.lifecycle !== "available") return { allowed: false, reason: `lifecycle_${catalog.lifecycle}` as EntitlementReason };
  if (override === "deny") return { allowed: false, reason: "override_deny" };
  if (override === "allow") return { allowed: true, reason: "override_allow" };
  return rule ? { allowed: true, reason: "plan_default" } : { allowed: false, reason: "plan_default_off" };
}

/**
 * 利用区分まで含めた予測(DB の salon_feature_access と同じ: 本来なら利用可でも、利用中の区分でなければ service_pending)。
 * 利用区分の変更・本登録の確認画面で「変更・登録のあとに使える機能」を見せるのに使う。DB と一致することは
 * scripts/localdb/onboarding.test.ts で全組み合わせを確かめる。
 */
export function previewServiceAccess(
  catalog: CatalogEntry | undefined,
  rules: PlanRules,
  plan: SalonPlan,
  key: string,
  override: OverrideMode,
  serviceStatus: ServiceStatus,
): { allowed: boolean; reason: EntitlementReason } {
  const base = previewAccess(catalog, rules, plan, key, override);
  if (base.allowed && !isServiceActive(serviceStatus)) return { allowed: false, reason: "service_pending" };
  return base;
}
