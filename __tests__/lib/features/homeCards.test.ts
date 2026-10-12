import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { entitlementsFor } from "../../helpers/entitlements";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FeatureCard from "@/components/dashboard/FeatureCard";
import { ReviewIcon } from "@/components/ui/icons";
import { resolveFeatureStates, type FeatureState, type SetupContext } from "@/lib/features/featureState";
import { reviewsDirectDestination, toHomeCard } from "@/lib/features/homeCards";

// SalonPack のホームのカード。実際の契約(SalonPack は4機能すべてを含む)では「SalonPack で一部が契約外」の
// 状態は作れないため、ここで利用権限の入力を差し替えて、カードの割り当てと描いた HTML を確かめる(テスト用の条件)。

function ctx(overrides: Partial<SetupContext> = {}): SetupContext {
  const plan = overrides.plan ?? "salonpack";
  return {
    plan,
    entitlements: entitlementsFor(plan),
    reservationSwitch: null,
    hasActiveSurvey: true,
    onboardingCompleted: true,
    googleReviewUrl: "https://g.page/r/example/review",
    hasBlogSettings: true,
    lineRecipientCount: 0,
    gmail: { bound: false, authState: null, scopeGranted: false, email: null },
    gbp: { bound: false, authState: null, scopeGranted: false, email: null, selectionState: null },
    reservationOps: null,
    masterEnabled: true,
    lineInvitesAvailable: true,
    googleReviewsAvailable: false,
    ...overrides,
  };
}

const stateOf = (c: SetupContext, key: string): FeatureState => resolveFeatureStates(c).states.find((s) => s.key === key)!;
const html = (state: FeatureState) => renderToStaticMarkup(createElement(FeatureCard, { icon: ReviewIcon, card: toHomeCard(state) }));
const text = (markup: string) => markup.replace(/<[^>]+>/g, "");

beforeEach(() => vi.stubEnv("NEXT_PUBLIC_APP_MODE", "salonpack"));
afterEach(() => vi.unstubAllEnvs());

describe("カードの4種類", () => {
  it("利用できる: 今までのボタン(押せる)", () => {
    const card = toHomeCard(stateOf(ctx(), "reviews"));
    expect(card).toMatchObject({ kind: "available", href: "/dashboard/reviews", ctaLabel: "口コミを使う", badge: null, reason: null });
  });

  it("設定が必要: 非活性にせず「設定が必要」と理由を出し、最初の未完了の設定へ進める", () => {
    const reviews = toHomeCard(stateOf(ctx({ hasActiveSurvey: false }), "reviews"));
    expect(reviews).toMatchObject({ kind: "setup_required", href: "/dashboard/setup/reviews", ctaLabel: "設定へ進む" });
    expect(reviews.badge).toEqual({ label: "設定が必要", variant: "warning" });
    expect(reviews.reason).toBe("次の設定が必要です:口コミのアンケートを作成");

    const reservation = toHomeCard(stateOf(ctx(), "reservation_notifications"));
    expect(reservation).toMatchObject({ kind: "setup_required", href: "/dashboard/settings/google", ctaLabel: "設定へ進む" });
    const lineMissing = toHomeCard(
      stateOf(ctx({ gmail: { bound: true, authState: "active", scopeGranted: true, email: "a@example.test" } }), "reservation_notifications")
    );
    expect(lineMissing).toMatchObject({ kind: "setup_required", href: "/dashboard/notifications#recipients" });
    expect(lineMissing.reason).toContain("LINEの通知先を追加してください");
  });

  it("開始待ちも「設定が必要」として、予約通知の画面(開始のボタン)へ進める", () => {
    const card = toHomeCard(
      stateOf(ctx({ gmail: { bound: true, authState: "active", scopeGranted: true, email: "a@example.test" }, lineRecipientCount: 1 }), "reservation_notifications")
    );
    expect(card).toMatchObject({ kind: "setup_required", href: "/dashboard/notifications" });
  });

  it("契約外(テスト用の条件: 口コミプランの判定を使う): グレー、理由つき、ボタンは非活性", () => {
    const state = stateOf(ctx({ plan: "reviews" }), "blog");
    expect(toHomeCard(state)).toMatchObject({ kind: "not_allowed", href: null, ctaLabel: "利用できません", reason: "ご契約のプランに含まれていません。" });
    const markup = html(state);
    expect(markup).toContain('data-kind="not_allowed"');
    expect(markup).toContain("bg-beige/50");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-describedby="feature-blog-reason"/);
    expect(markup).toContain('id="feature-blog-reason"');
    expect(markup).not.toContain("href=");
    // 色だけで区別しない: バッジの文字と理由の文、説明文が読める。
    expect(text(markup)).toContain("ご契約外");
    expect(text(markup)).toContain("ご契約のプランに含まれていません。");
    expect(text(markup)).toContain("Hot PepperブログをAIで作成");
  });

  it("SalonPack で運営が利用不可にした機能も、契約外と同じカード(「利用停止中」や問い合わせの案内は出さない)", () => {
    const state = stateOf(ctx({ entitlements: entitlementsFor("salonpack", { overrides: { blog: "deny" } }) }), "blog");
    expect(toHomeCard(state)).toMatchObject({ kind: "not_allowed", href: null, ctaLabel: "利用できません", reason: "ご契約のプランに含まれていません。" });
    const plain = text(html(state));
    expect(plain).toContain("ご契約外");
    expect(plain).not.toContain("利用停止中");
    expect(plain).not.toContain("運営");
  });

  it("準備中: グレー、「準備中」のバッジと理由、ボタンは非活性", () => {
    const state = stateOf(ctx(), "google_reviews");
    expect(toHomeCard(state)).toMatchObject({ kind: "coming_soon", href: null, ctaLabel: "準備中" });
    const markup = html(state);
    expect(markup).toMatch(/<button[^>]*disabled=""/);
    expect(text(markup)).toContain("準備中");
    expect(text(markup)).toContain("Googleの承認を確認中のため、準備中です。");
  });

  it("利用できるカード・設定が必要なカードはリンクで、非活性のボタンを出さない", () => {
    for (const state of [stateOf(ctx(), "reviews"), stateOf(ctx({ hasActiveSurvey: false }), "reviews")]) {
      const markup = html(state);
      expect(markup).toContain("href=");
      expect(markup).not.toContain('disabled=""');
      expect(markup).not.toContain("bg-beige/50");
    }
  });

  it("予約通知の稼働状態はバッジで出す(稼働中・停止中)", () => {
    const ready = { gmail: { bound: true, authState: "active" as const, scopeGranted: true, email: "a@example.test" }, lineRecipientCount: 1 };
    const ops = { state: "active" as const, legacy: false, activatedAt: "2026-10-09T02:50:00Z", lastMailCheckAt: "2026-10-09T02:58:00Z" };
    const now = new Date("2026-10-09T03:00:00Z");
    expect(toHomeCard(stateOf(ctx({ ...ready, now, reservationOps: ops }), "reservation_notifications")).badge).toEqual({ label: "稼働中", variant: "success" });
    const stopped = toHomeCard(
      stateOf(ctx({ ...ready, now, reservationOps: ops, reservationSwitch: { selected: false, updatedAt: "x" } }), "reservation_notifications")
    );
    expect(stopped).toMatchObject({ kind: "available", href: "/dashboard/notifications", badge: { label: "停止中", variant: "neutral" } });
  });
});

describe("口コミプランの /dashboard の行き先", () => {
  it("アンケートが無い・初期設定が終わっていない間は、今まで通りの初期設定へ", () => {
    expect(reviewsDirectDestination({ hasActiveSurvey: false, onboardingCompleted: false, onboarded: false })).toBe("/dashboard/setup/reviews");
    expect(reviewsDirectDestination({ hasActiveSurvey: true, onboardingCompleted: false, onboarded: false })).toBe("/dashboard/setup/reviews");
  });

  it("初期設定が終わっていれば口コミの設定画面へ(完了の表示は引き継ぐ)", () => {
    expect(reviewsDirectDestination({ hasActiveSurvey: true, onboardingCompleted: true, onboarded: false })).toBe("/dashboard/reviews");
    expect(reviewsDirectDestination({ hasActiveSurvey: true, onboardingCompleted: true, onboarded: true })).toBe("/dashboard/reviews?onboarded=1");
  });
});
