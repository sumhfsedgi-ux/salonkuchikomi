import { afterEach, describe, expect, it, vi } from "vitest";
import { getNavItems, isSettingsActive } from "@/components/layout/navItems";
import { getPlanExperience, listUsableFeatureKeys } from "@/lib/features/access";
import { isGoogleReviewsOAuthEnabled } from "@/lib/google/config";
import { entitlementsFor } from "../../helpers/entitlements";
import type { SalonPlan } from "@/lib/access/plan";

const hrefs = (items: { href: string }[]) => items.map((item) => item.href);

// app/dashboard/layout.tsx と同じ組み立て(契約プランごとの画面の作り × 利用できる機能)。
function navFor(plan: SalonPlan) {
  const input = { plan, googleReviewsAvailable: isGoogleReviewsOAuthEnabled(), entitlements: entitlementsFor(plan) };
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

  it("届いた口コミは、受信箱などの中身と一緒に入れるまで出さない(提供を始めても)", () => {
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
