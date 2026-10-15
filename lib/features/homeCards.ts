import type { BadgeVariant } from "@/components/ui/Badge";
import type { FeatureState, FeatureStatus } from "@/lib/features/featureState";
import type { FeatureKey } from "@/lib/features/registry";
import { REVIEWS_TAB_PATH, SURVEY_TAB_PATH } from "@/lib/features/reviewsEntry";

// SalonPack のホームのカード(1機能1枚)。色だけで区別しないよう、どのカードにも文字のバッジと短い理由を付ける。
//   - available:      利用できる(今までのボタン)
//   - setup_required: 利用は許可されているが設定が未完了(押せる。「設定へ進む」で最初の未完了の設定へ)
//   - not_allowed:    契約外(グレー。説明は読める。ボタンは非活性)
//   - coming_soon:    提供前(グレー。ボタンは非活性)
//   - ended:          提供終了(グレー。ボタンは非活性)
// 運営が個別に利用不可にした機能は、契約外と同じ not_allowed になる(lib/features/access.ts)。

export type HomeCardKind = "available" | "setup_required" | "not_allowed" | "coming_soon" | "ended";

export interface HomeCard {
  key: FeatureKey;
  title: string;
  description: string;
  kind: HomeCardKind;
  badge: { label: string; variant: BadgeVariant } | null;
  /** 状態・利用できない理由の短い説明。 */
  reason: string | null;
  /** ボタンの行き先。非活性のカードは null。 */
  href: string | null;
  ctaLabel: string;
}

const CTA: Record<FeatureKey, string> = {
  reviews: "口コミを使う",
  blog: "ブログを作る",
  reservation_notifications: "詳しく見る",
  google_reviews: "設定を見る",
};

const SETUP_STATUSES: FeatureStatus[] = ["setup_required", "google_connect_required", "reconnect_required", "ready_to_start"];

// 利用できるカードのバッジ(口コミ・ブログの「利用中」は出さない。予約通知は実際に通知しているかを出す)。
const AVAILABLE_BADGES: Partial<Record<FeatureStatus, BadgeVariant>> = {
  active: "success",
  setup_complete: "success",
  stopped: "neutral",
  paused: "neutral",
  checking: "warning",
};

/**
 * options.reviewsTab:Google口コミ(「口コミ」タブ)を使える店舗。「口コミ」のカードは「口コミ」タブを開く
 * (アンケートが未作成でも、アンケートの初期設定へは進めない。アンケートは「口コミ」の中のタブから作れる)。
 */
export function toHomeCard(state: FeatureState, options: { reviewsTab?: boolean } = {}): HomeCard {
  const base = { key: state.key, title: state.definition.label, description: state.definition.description };
  if (state.key === "reviews" && state.access === "allowed" && options.reviewsTab) {
    return { ...base, kind: "available", badge: null, reason: null, href: REVIEWS_TAB_PATH, ctaLabel: CTA.reviews };
  }
  if (state.access !== "allowed") {
    return {
      ...base,
      kind: state.access,
      badge: { label: state.statusLabel, variant: "neutral" },
      reason: state.message,
      href: null,
      ctaLabel: state.access === "coming_soon" ? "準備中" : "利用できません",
    };
  }
  if (SETUP_STATUSES.includes(state.status)) {
    const next = state.setupItems.find((i) => i.required && !i.complete);
    return {
      ...base,
      kind: "setup_required",
      badge: { label: "設定が必要", variant: "warning" },
      reason: state.message ?? (next ? `次の設定が必要です:${next.label}` : null),
      href: next?.href ?? state.definition.href,
      ctaLabel: "設定へ進む",
    };
  }
  const variant = AVAILABLE_BADGES[state.status];
  return {
    ...base,
    kind: "available",
    badge: variant ? { label: state.statusLabel, variant } : null,
    reason: state.message,
    href: state.definition.href,
    ctaLabel: CTA[state.key],
  };
}

/**
 * 口コミプランでは機能一覧のホームを使わず、口コミの画面へ直接進む。
 *   ・Google口コミ(google_reviews)を使える店舗は「口コミ」タブへ(アンケートが無くても初期設定へは移さない。
 *     アンケートの初期設定を終えた直後だけは、お客様用URLを案内するため「アンケート」タブへ)
 *   ・それ以外で、アンケートが無い・初期設定が終わっていない間は、今まで通りの初期設定へ
 */
export function reviewsDirectDestination(params: {
  hasActiveSurvey: boolean;
  onboardingCompleted: boolean;
  onboarded: boolean;
  googleReviewsAllowed?: boolean;
}): string {
  const surveyReady = params.hasActiveSurvey && params.onboardingCompleted;
  if (params.googleReviewsAllowed && !(surveyReady && params.onboarded)) return REVIEWS_TAB_PATH;
  if (!surveyReady) return "/dashboard/setup/reviews";
  return params.onboarded ? `${SURVEY_TAB_PATH}?onboarded=1` : SURVEY_TAB_PATH;
}
