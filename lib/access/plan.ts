import type { Feature } from "@/lib/appMode";

// 店舗が実際に契約している機能(店舗単位の契約プラン)。APP_MODEとは独立した軸
// -- APP_MODEは「このデプロイが提供しうる機能」、こちらは「この店舗が
// お金を払って使える機能」。SalonPack側URLを知っているだけの店舗が、契約
// していないブログ・予約通知を使えてしまわないよう、必ずこちらも判定する。
//
// 【重要】planの値は必ず人間(管理者)が確定させる。APP_MODEやユーザー自身の
// 操作から自動的に'salonpack'を付与してはならない -- 新規店舗は常に'reviews'
// から始まる(app/dashboard/actions.tsのcreateSalonAction参照)。

export type SalonPlan = "reviews" | "salonpack";

const PLAN_FEATURES: Record<SalonPlan, Feature[]> = {
  reviews: ["reviews", "settings"],
  salonpack: ["reviews", "blog", "notifications", "settings"],
};

export function isFeatureEnabledForPlan(plan: SalonPlan, feature: Feature): boolean {
  return PLAN_FEATURES[plan].includes(feature);
}
