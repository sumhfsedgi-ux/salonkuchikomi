import { beforeEach, describe, expect, it, vi } from "vitest";

// 運営の「サロンを追加」・利用区分・案内の再送の Server Action。
//   管理者でなければ 404(DB を呼ばない)。古い・本人確認より前のセッションの管理者も 404。
//   操作した人はサーバーで認証した ID だけ。送信だけ失敗しても、店舗は登録済みとして返す(再送できる)。

const notFound = vi.fn(() => {
  throw new Error("NOT_FOUND");
});
vi.mock("next/navigation", () => ({ notFound, redirect: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let currentUser: { id: string; email: string } | null = null;
let operators = new Set<string>();
let sessionTrusted = true;
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/supabase/queries", () => ({ getAuthedUser: async () => currentUser }));
vi.mock("@/lib/onboarding/accountState", () => ({
  getAccountState: async () => ({ emailConfirmed: true, verified: true, verificationMode: "set_new", sessionTrusted, emailLinkSession: false, isOperator: true }),
}));

const DRAFT = "20000000-0000-4000-8000-000000000002";
const SALON = "10000000-0000-4000-8000-000000000001";
let draftRow: Record<string, unknown> | null = null;
const rpcResults: Record<string, unknown> = {};
const rpc = vi.fn(async (name: string) => ({ data: rpcResults[name] ?? null, error: null }));
const createUser = vi.fn(async () => ({ data: { user: { id: "new-user" } }, error: null }));
const updateUserById = vi.fn(async () => ({ data: {}, error: null }));
const inviteUserByEmail = vi.fn(async () => ({ data: {}, error: null }));
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => ({
    rpc,
    auth: { admin: { createUser, updateUserById, inviteUserByEmail, generateLink: vi.fn() } },
    from: (table: string) => ({
      select: () => ({
        eq: (_c: string, v: string) => ({
          is: () => ({ maybeSingle: async () => ({ data: operators.has(v) ? { user_id: v } : null, error: null }) }),
          maybeSingle: async () => ({ data: table === "salon_drafts" ? draftRow : null, error: null }),
        }),
      }),
    }),
  }),
}));

function draft(over: Record<string, unknown> = {}) {
  return {
    id: DRAFT,
    status: "draft",
    name: "運営が登録するサロン",
    contact_name: "担当",
    login_email: "owner@example.test",
    business_type: null,
    contact_email: null,
    contact_phone: null,
    plan: "salonpack",
    service_status: "pending",
    feature_overrides: {},
    salon_id: null,
    version: 3,
    created_at: "2026-10-14T00:00:00Z",
    updated_at: "2026-10-14T00:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = { id: "ops-user", email: "ops@example.test" };
  operators = new Set(["ops-user"]);
  sessionTrusted = true;
  draftRow = draft();
  for (const k of Object.keys(rpcResults)) delete rpcResults[k];
  vi.stubEnv("SALONPACK_VERIFY_MODE", "");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.test");
});

describe("管理者の確認", () => {
  it("一般のユーザー・古いセッションの管理者は 404 で、DB を呼ばない", async () => {
    const { saveDraftAction, registerSalonAction } = await import("@/app/ops/salons/drafts/actions");
    const { saveServiceStatusAction, resendInvitationAction } = await import("@/app/ops/salons/[id]/actions");
    currentUser = { id: "owner-user", email: "owner@example.test" };
    await expect(saveDraftAction({ draftId: null, expectedVersion: null, values: { name: "x" } })).rejects.toThrow("NOT_FOUND");
    currentUser = { id: "ops-user", email: "ops@example.test" };
    sessionTrusted = false;
    await expect(registerSalonAction({ draftId: DRAFT, expectedVersion: 3 })).rejects.toThrow("NOT_FOUND");
    await expect(saveServiceStatusAction({ salonId: SALON, expectedVersion: 0, expectedStatus: "pending", newStatus: "complimentary" })).rejects.toThrow("NOT_FOUND");
    await expect(resendInvitationAction({ salonId: SALON })).rejects.toThrow("NOT_FOUND");
    expect(rpc).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
  });
});

describe("下書き", () => {
  it("サロン名だけで保存でき、操作した人はサーバーで認証した ID", async () => {
    const { saveDraftAction } = await import("@/app/ops/salons/drafts/actions");
    rpcResults.admin_save_salon_draft = { result: "saved", draft_id: DRAFT, version: 0 };
    expect(await saveDraftAction({ draftId: null, expectedVersion: null, values: { name: "名前だけ", actor: "attacker" } })).toEqual({ ok: true, draftId: DRAFT, version: 0 });
    expect(rpc).toHaveBeenCalledWith("admin_save_salon_draft", expect.objectContaining({ p_actor_user_id: "ops-user", p_draft_id: null }));
    expect(createUser).not.toHaveBeenCalled();
    expect(inviteUserByEmail).not.toHaveBeenCalled();
  });

  it("入力の誤りは項目ごとに返し、DB を呼ばない", async () => {
    const { saveDraftAction } = await import("@/app/ops/salons/drafts/actions");
    const res = await saveDraftAction({ draftId: null, expectedVersion: null, values: { name: "", loginEmail: "bad" } });
    expect(res).toMatchObject({ ok: false, fieldErrors: { name: expect.any(String), loginEmail: expect.any(String) } });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("本登録と案内の送信", () => {
  it("新しいアドレス: パスワード無しで作り、本登録し、招待を送る", async () => {
    const { registerSalonAction } = await import("@/app/ops/salons/drafts/actions");
    rpcResults.admin_account_lookup = { result: "none" };
    rpcResults.admin_register_salon = { result: "registered", salon_id: SALON };
    rpcResults.admin_invitation_begin = { result: "ok", attempt_id: "att", kind: "invite", email: "owner@example.test" };
    const res = await registerSalonAction({ draftId: DRAFT, expectedVersion: 3 });
    expect(res).toEqual({ ok: true, salonId: SALON, alreadyRegistered: false, notice: { status: "accepted", kind: "invite" } });
    expect(createUser).toHaveBeenCalledWith({ email: "owner@example.test", email_confirm: false });
    expect(rpc).toHaveBeenCalledWith("admin_register_salon", expect.objectContaining({ p_actor_user_id: "ops-user", p_owner_user_id: "new-user", p_expected_version: 3 }));
    expect(inviteUserByEmail).toHaveBeenCalledWith("owner@example.test", { redirectTo: "https://app.example.test/auth/confirm" });
  });

  it("送信だけ失敗しても、店舗は登録済みとして返す(詳細の画面で「サロンは登録済みですが…」と出し、再送できる)", async () => {
    const { registerSalonAction } = await import("@/app/ops/salons/drafts/actions");
    rpcResults.admin_account_lookup = { result: "none" };
    rpcResults.admin_register_salon = { result: "registered", salon_id: SALON };
    rpcResults.admin_invitation_begin = { result: "ok", attempt_id: "att", kind: "invite", email: "owner@example.test" };
    inviteUserByEmail.mockResolvedValueOnce({ data: {}, error: { code: "email_address_not_authorized" } } as never);
    const res = await registerSalonAction({ draftId: DRAFT, expectedVersion: 3 });
    expect(res).toMatchObject({ ok: true, salonId: SALON, notice: { status: "failed", code: "address_not_authorized" } });
  });

  it("本登録済みの下書き(連打・やり直し)は、アカウントも店舗も作らず、メールも送らない", async () => {
    const { registerSalonAction } = await import("@/app/ops/salons/drafts/actions");
    draftRow = draft({ status: "registered", salon_id: SALON });
    expect(await registerSalonAction({ draftId: DRAFT, expectedVersion: 3 })).toEqual({ ok: true, salonId: SALON, alreadyRegistered: true, notice: null });
    expect(createUser).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("店舗を持つアカウント・管理者・本人確認のまだ済んでいない確認済みのアカウントには紐付けない", async () => {
    const { registerSalonAction } = await import("@/app/ops/salons/drafts/actions");
    rpcResults.admin_account_lookup = { result: "found", user_id: "u", email_confirmed: true, verified: true, is_operator: false, salon_id: "s-existing", salon_name: "既存" };
    expect(await registerSalonAction({ draftId: DRAFT, expectedVersion: 3 })).toMatchObject({ ok: false, existingSalonId: "s-existing" });
    rpcResults.admin_account_lookup = { result: "found", user_id: "u", email_confirmed: true, verified: false, is_operator: false };
    expect((await registerSalonAction({ draftId: DRAFT, expectedVersion: 3 })).ok).toBe(false);
    expect(updateUserById).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalledWith("admin_register_salon", expect.anything());
  });

  it("版数が違えば、何もしない(再読み込みを案内する)", async () => {
    const { registerSalonAction } = await import("@/app/ops/salons/drafts/actions");
    expect(await registerSalonAction({ draftId: DRAFT, expectedVersion: 2 })).toMatchObject({ ok: false, conflict: true });
    expect(createUser).not.toHaveBeenCalled();
  });
});

describe("利用区分の変更と再送", () => {
  it("利用区分だけを変え、操作した人はサーバーで認証した ID", async () => {
    const { saveServiceStatusAction } = await import("@/app/ops/salons/[id]/actions");
    rpcResults.admin_update_salon_service_status = { result: "saved", version: 4, inflight_sends: 0 };
    const res = await saveServiceStatusAction({ salonId: SALON, expectedVersion: 3, expectedStatus: "pending", newStatus: "complimentary" });
    expect(res).toMatchObject({ ok: true, changed: true });
    expect(rpc).toHaveBeenCalledWith(
      "admin_update_salon_service_status",
      expect.objectContaining({ p_actor_user_id: "ops-user", p_salon_id: SALON, p_expected_status: "pending", p_new_status: "complimentary" }),
    );
    rpcResults.admin_update_salon_service_status = { result: "conflict", version: 5 };
    expect(await saveServiceStatusAction({ salonId: SALON, expectedVersion: 3, expectedStatus: "pending", newStatus: "test" })).toMatchObject({ ok: false, conflict: true });
  });

  it("再送: 受付は「届いた」と言わない。制限にかかったら待ち時間を伝える", async () => {
    const { resendInvitationAction } = await import("@/app/ops/salons/[id]/actions");
    rpcResults.admin_invitation_begin = { result: "ok", attempt_id: "att", kind: "salon_notice", email: "owner@example.test" };
    const anonCalls: unknown[] = [];
    vi.doMock("@/lib/supabase/standalone", () => ({
      createStandaloneAnonClient: () => ({ auth: { signInWithOtp: async (a: unknown) => (anonCalls.push(a), { data: {}, error: null }) } }),
    }));
    vi.resetModules();
    const fresh = await import("@/app/ops/salons/[id]/actions");
    const res = await fresh.resendInvitationAction({ salonId: SALON });
    expect(res).toMatchObject({ ok: true });
    if (res.ok) expect(res.message).not.toMatch(/届きました|読まれました/);
    expect(anonCalls).toHaveLength(1);
    rpcResults.admin_invitation_begin = { result: "cooldown", retry_after_seconds: 30 };
    const limited = await resendInvitationAction({ salonId: SALON });
    expect(limited).toMatchObject({ ok: false });
    if (!limited.ok) expect(limited.error).toMatch(/30秒/);
  });
});
