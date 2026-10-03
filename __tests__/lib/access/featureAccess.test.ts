import { afterEach, describe, expect, it, vi } from "vitest";
import { getAppMode, isFeatureServedByMode, type Feature } from "@/lib/appMode";
import { isFeatureEnabledForPlan, type SalonPlan } from "@/lib/access/plan";
import { canAccessFeature } from "@/lib/access/featureAccess";

const SALONPACK_ONLY: Feature[] = ["blog", "notifications"];
const REVIEW_SUITE: Feature[] = ["review_replies", "google_reviews", "review_notifications"];
const ALL_FEATURES: Feature[] = ["reviews", "settings", ...SALONPACK_ONLY, ...REVIEW_SUITE];
const PLANS: SalonPlan[] = ["reviews", "salonpack"];
const MODES = ["reviews", "salonpack"] as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("契約プランごとの利用可能機能", () => {
  it("reviews プランではブログ・予約通知を使えない", () => {
    for (const feature of SALONPACK_ONLY) {
      expect(isFeatureEnabledForPlan("reviews", feature)).toBe(false);
    }
  });

  it("口コミ系の機能は両プランで使える(アップグレードで使えなくならない)", () => {
    for (const plan of PLANS) {
      for (const feature of ["reviews", "settings", ...REVIEW_SUITE] as Feature[]) {
        expect(isFeatureEnabledForPlan(plan, feature)).toBe(true);
      }
    }
  });

  it("salonpack プランは reviews プランで使える機能をすべて含む", () => {
    for (const feature of ALL_FEATURES) {
      if (isFeatureEnabledForPlan("reviews", feature)) {
        expect(isFeatureEnabledForPlan("salonpack", feature)).toBe(true);
      }
    }
  });
});

describe("APP_MODE ごとの提供機能", () => {
  it("reviews モードはブログ・予約通知を提供せず、口コミ系の新機能は提供する", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_MODE", "reviews");
    expect(getAppMode()).toBe("reviews");
    for (const feature of SALONPACK_ONLY) expect(isFeatureServedByMode(feature)).toBe(false);
    for (const feature of REVIEW_SUITE) expect(isFeatureServedByMode(feature)).toBe(true);
  });

  it("salonpack モードはすべての機能を提供する", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_MODE", "salonpack");
    for (const feature of ALL_FEATURES) expect(isFeatureServedByMode(feature)).toBe(true);
  });

  it("未設定の場合は現状 salonpack 扱いになる(fail-open。Vercelの設定を確認してから見直す)", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_MODE", "");
    expect(getAppMode()).toBe("salonpack");
  });
});

describe("canAccessFeature(APP_MODE × 契約プラン)", () => {
  const salon = (plan: SalonPlan) => ({ id: "salon-1", plan });

  it("reviews モードでは salonpack プランの店舗でもブログを使えない", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_MODE", "reviews");
    expect(await canAccessFeature(salon("salonpack"), "user-1", "blog")).toBe(false);
  });

  it("salonpack モードでも reviews プランの店舗は予約通知を使えない", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_MODE", "salonpack");
    expect(await canAccessFeature(salon("reviews"), "user-1", "notifications")).toBe(false);
  });

  it("salonpack モード × salonpack プランならブログ・予約通知を使える", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_MODE", "salonpack");
    for (const feature of SALONPACK_ONLY) {
      expect(await canAccessFeature(salon("salonpack"), "user-1", feature)).toBe(true);
    }
  });

  it("口コミ系の新機能はどのモード・プランの組み合わせでも使える", async () => {
    for (const mode of MODES) {
      vi.stubEnv("NEXT_PUBLIC_APP_MODE", mode);
      for (const plan of PLANS) {
        for (const feature of REVIEW_SUITE) {
          expect(await canAccessFeature(salon(plan), "user-1", feature)).toBe(true);
        }
      }
    }
  });
});
