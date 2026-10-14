import { beforeEach, describe, expect, it, vi } from "vitest";

// 店舗の画面の入口(layout)と、お客様の店舗の登録(registerOwnSalonAction)。
//   ログイン → 本人確認 → 店舗の登録 → 利用開始 のうち、済んでいない段階へ移す。運営の管理者は /ops へ。
//   店舗の登録の Server Action を直接呼ばれても、所有者・区分・プランをブラウザの値で決めない(DB の create_own_salon)。

const redirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
vi.mock("next/navigation", () => ({ redirect, notFound: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

type Account = { emailConfirmed: boolean; verified: boolean; verificationMode: "set_new"; sessionTrusted: boolean; emailLinkSession: boolean; isOperator: boolean };
let account: Account | null = null;
let salon: { id: string; plan: "reviews" | "salonpack"; name: string; serviceStatus: "pending" | "complimentary" | "test" } | null = null;
const rpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc }),
}));
vi.mock("@/lib/supabase/queries", () => ({
  getAuthedUser: async () => ({ id: "user-1", email: "owner@example.test" }),
  getCurrentSalon: async () => salon,
  applyDefaultBusinessType: vi.fn(),
}));
vi.mock("@/lib/onboarding/accountState", () => ({ getAccountState: async () => account }));
vi.mock("@/lib/features/accessInput", () => ({
  loadFeatureAccessInput: async () => ({ plan: "reviews", serviceActive: true, googleReviewsAvailable: false, entitlements: {} }),
}));

const trusted = (over: Partial<Account> = {}): Account => ({
  emailConfirmed: true,
  verified: true,
  verificationMode: "set_new",
  sessionTrusted: true,
  emailLinkSession: false,
  isOperator: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  account = trusted();
  salon = null;
});

describe("ダッシュボードの入口(layout)", () => {
  async function layout() {
    const { default: DashboardLayout } = await import("@/app/dashboard/layout");
    return DashboardLayout({ children: null } as never);
  }

  it("運営の管理者は /ops/salons へ(店舗の登録・初期設定へ誘導しない)", async () => {
    account = trusted({ isOperator: true });
    await expect(layout()).rejects.toThrow("REDIRECT:/ops/salons");
  });

  it("本人確認の済んでいない・本人確認より前のセッションは /auth/verify へ(店舗を読まない)", async () => {
    account = trusted({ verified: false, sessionTrusted: false });
    salon = { id: "s", plan: "reviews", name: "x", serviceStatus: "complimentary" };
    await expect(layout()).rejects.toThrow("REDIRECT:/auth/verify");
    account = trusted({ sessionTrusted: false });
    await expect(layout()).rejects.toThrow("REDIRECT:/auth/verify");
  });

  it("店舗が無ければ店舗の登録へ、利用開始待ちなら利用開始待ちの画面へ", async () => {
    await expect(layout()).rejects.toThrow("REDIRECT:/onboarding/salon");
    salon = { id: "s", plan: "reviews", name: "x", serviceStatus: "pending" };
    await expect(layout()).rejects.toThrow("REDIRECT:/onboarding/status");
  });

  it("無償提供・テスト店舗はダッシュボードを表示する", async () => {
    for (const status of ["complimentary", "test"] as const) {
      salon = { id: "s", plan: "reviews", name: "x", serviceStatus: status };
      await expect(layout()).resolves.toBeTruthy();
    }
    expect(redirect).not.toHaveBeenCalled();
  });

  it("ログインしていなければ /login へ", async () => {
    account = null;
    await expect(layout()).rejects.toThrow("REDIRECT:/login");
  });
});

describe("お客様の店舗の登録(registerOwnSalonAction)", () => {
  const valid = { name: "私のサロン", contactName: "山田 花子", businessType: "", contactEmailMode: "same", contactEmail: "", contactPhone: "03-0000-0000" };

  it("管理者・本人確認がまだのセッションでは、DB を呼ばずに断る", async () => {
    const { registerOwnSalonAction } = await import("@/app/onboarding/actions");
    account = trusted({ isOperator: true });
    expect(await registerOwnSalonAction(valid)).toEqual({ ok: false, error: "運営管理のアカウントでは店舗を登録できません。" });
    account = trusted({ verified: false, sessionTrusted: false });
    expect((await registerOwnSalonAction(valid)).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("入力の誤りは、その項目のエラーとして返し、DB を呼ばない", async () => {
    const { registerOwnSalonAction } = await import("@/app/onboarding/actions");
    const res = await registerOwnSalonAction({ ...valid, name: "", contactEmailMode: "other", contactEmail: "bad" });
    expect(res).toMatchObject({ ok: false, fieldErrors: { name: expect.any(String), contactEmail: expect.any(String) } });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("所有者・区分・プランは送らない(入力に紛れた値は無視する)。2回目は既存の店舗へ進む", async () => {
    const { registerOwnSalonAction } = await import("@/app/onboarding/actions");
    rpc.mockResolvedValueOnce({ data: { result: "created", salon_id: "s1" }, error: null });
    const res = await registerOwnSalonAction({ ...valid, ownerId: "attacker", service_status: "complimentary", plan: "salonpack" });
    expect(res).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = rpc.mock.calls[0];
    expect(fn).toBe("create_own_salon");
    expect(Object.keys(args).sort()).toEqual(["p_business_type", "p_contact_email", "p_contact_name", "p_contact_phone", "p_name", "p_slug"]);
    expect(args).toMatchObject({ p_name: "私のサロン", p_contact_name: "山田 花子", p_contact_email: null, p_contact_phone: "03-0000-0000" });
    rpc.mockResolvedValueOnce({ data: { result: "already_exists", salon_id: "s1" }, error: null });
    expect(await registerOwnSalonAction(valid)).toEqual({ ok: true });
  });

  it("ログイン用と同じアドレスを連絡用に入力したときは、保存しない(ログイン用と同じとして扱う)", async () => {
    const { registerOwnSalonAction } = await import("@/app/onboarding/actions");
    rpc.mockResolvedValueOnce({ data: { result: "created", salon_id: "s1" }, error: null });
    await registerOwnSalonAction({ ...valid, contactEmailMode: "other", contactEmail: "OWNER@example.test" });
    expect(rpc.mock.calls[0][1].p_contact_email).toBeNull();
  });
});
