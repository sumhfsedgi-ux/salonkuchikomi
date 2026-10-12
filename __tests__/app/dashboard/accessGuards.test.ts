import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnerSalon } from "@/lib/types";

// メニューに出さないだけでなく、URL・Server Action を直接呼ばれても、権限の無い機能を使えないこと。
// DB・Google には接続しない(店舗の解決と外部の呼び出しを差し替える)。

const redirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
const notFound = vi.fn(() => {
  throw new Error("NOT_FOUND");
});
vi.mock("next/navigation", () => ({ redirect, notFound }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let currentSalon: OwnerSalon | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) } }),
}));
vi.mock("@/lib/supabase/queries", () => ({ getCurrentSalon: async () => currentSalon, applyDefaultBusinessType: vi.fn() }));

const startGoogleConnect = vi.fn(async () => "https://accounts.google.com/o/oauth2/v2/auth?x");
const turnOffFeatureSwitch = vi.fn(async () => {});
const unbindGoogleFeatures = vi.fn(async () => []);
vi.mock("@/lib/google/oauthFlow", () => ({ startGoogleConnect, GoogleConnectInputError: class extends Error {} }));
vi.mock("@/lib/google/runtime", () => ({ getGoogleFlowDeps: () => ({}) }));
vi.mock("@/lib/google/db/bindings", () => ({ listSalonGoogleBindings: async () => [], unbindGoogleFeatures }));
vi.mock("@/lib/google/revocations", () => ({ processGoogleRevocations: vi.fn() }));
vi.mock("@/lib/features/featureSwitch", () => ({ turnOffFeatureSwitch, turnOnReservationSwitch: vi.fn() }));

function salon(plan: "reviews" | "salonpack"): OwnerSalon {
  return {
    id: "salon-1",
    ownerId: "owner-1",
    name: "テスト",
    slug: "test",
    googleReviewUrl: null,
    description: null,
    businessType: null,
    onboardingCompleted: true,
    plan,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
  } as OwnerSalon;
}

function form(values: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
}

async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    const message = (e as Error).message;
    if (message.startsWith("REDIRECT:")) return message.slice("REDIRECT:".length);
    throw e;
  }
  throw new Error("redirect されませんでした");
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_MODE", "salonpack");
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllEnvs());

describe("Google連携の開始(startGoogleConnectAction)", () => {
  it("口コミプランの店舗が予約メール(Gmail)の権限を要求しても、Google へ進めない", async () => {
    currentSalon = salon("reviews");
    const { startGoogleConnectAction } = await import("@/app/dashboard/settings/google/actions");
    expect(await redirectOf(() => startGoogleConnectAction(form({ features: "gmail", purpose: "connect" })))).toBe(
      "/dashboard/settings/google?google=feature_not_allowed"
    );
    expect(startGoogleConnect).not.toHaveBeenCalled();
  });

  it("提供前の届いた口コミ(gbp)は、どの契約でも準備中として断る", async () => {
    const { startGoogleConnectAction } = await import("@/app/dashboard/settings/google/actions");
    for (const plan of ["reviews", "salonpack"] as const) {
      currentSalon = salon(plan);
      expect(await redirectOf(() => startGoogleConnectAction(form({ features: "gbp", purpose: "connect" })))).toBe("/dashboard/settings/google?google=not_available");
    }
    expect(startGoogleConnect).not.toHaveBeenCalled();
  });

  it("SalonPack の店舗の予約メールは、今まで通り Google へ進む(機能を選んでいなくても)", async () => {
    currentSalon = salon("salonpack");
    const { startGoogleConnectAction } = await import("@/app/dashboard/settings/google/actions");
    expect(await redirectOf(() => startGoogleConnectAction(form({ features: "gmail", purpose: "connect" })))).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect(startGoogleConnect).toHaveBeenCalledTimes(1);
  });
});

describe("利用の停止(stopFeatureAction)", () => {
  it("契約外の機能は停止の操作も受け付けない(スイッチを書かない)", async () => {
    currentSalon = salon("reviews");
    const { stopFeatureAction } = await import("@/app/dashboard/settings/google/actions");
    expect(await redirectOf(() => stopFeatureAction(form({ feature: "gmail" })))).toBe("/dashboard/settings/google?google=feature_not_allowed");
    expect(turnOffFeatureSwitch).not.toHaveBeenCalled();
  });

  it("SalonPack の予約通知は、予約通知の行だけを OFF にする(ほかの機能・Google の連携は変えない)", async () => {
    currentSalon = salon("salonpack");
    const { stopFeatureAction } = await import("@/app/dashboard/settings/google/actions");
    expect(await redirectOf(() => stopFeatureAction(form({ feature: "gmail" })))).toBe("/dashboard/settings/google?google=stopped_gmail");
    expect(turnOffFeatureSwitch).toHaveBeenCalledWith({ salonId: "salon-1", userId: "user-1", key: "reservation_notifications" });
    expect(unbindGoogleFeatures).not.toHaveBeenCalled();
  });
});

describe("ページの入口(requireFeatureAccess)", () => {
  it("口コミプランの店舗がブログ・予約通知の URL を直接開くと 404", async () => {
    currentSalon = salon("reviews");
    const { requireFeatureAccess } = await import("@/lib/access/featureAccess");
    const supabase = (await (await import("@/lib/supabase/server")).createClient()) as never;
    for (const feature of ["blog", "notifications"] as const) {
      await expect(requireFeatureAccess(supabase, feature)).rejects.toThrow("NOT_FOUND");
    }
    await expect(requireFeatureAccess(supabase, "reviews")).resolves.toMatchObject({ id: "salon-1" });
  });

  it("提供前の届いた口コミは、どの契約でも 404", async () => {
    const { requireFeatureAccess } = await import("@/lib/access/featureAccess");
    const supabase = (await (await import("@/lib/supabase/server")).createClient()) as never;
    for (const plan of ["reviews", "salonpack"] as const) {
      currentSalon = salon(plan);
      await expect(requireFeatureAccess(supabase, "google_reviews")).rejects.toThrow("NOT_FOUND");
    }
  });
});
