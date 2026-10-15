import type { SalonPlan } from "@/lib/access/plan";
import type { FeatureKey } from "@/lib/features/registry";
import type { FeatureLifecycle, OverrideMode, SalonEntitlements } from "@/lib/features/entitlements";
import { previewAccess, type CatalogEntry, type PlanRules } from "@/lib/ops/preview";

// 単体テスト用: DB(supabase/migrations/0024)の機能カタログ・プランの規則の初期値の写し。
// 本番の判定は DB の関数だけが行う(アプリは結果を読むだけ)。この写しが DB の初期値と一致すること、
// 判定の順(previewAccess)が DB と一致することは scripts/localdb/entitlements.test.ts で確かめる。

export const CATALOG_SEED: Record<"reviews" | "blog" | "reservation_notifications" | "google_reviews", CatalogEntry> = {
  reviews: { lifecycle: "available", hasRuntime: false },
  blog: { lifecycle: "available", hasRuntime: false },
  reservation_notifications: { lifecycle: "available", hasRuntime: true },
  // 0030: 届いた口コミは準備中。プランの対象だが標準では使えない(店舗ごとの許可で使う)。
  google_reviews: { lifecycle: "coming_soon", hasRuntime: false },
};

export const PLAN_RULES_SEED: PlanRules = {
  reviews: { reviews: true, google_reviews: false },
  salonpack: { reviews: true, blog: true, reservation_notifications: true, google_reviews: false },
};

export function entitlementsFor(
  plan: SalonPlan,
  opts: {
    overrides?: Partial<Record<FeatureKey, OverrideMode>>;
    lifecycle?: Partial<Record<FeatureKey, FeatureLifecycle>>;
    holds?: FeatureKey[];
  } = {},
): SalonEntitlements {
  const out: SalonEntitlements = {};
  for (const [key, seed] of Object.entries(CATALOG_SEED) as Array<[FeatureKey, CatalogEntry]>) {
    const lifecycle = opts.lifecycle?.[key] ?? seed.lifecycle;
    const rule = PLAN_RULES_SEED[plan][key];
    const override = opts.overrides?.[key] ?? "inherit";
    const { allowed, reason } = previewAccess({ ...seed, lifecycle }, PLAN_RULES_SEED, plan, key, override);
    out[key] = {
      key,
      lifecycle,
      hasRuntime: seed.hasRuntime,
      inPlan: rule !== undefined,
      defaultEnabled: rule ?? false,
      override,
      allowed,
      reason,
      holdOpen: opts.holds?.includes(key) ?? false,
    };
  }
  return out;
}
