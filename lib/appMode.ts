// このVercel Projectのデプロイ自体が「提供しうる」機能の天井。ブランド・
// ナビゲーション・そのデプロイが持つ機能一覧を決めるためだけに使う。
//
// 【重要】ここで「提供しうる」と分かっても、個々の店舗がその機能を実際に
// 使ってよいとは限らない -- それは店舗の契約プラン(lib/access/plan.ts)と
// ユーザー権限(lib/access/userPermission.ts)が別途判定する。この3層を
// lib/access/featureAccess.tsのrequireFeatureAccess()で必ず組み合わせて使うこと。
//
// APP_MODEは機密情報ではないため、サーバー専用/クライアント公開の2変数を
// 持って同期がズレるリスクを負うより、NEXT_PUBLIC_APP_MODEひとつに統一する。

export type AppMode = "salonpack" | "reviews";
export type Feature =
  | "reviews"
  | "blog"
  // 予約通知(Gmail監視 -> LINE)。SalonPackのみ。
  | "notifications"
  | "settings"
  // 口コミ465の次期機能(docs/plans/reviews-465-plan.md)。口コミ465単体版から
  // SalonPackへ移っても同じ機能・同じ接続をそのまま使えるよう、両モードに含める。
  // Google連携系はさらに Gate(G1/G2)の確認が取れるまで機能フラグで止める。
  | "review_replies"
  | "google_reviews"
  | "review_notifications";

const REVIEW_SUITE_FEATURES: Feature[] = ["review_replies", "google_reviews", "review_notifications"];

const MODE_FEATURES: Record<AppMode, Feature[]> = {
  reviews: ["reviews", "settings", ...REVIEW_SUITE_FEATURES],
  salonpack: ["reviews", "blog", "notifications", "settings", ...REVIEW_SUITE_FEATURES],
};

export function getAppMode(): AppMode {
  return process.env.NEXT_PUBLIC_APP_MODE === "reviews" ? "reviews" : "salonpack";
}

export function isReviewsOnly(): boolean {
  return getAppMode() === "reviews";
}

export function isFeatureServedByMode(feature: Feature): boolean {
  return MODE_FEATURES[getAppMode()].includes(feature);
}
