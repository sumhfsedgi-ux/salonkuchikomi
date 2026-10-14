import { isFeatureServedByMode, isReviewsOnly } from "@/lib/appMode";
import { isFeatureEnabledForPlan, type SalonPlan } from "@/lib/access/plan";
import { FEATURE_REGISTRY, type FeatureDefinition, type FeatureKey } from "@/lib/features/registry";
import type { SalonEntitlements } from "@/lib/features/entitlements";

// 機能ごとの利用権限と、契約プランごとの画面の作りを、1か所で判定する(DBに触れない)。
// ホーム・メニュー・サーバー側の入口(lib/access/featureAccess.ts の canAccessFeature)は
// すべてここの判定を使う。次の2つは別の軸として扱い、混同しない:
//   - 機能ごとの利用権限:
//       entitlement が "catalog" の機能(口コミ・ブログ・予約通知)は、DB の判定(salon_feature_access。対象プラン →
//       提供状態 → 個別設定 → プラン内の標準の順)をそのまま使う。通知処理の DB 関数と同じ結果になる。
//       そのうえで、このデプロイが提供する機能か(APP_MODE)を確かめる。
//       "code" の機能(届いた口コミ)は、今まで通り 契約(salons.plan)× APP_MODE → 提供状況 の順に判定する。
//   - 画面の作り: SalonPack は機能一覧のホーム、口コミプランは口コミの設定画面を直接出す(個別設定では変えない)
// お客様の表示設定は、ここでは扱わない(利用権限を広げも狭めもしない)。

export type PlanExperience = "feature_home" | "reviews_direct";

/** 契約プランごとの画面の作り。APP_MODE=reviews のデプロイは、契約にかかわらず口コミの画面を直接出す。 */
export function getPlanExperience(plan: SalonPlan): PlanExperience {
  if (isReviewsOnly()) return "reviews_direct";
  return plan === "salonpack" ? "feature_home" : "reviews_direct";
}

export interface FeatureAccessInput {
  plan: SalonPlan;
  /**
   * 利用区分が利用中か(lib/onboarding/serviceStatus.ts)。"catalog" の機能は DB の判定に含まれる(理由 service_pending)。
   * "code" の機能(届いた口コミ)は DB を通らないため、ここで同じ条件を足す。
   */
  serviceActive: boolean;
  /** 届いた口コミの提供を始めているか(GOOGLE_REVIEWS_OAUTH_ENABLED)。 */
  googleReviewsAvailable: boolean;
  /** DB から読んだ、店舗の機能ごとの利用権限(lib/features/loadEntitlements.ts)。無い機能は利用不可として扱う。 */
  entitlements: SalonEntitlements;
}

/**
 * - allowed: 利用できる
 * - not_allowed: 契約に含まれていない(対象プランの外・プランの標準で使えない・運営が個別に利用不可にした)
 * - coming_soon: 提供開始前
 * - ended: 提供終了
 */
export type FeatureAccessStatus = "allowed" | "not_allowed" | "coming_soon" | "ended";

export interface FeatureAccess {
  key: FeatureKey;
  definition: FeatureDefinition;
  status: FeatureAccessStatus;
  /** 利用できない理由(画面に短く出す)。利用できるときは null。お客様向けの文で、運営内部の事情は書かない。 */
  reason: string | null;
}

export const NOT_ALLOWED_REASON = "ご契約のプランに含まれていません。";
export const SERVICE_PENDING_REASON = "利用開始の準備中です。利用開始のご案内をお待ちください。";
const COMING_SOON_REASON = "提供開始前のため、準備中です。";
const ENDED_REASON = "この機能の提供は終了しました。";
const GOOGLE_REVIEWS_COMING_SOON_REASON = "Googleの承認を確認中のため、準備中です。";

/** 契約・APP_MODE で利用対象か("code" の機能だけ。提供中かどうかは見ない)。 */
export function isFeatureEntitled(def: FeatureDefinition, input: Pick<FeatureAccessInput, "plan">): boolean {
  return isFeatureEnabledForPlan(input.plan, def.accessFeature) && isFeatureServedByMode(def.accessFeature);
}

/** 提供中か("code" の機能だけ。提供前の機能は、利用対象でも使えない)。 */
export function isFeatureAvailable(def: FeatureDefinition, input: Pick<FeatureAccessInput, "googleReviewsAvailable">): boolean {
  if (def.availability === "available") return true;
  return def.key === "google_reviews" && input.googleReviewsAvailable;
}

function result(def: FeatureDefinition, status: FeatureAccessStatus, reason: string | null): FeatureAccess {
  return { key: def.key, definition: def, status, reason };
}

function resolveCatalogAccess(def: FeatureDefinition, input: FeatureAccessInput): FeatureAccess {
  // このデプロイが提供しない機能は、DB の判定にかかわらず契約外と同じ扱い。
  if (!isFeatureServedByMode(def.accessFeature)) return result(def, "not_allowed", NOT_ALLOWED_REASON);
  const e = input.entitlements[def.key];
  // 判定が読めない機能は使わせない(利用できる側に倒さない)。
  if (!e) return result(def, "not_allowed", NOT_ALLOWED_REASON);
  if (e.allowed) return result(def, "allowed", null);
  switch (e.reason) {
    case "service_pending":
      return result(def, "not_allowed", SERVICE_PENDING_REASON);
    case "lifecycle_coming_soon":
      return result(def, "coming_soon", COMING_SOON_REASON);
    case "lifecycle_ended":
      return result(def, "ended", ENDED_REASON);
    default:
      // 運営が個別に利用不可にした機能も、サロンには契約外と同じに見せる(SalonPack でも使えない機能はある)。
      return result(def, "not_allowed", NOT_ALLOWED_REASON);
  }
}

export function resolveFeatureAccess(def: FeatureDefinition, input: FeatureAccessInput): FeatureAccess {
  if (def.entitlement === "catalog") return resolveCatalogAccess(def, input);
  // 契約外の機能は、提供前でも「準備中」ではなく「契約外」として扱う。
  if (!isFeatureEntitled(def, input)) return result(def, "not_allowed", NOT_ALLOWED_REASON);
  // 利用開始待ちは、契約の対象でも使えない(DB の判定と同じく、本来なら使える機能だけを止める)。
  if (!input.serviceActive) return result(def, "not_allowed", SERVICE_PENDING_REASON);
  if (!isFeatureAvailable(def, input)) {
    return result(def, "coming_soon", def.key === "google_reviews" ? GOOGLE_REVIEWS_COMING_SOON_REASON : COMING_SOON_REASON);
  }
  return result(def, "allowed", null);
}

export function resolveAllFeatureAccess(input: FeatureAccessInput): FeatureAccess[] {
  return FEATURE_REGISTRY.map((def) => resolveFeatureAccess(def, input));
}

/** 利用できる機能のうち、画面に出す機能(メニューに出す機能)。 */
export function listUsableFeatureKeys(input: FeatureAccessInput): FeatureKey[] {
  return resolveAllFeatureAccess(input)
    .filter((a) => a.status === "allowed" && a.definition.listed)
    .map((a) => a.key);
}

/**
 * 画面で紹介してよい機能(registry の listed が false の機能は、どこにも出さない)。
 *   - "home": ホームのカード。SalonPack は全機能(契約外・準備中・提供終了も)、口コミプランは機能一覧のホームを使わない
 *   - "guide": サロン設定・Google連携などの案内。利用できる機能と、SalonPack の準備中の機能だけ出す
 */
export function isFeatureIntroduced(
  access: Pick<FeatureAccess, "definition" | "status">,
  experience: PlanExperience,
  surface: "home" | "guide",
): boolean {
  if (!access.definition.listed) return false;
  return isStatusIntroduced(access.status, experience, surface);
}

function isStatusIntroduced(access: FeatureAccessStatus, experience: PlanExperience, surface: "home" | "guide"): boolean {
  if (experience === "reviews_direct") return surface === "guide" && access === "allowed";
  if (surface === "home") return true;
  return access === "allowed" || access === "coming_soon";
}
