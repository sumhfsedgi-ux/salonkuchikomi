import type { BadgeVariant } from "@/components/ui/Badge";
import type { FeatureState, FeatureStatus } from "@/lib/features/featureState";
import type { FeatureKey } from "@/lib/features/registry";

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

export function toHomeCard(state: FeatureState): HomeCard {
  const base = { key: state.key, title: state.definition.label, description: state.definition.description };
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
 * アンケートが無い・初期設定が終わっていない間は、今まで通りの初期設定へ。
 */
export function reviewsDirectDestination(params: { hasActiveSurvey: boolean; onboardingCompleted: boolean; onboarded: boolean }): string {
  if (!params.hasActiveSurvey || !params.onboardingCompleted) return "/dashboard/setup/reviews";
  return params.onboarded ? "/dashboard/reviews?onboarded=1" : "/dashboard/reviews";
}
