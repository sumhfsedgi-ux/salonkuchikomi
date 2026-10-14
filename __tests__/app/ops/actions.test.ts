import { beforeEach, describe, expect, it, vi } from "vitest";

// 運営管理の保存操作: 管理者でなければ何もしない(404)。操作した管理者は、サーバーで認証したユーザーの ID だけを使う。

const notFound = vi.fn(() => {
  throw new Error("NOT_FOUND");
});
vi.mock("next/navigation", () => ({ notFound, redirect: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let currentUser: { id: string; email: string } | null = null;
let operators = new Set<string>();
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/supabase/queries", () => ({ getAuthedUser: async () => currentUser }));
// 0025: 管理画面は、信頼できるセッション(本人確認のあと・サインアウトしていない)でだけ使える。
const sessionTrusted = true;
vi.mock("@/lib/onboarding/accountState", () => ({
  getAccountState: async () => ({ emailConfirmed: true, verified: true, verificationMode: "set_new", sessionTrusted, emailLinkSession: false, isOperator: true }),
}));

const rpc = vi.fn<(name: string, params: Record<string, unknown>) => Promise<{ data: unknown; error: null }>>(async () => ({
  data: { result: "saved", version: 1, inflight_sends: 0 },
  error: null,
}));
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => ({
    rpc,
    from: () => ({
      select: () => ({
        eq: (_c: string, userId: string) => ({
          is: () => ({ maybeSingle: async () => ({ data: operators.has(userId) ? { user_id: userId } : null, error: null }) }),
        }),
      }),
    }),
  }),
}));

const SALON = "10000000-0000-4000-8000-000000000001";
const input = {
  salonId: SALON,
  expectedVersion: 0,
  expected: { plan: "salonpack" as const, overrides: { blog: "inherit" as const } },
  changes: { overrides: { blog: "deny" as const } },
};

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = null;
  operators = new Set(["ops-user"]);
});

describe("saveEntitlementsAction", () => {
  it("未ログイン・一般のユーザーは 404 で、DB を呼ばない", async () => {
    const { saveEntitlementsAction } = await import("@/app/ops/salons/[id]/actions");
    await expect(saveEntitlementsAction(input)).rejects.toThrow("NOT_FOUND");
    currentUser = { id: "owner-user", email: "owner@example.test" };
    await expect(saveEntitlementsAction(input)).rejects.toThrow("NOT_FOUND");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("管理者は保存でき、操作した管理者にはサーバーで認証したユーザー ID を渡す(入力に紛れた値は使わない)", async () => {
    currentUser = { id: "ops-user", email: "ops@example.test" };
    const { saveEntitlementsAction } = await import("@/app/ops/salons/[id]/actions");
    const res = await saveEntitlementsAction({ ...input, actorUserId: "attacker" } as never);
    expect(res).toEqual({ ok: true, changed: true, message: "保存しました。" });
    expect(rpc).toHaveBeenCalledWith("admin_update_salon_entitlements", expect.objectContaining({ p_actor_user_id: "ops-user", p_salon_id: SALON }));
  });

  it("版数・値が違えば conflict として再読み込みを案内する", async () => {
    currentUser = { id: "ops-user", email: "ops@example.test" };
    rpc.mockResolvedValueOnce({ data: { result: "conflict", version: 3 } as never, error: null });
    const { saveEntitlementsAction } = await import("@/app/ops/salons/[id]/actions");
    expect(await saveEntitlementsAction(input)).toMatchObject({ ok: false, conflict: true });
  });

  it("カタログに無い機能・長すぎるメモは DB を呼ぶ前に断る", async () => {
    currentUser = { id: "ops-user", email: "ops@example.test" };
    const { saveEntitlementsAction } = await import("@/app/ops/salons/[id]/actions");
    expect((await saveEntitlementsAction({ ...input, changes: { overrides: { google_reviews: "allow" } } } as never)).ok).toBe(false);
    expect((await saveEntitlementsAction({ ...input, note: "あ".repeat(501) })).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("releaseHoldAction", () => {
  it("一般のユーザーは 404。管理者の解除は、サーバーで認証したユーザー ID で DB に渡す", async () => {
    const { releaseHoldAction } = await import("@/app/ops/salons/[id]/actions");
    const args = { salonId: SALON, featureKey: "reservation_notifications" as const, holdId: "30000000-0000-4000-8000-000000000001" };
    currentUser = { id: "owner-user", email: "owner@example.test" };
    await expect(releaseHoldAction(args)).rejects.toThrow("NOT_FOUND");
    currentUser = { id: "ops-user", email: "ops@example.test" };
    rpc.mockResolvedValueOnce({ data: "released" as never, error: null });
    expect(await releaseHoldAction(args)).toMatchObject({ ok: true });
    expect(rpc).toHaveBeenCalledWith("feature_hold_release", expect.objectContaining({ p_actor_user_id: "ops-user", p_expected_hold_id: args.holdId }));
  });
});
