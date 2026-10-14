import { beforeEach, describe, expect, it, vi } from "vitest";

// サロンを持たない運営の管理者: 通常のログインのあと運営管理へ移し、店舗登録・初期設定へ誘導しない。
// 店舗登録の Server Action を直接呼ばれても店舗を作らない。

const redirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
vi.mock("next/navigation", () => ({ redirect, notFound: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let operator = false;
let salon: { id: string; plan: "reviews" | "salonpack"; name: string } | null = null;
const from = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) }, from }),
}));
vi.mock("@/lib/supabase/queries", () => ({
  getAuthedUser: async () => ({ id: "user-1" }),
  getCurrentSalon: async () => salon,
  applyDefaultBusinessType: vi.fn(),
}));
vi.mock("@/lib/ops/operator", () => ({ isOperatorUser: async () => operator }));
vi.mock("@/lib/features/accessInput", () => ({
  loadFeatureAccessInput: async () => ({ plan: "reviews", googleReviewsAvailable: false, entitlements: {} }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  operator = false;
  salon = null;
});

describe("ダッシュボードの入口(layout)", () => {
  it("サロンを持たない管理者は /ops/salons へ", async () => {
    operator = true;
    const { default: DashboardLayout } = await import("@/app/dashboard/layout");
    await expect(DashboardLayout({ children: null } as never)).rejects.toThrow("REDIRECT:/ops/salons");
  });

  it("サロンを持たない一般のユーザーは、今まで通り店舗登録へ進める(移動しない)", async () => {
    const { default: DashboardLayout } = await import("@/app/dashboard/layout");
    await expect(DashboardLayout({ children: null } as never)).resolves.toBeTruthy();
    expect(redirect).not.toHaveBeenCalled();
  });
});
