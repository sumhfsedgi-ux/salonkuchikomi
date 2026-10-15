import { afterEach, describe, expect, it, vi } from "vitest";
import { getNavItems, isNavItemActive, isSettingsActive } from "@/components/layout/navItems";
import { getPlanExperience, isReviewsTabUsable, listUsableFeatureKeys } from "@/lib/features/access";
import { isGoogleReviewsOAuthEnabled } from "@/lib/google/config";
import { entitlementsFor } from "../../helpers/entitlements";
import type { SalonPlan } from "@/lib/access/plan";

const hrefs = (items: { href: string }[]) => items.map((item) => item.href);

// app/dashboard/layout.tsx と同じ組み立て(契約プランごとの画面の作り × 利用できる機能)。
function navFor(plan: SalonPlan) {
  const input = { plan, serviceActive: true, googleReviewsAvailable: isGoogleReviewsOAuthEnabled(), entitlements: entitlementsFor(plan) };
  return getNavItems(getPlanExperience(plan), listUsableFeatureKeys(input));
}

afterEach(() => vi.unstubAllEnvs());

describe("メニューには、その店舗が利用できる機能だけを出す", () => {
  it("口コミプラン: ホームを出さず、口コミだけ(サロン設定・ログアウトはメニューの下側に共通)", () => {
    expect(hrefs(navFor("reviews"))).toEqual(["/dashboard/reviews"]);
  });

  it("SalonPack: ホームと、利用できる機能", () => {
    expect(hrefs(navFor("salonpack"))).toEqual(["/dashboard", "/dashboard/reviews", "/dashboard/blog", "/dashboard/notifications"]);
  });

  it("Google口コミは単独のメニュー項目を出さない(提供を始めても。「口コミ」の中のタブで使う)", () => {
    vi.stubEnv("GOOGLE_REVIEWS_OAUTH_ENABLED", "1");
    expect(hrefs(navFor("salonpack"))).toEqual(["/dashboard", "/dashboard/reviews", "/dashboard/blog", "/dashboard/notifications"]);
    expect(hrefs(navFor("reviews"))).toEqual(["/dashboard/reviews"]);
  });

  it("APP_MODE=reviews のデプロイは、契約にかかわらず口コミだけ(ホームなし)", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_MODE", "reviews");
    for (const plan of ["reviews", "salonpack"] as const) expect(hrefs(navFor(plan))).toEqual(["/dashboard/reviews"]);
  });
});

describe("サロン設定の選択中の表示", () => {
  it("Google連携の画面はサロン設定の配下(サロン設定を選択中にする)", () => {
    expect(isSettingsActive("/dashboard/settings", navFor("salonpack"))).toBe(true);
    expect(isSettingsActive("/dashboard/settings/google", navFor("salonpack"))).toBe(true);
    expect(isSettingsActive("/dashboard/reviews", navFor("salonpack"))).toBe(false);
  });
});

describe("「口コミ」の入口:Google口コミを使える店舗は「口コミ」タブ(アンケートの初期設定へは移さない)", () => {
  const allowed = (plan: SalonPlan, available = true) => ({
    plan,
    serviceActive: true,
    googleReviewsAvailable: available,
    entitlements: entitlementsFor(plan, { overrides: { google_reviews: "allow" }, lifecycle: { google_reviews: "available" } }),
  });

  it("使える店舗:メニューの「口コミ」は「口コミ」タブを開き、口コミ・アンケート・設定のどのタブでも選択中", () => {
    for (const plan of ["reviews", "salonpack"] as const) {
      const input = allowed(plan);
      expect(isReviewsTabUsable(input)).toBe(true);
      const items = getNavItems(getPlanExperience(plan), listUsableFeatureKeys(input), { reviewsTab: isReviewsTabUsable(input) });
      const reviews = items.find((i) => i.label === "口コミ")!;
      expect(reviews.href).toBe("/dashboard/reviews/google");
      for (const path of ["/dashboard/reviews/google", "/dashboard/reviews/google/abc", "/dashboard/reviews", "/dashboard/reviews/settings"]) {
        expect([path, isNavItemActive(path, reviews.activeHref ?? reviews.href)]).toEqual([path, true]);
      }
      expect(isNavItemActive("/dashboard/blog", reviews.activeHref ?? reviews.href)).toBe(false);
    }
  });

  it("使えない店舗(準備中・個別の許可が無い・GOOGLE_REVIEWS_OAUTH_ENABLED が空):今まで通りアンケート", () => {
    const comingSoon = { plan: "reviews" as const, serviceActive: true, googleReviewsAvailable: true, entitlements: entitlementsFor("reviews", { overrides: { google_reviews: "allow" } }) };
    const notAllowed = { plan: "reviews" as const, serviceActive: true, googleReviewsAvailable: true, entitlements: entitlementsFor("reviews", { lifecycle: { google_reviews: "available" } }) };
    for (const input of [comingSoon, notAllowed, allowed("reviews", false)]) {
      expect(isReviewsTabUsable(input)).toBe(false);
      const items = getNavItems(getPlanExperience("reviews"), listUsableFeatureKeys(input), { reviewsTab: isReviewsTabUsable(input) });
      expect(hrefs(items)).toEqual(["/dashboard/reviews"]);
    }
  });
});
