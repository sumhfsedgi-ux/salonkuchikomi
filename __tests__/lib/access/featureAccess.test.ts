import { afterEach, describe, expect, it, vi } from "vitest";
import { getAppMode, isFeatureServedByMode, type Feature } from "@/lib/appMode";
import { isFeatureEnabledForPlan, type SalonPlan } from "@/lib/access/plan";
import { canAccessFeature } from "@/lib/access/featureAccess";
import { entitlementsFor } from "../../helpers/entitlements";

// DB の利用権限(salon_feature_access_all)の読み込みを差し替える(店舗 id の末尾がプラン。個別設定なし)。
// id が "gr-allowed-" で始まる店舗は、届いた口コミを提供中にして、店舗ごとに許可した状態(公開のときの形)。
vi.mock("@/lib/features/loadEntitlements", () => ({
  loadSalonEntitlements: async (salonId: string) =>
    entitlementsFor(
      salonId.endsWith("salonpack") ? "salonpack" : "reviews",
      salonId.startsWith("gr-allowed-") ? { lifecycle: { google_reviews: "available" }, overrides: { google_reviews: "allow" } } : {},
    ),
}));

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
  const salon = (plan: SalonPlan) => ({ id: `salon-${plan}`, plan, serviceStatus: "complimentary" as const });

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

  it("届いた口コミは、DB で提供中・店舗ごとに許可され、かつ GOOGLE_REVIEWS_OAUTH_ENABLED が有効なときだけ使える(どのモード・プランでも)", async () => {
    const allowedSalon = (plan: SalonPlan) => ({ id: `gr-allowed-${plan}`, plan, serviceStatus: "complimentary" as const });
    for (const mode of MODES) {
      vi.stubEnv("NEXT_PUBLIC_APP_MODE", mode);
      for (const plan of PLANS) {
        vi.stubEnv("GOOGLE_REVIEWS_OAUTH_ENABLED", "1");
        expect(await canAccessFeature(allowedSalon(plan), "user-1", "google_reviews")).toBe(true);
        // DB の初期値(準備中・プランの標準は使えない)のままの店舗は、フラグが有効でも使えない
        expect(await canAccessFeature(salon(plan), "user-1", "google_reviews")).toBe(false);
        vi.stubEnv("GOOGLE_REVIEWS_OAUTH_ENABLED", "");
        // DB で許可されていても、フラグが無効なら使えない(二重の停止)
        expect(await canAccessFeature(allowedSalon(plan), "user-1", "google_reviews")).toBe(false);
        // 登録の無い口コミ系の機能名は、従来どおり契約と APP_MODE だけで判定する
        expect(await canAccessFeature(salon(plan), "user-1", "review_replies")).toBe(true);
        expect(await canAccessFeature(salon(plan), "user-1", "review_notifications")).toBe(true);
      }
    }
  });
});
