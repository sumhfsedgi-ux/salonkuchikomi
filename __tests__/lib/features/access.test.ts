import { afterEach, describe, expect, it, vi } from "vitest";
import { canAccessFeature } from "@/lib/access/featureAccess";
import {
  getPlanExperience,
  isFeatureIntroduced,
  listUsableFeatureKeys,
  resolveAllFeatureAccess,
  resolveFeatureAccess,
  type FeatureAccessStatus,
} from "@/lib/features/access";
import { FEATURE_REGISTRY } from "@/lib/features/registry";
import type { SalonPlan } from "@/lib/access/plan";

const PLANS: SalonPlan[] = ["reviews", "salonpack"];
const MODES = ["reviews", "salonpack"] as const;

afterEach(() => vi.unstubAllEnvs());

describe("契約プランごとの画面の作り(機能ごとの利用権限とは別の判定)", () => {
  it("SalonPack は機能一覧のホーム、口コミプランは口コミの画面を直接出す", () => {
    expect(getPlanExperience("salonpack")).toBe("feature_home");
    expect(getPlanExperience("reviews")).toBe("reviews_direct");
  });

  it("APP_MODE=reviews のデプロイは、契約にかかわらず口コミの画面を直接出す", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_MODE", "reviews");
    for (const plan of PLANS) expect(getPlanExperience(plan)).toBe("reviews_direct");
  });
});

describe("機能ごとの利用権限: 契約・APP_MODE → 提供状況の順に判定する", () => {
  const statuses = (plan: SalonPlan, googleReviewsAvailable = false) =>
    Object.fromEntries(resolveAllFeatureAccess({ plan, googleReviewsAvailable }).map((a) => [a.key, a.status]));

  it("口コミプラン: 口コミだけ利用でき、ブログ・予約通知は契約外、届いた口コミは準備中", () => {
    expect(statuses("reviews")).toEqual({ reviews: "allowed", blog: "not_allowed", reservation_notifications: "not_allowed", google_reviews: "coming_soon" });
  });

  it("SalonPack: 届いた口コミ以外は利用でき、届いた口コミは提供を始めたら利用できる", () => {
    expect(statuses("salonpack")).toEqual({ reviews: "allowed", blog: "allowed", reservation_notifications: "allowed", google_reviews: "coming_soon" });
    expect(statuses("salonpack", true).google_reviews).toBe("allowed");
  });

  it("契約外の機能は、提供前でも準備中ではなく契約外", () => {
    const comingSoonButNotInPlan = { ...FEATURE_REGISTRY.find((d) => d.key === "blog")!, availability: "coming_soon" as const };
    expect(resolveFeatureAccess(comingSoonButNotInPlan, { plan: "reviews", googleReviewsAvailable: false }).status).toBe("not_allowed");
  });

  it("利用できない理由を短く返す(利用できるときは null)", () => {
    const [reviews, blog, , googleReviews] = resolveAllFeatureAccess({ plan: "reviews", googleReviewsAvailable: false });
    expect(reviews.reason).toBeNull();
    expect(blog.reason).toBe("ご契約のプランに含まれていません。");
    expect(googleReviews.reason).toBe("Googleの承認を確認中のため、準備中です。");
  });

  it("メニューに出す機能は、利用できる機能だけ", () => {
    expect(listUsableFeatureKeys({ plan: "reviews", googleReviewsAvailable: false })).toEqual(["reviews"]);
    expect(listUsableFeatureKeys({ plan: "salonpack", googleReviewsAvailable: false })).toEqual(["reviews", "blog", "reservation_notifications"]);
  });
});

describe("サーバー側の入口(canAccessFeature)と、ホーム・メニューの判定が一致する", () => {
  it("全プラン × 全機能 × 提供状況 × APP_MODE で同じ結果", async () => {
    for (const mode of MODES) {
      for (const flag of ["", "1"]) {
        vi.stubEnv("NEXT_PUBLIC_APP_MODE", mode);
        vi.stubEnv("GOOGLE_REVIEWS_OAUTH_ENABLED", flag);
        for (const plan of PLANS) {
          for (const def of FEATURE_REGISTRY) {
            const access = resolveFeatureAccess(def, { plan, googleReviewsAvailable: flag === "1" });
            const allowed = await canAccessFeature({ id: "salon-1", plan }, "user-1", def.accessFeature);
            expect({ mode, flag, plan, key: def.key, allowed }).toEqual({ mode, flag, plan, key: def.key, allowed: access.status === "allowed" });
          }
        }
      }
    }
  });
});

describe("画面で紹介してよい機能", () => {
  const all: FeatureAccessStatus[] = ["allowed", "not_allowed", "coming_soon"];
  // 画面に出す機能(listed)で、利用権限の状態ごとの出し分けを確かめる。
  const listed = FEATURE_REGISTRY.find((d) => d.key === "reservation_notifications")!;
  const as = (status: FeatureAccessStatus) => ({ definition: listed, status });

  it("SalonPack のホームは全機能(契約外・準備中もグレーで紹介する)", () => {
    for (const status of all) expect(isFeatureIntroduced(as(status), "feature_home", "home")).toBe(true);
  });

  it("SalonPack の案内(サロン設定・Google連携)は、契約外を出さず、準備中は出す", () => {
    expect(all.map((s) => isFeatureIntroduced(as(s), "feature_home", "guide"))).toEqual([true, false, true]);
  });

  it("口コミプランは機能一覧のホームを使わず、案内には利用できる機能だけ(準備中も出さない)", () => {
    expect(all.map((s) => isFeatureIntroduced(as(s), "reviews_direct", "home"))).toEqual([false, false, false]);
    expect(all.map((s) => isFeatureIntroduced(as(s), "reviews_direct", "guide"))).toEqual([true, false, false]);
  });

  it("届いた口コミは、受信箱などの中身と一緒に入れるまで、どの画面にも出さない(提供を始めても)", () => {
    const googleReviews = FEATURE_REGISTRY.find((d) => d.key === "google_reviews")!;
    expect(googleReviews.listed).toBe(false);
    for (const experience of ["feature_home", "reviews_direct"] as const) {
      for (const surface of ["home", "guide"] as const) {
        for (const status of all) expect(isFeatureIntroduced({ definition: googleReviews, status }, experience, surface)).toBe(false);
      }
    }
    expect(listUsableFeatureKeys({ plan: "salonpack", googleReviewsAvailable: true })).not.toContain("google_reviews");
    expect(FEATURE_REGISTRY.filter((d) => d.listed).map((d) => d.key)).toEqual(["reviews", "blog", "reservation_notifications"]);
  });
});
