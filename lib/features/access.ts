import { isFeatureServedByMode, isReviewsOnly } from "@/lib/appMode";
import { isFeatureEnabledForPlan, type SalonPlan } from "@/lib/access/plan";
import { isGoogleReviewsOAuthEnabled } from "@/lib/google/config";
import { FEATURE_REGISTRY, type FeatureDefinition, type FeatureKey } from "@/lib/features/registry";

// 機能ごとの利用権限と、契約プランごとの画面の作りを、1か所で判定する(DBに触れない)。
// ホーム・メニュー・サーバー側の入口(lib/access/featureAccess.ts の canAccessFeature)は
// すべてここの判定を使う。次の2つは別の軸として扱い、混同しない:
//   - 機能ごとの利用権限: 契約(salons.plan)× APP_MODE で利用対象か → 提供中か、の順に判定する
//   - 画面の作り: SalonPack は機能一覧のホーム、口コミプランは口コミの設定画面を直接出す
// 将来、運営が店舗ごとに機能を許可するようになったら、FeatureAccessInput に店舗ごとの許可を足し、
// isFeatureEntitled の判定を差し替える(画面の作りは契約プランのまま)。
// お客様の表示設定は、ここでは扱わない(利用権限を広げも狭めもしない)。

export type PlanExperience = "feature_home" | "reviews_direct";

/** 契約プランごとの画面の作り。APP_MODE=reviews のデプロイは、契約にかかわらず口コミの画面を直接出す。 */
export function getPlanExperience(plan: SalonPlan): PlanExperience {
  if (isReviewsOnly()) return "reviews_direct";
  return plan === "salonpack" ? "feature_home" : "reviews_direct";
}

export interface FeatureAccessInput {
  plan: SalonPlan;
  /** 届いた口コミの提供を始めているか(GOOGLE_REVIEWS_OAUTH_ENABLED)。 */
  googleReviewsAvailable: boolean;
}

export type FeatureAccessStatus = "allowed" | "not_allowed" | "coming_soon";

export interface FeatureAccess {
  key: FeatureKey;
  definition: FeatureDefinition;
  status: FeatureAccessStatus;
  /** 利用できない理由(画面に短く出す)。利用できるときは null。 */
  reason: string | null;
}

export const NOT_ALLOWED_REASON = "ご契約のプランに含まれていません。";
const COMING_SOON_REASON = "提供開始前のため、準備中です。";
const GOOGLE_REVIEWS_COMING_SOON_REASON = "Googleの承認を確認中のため、準備中です。";

/** サーバーで、店舗の契約と提供状況から判定の入力を作る。 */
export function featureAccessInputFor(salon: { plan: SalonPlan }): FeatureAccessInput {
  return { plan: salon.plan, googleReviewsAvailable: isGoogleReviewsOAuthEnabled() };
}

/** 契約・APP_MODE で利用対象か(提供中かどうかは見ない)。 */
export function isFeatureEntitled(def: FeatureDefinition, input: Pick<FeatureAccessInput, "plan">): boolean {
  return isFeatureEnabledForPlan(input.plan, def.accessFeature) && isFeatureServedByMode(def.accessFeature);
}

/** 提供中か(提供前の機能は、利用対象でも使えない)。 */
export function isFeatureAvailable(def: FeatureDefinition, input: Pick<FeatureAccessInput, "googleReviewsAvailable">): boolean {
  if (def.availability === "available") return true;
  return def.key === "google_reviews" && input.googleReviewsAvailable;
}

export function resolveFeatureAccess(def: FeatureDefinition, input: FeatureAccessInput): FeatureAccess {
  // 契約外の機能は、提供前でも「準備中」ではなく「契約外」として扱う。
  if (!isFeatureEntitled(def, input)) return { key: def.key, definition: def, status: "not_allowed", reason: NOT_ALLOWED_REASON };
  if (!isFeatureAvailable(def, input)) {
    const reason = def.key === "google_reviews" ? GOOGLE_REVIEWS_COMING_SOON_REASON : COMING_SOON_REASON;
    return { key: def.key, definition: def, status: "coming_soon", reason };
  }
  return { key: def.key, definition: def, status: "allowed", reason: null };
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
 *   - "home": ホームのカード。SalonPack は全機能(契約外・準備中も)、口コミプランは機能一覧のホームを使わない
 *   - "guide": サロン設定・Google連携などの案内。契約外の機能は出さない。準備中の機能は SalonPack だけ出す
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
  return access !== "not_allowed";
}
