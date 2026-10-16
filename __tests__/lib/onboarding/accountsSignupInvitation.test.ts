import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { prepareLoginAccount } from "@/lib/onboarding/accounts";
import { requestConfirmationResend, requestSignup } from "@/lib/onboarding/signup";
import { sendInvitationNotice } from "@/lib/onboarding/invitation";
import type { AuthEmailPolicy } from "@/lib/onboarding/authEmailPolicy";

const SIM: AuthEmailPolicy = { mode: "simulated", reason: "testdb" };
const LIVE: AuthEmailPolicy = { mode: "live" };

function adminWith(rpcResults: Record<string, unknown | unknown[]>) {
  const queues: Record<string, unknown[]> = Object.fromEntries(
    Object.entries(rpcResults).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]),
  );
  const rpc = vi.fn(async (fn: string) => {
    const q = queues[fn];
    if (!q || q.length === 0) return { data: "ok", error: null };
    const v = q.length > 1 ? q.shift() : q[0];
    return { data: v, error: null };
  });
  const authAdmin = {
    createUser: vi.fn(async () => ({ data: { user: { id: "new-user" } }, error: null })),
    updateUserById: vi.fn(async () => ({ data: {}, error: null })),
    generateLink: vi.fn(async () => ({ data: { user: { id: "new-user" }, properties: { hashed_token: "h" } }, error: null })),
    inviteUserByEmail: vi.fn(async () => ({ data: {}, error: null })),
  };
  return { client: { rpc, auth: { admin: authAdmin } } as unknown as SupabaseClient, rpc, authAdmin };
}

describe("運営が紐付けるアカウント(prepareLoginAccount)", () => {
  it("新しいアドレス: パスワード無しで作り、set_new を記録する", async () => {
    const a = adminWith({ admin_account_lookup: { result: "none" } });
    expect(await prepareLoginAccount(a.client, "op", "new@example.test")).toEqual({ ok: true, userId: "new-user", kind: "new" });
    expect(a.authAdmin.createUser).toHaveBeenCalledWith({ email: "new@example.test", email_confirm: false });
    expect(a.rpc).toHaveBeenCalledWith("account_requirement_set", { p_user_id: "new-user", p_mode: "set_new", p_reason: "operator_invite", p_only_if_absent: false });
  });

  it("未確認の既存のアカウント: 運営の明示的な紐付けのときだけ、パスワードを無効にする(乱数)", async () => {
    const a = adminWith({ admin_account_lookup: { result: "found", user_id: "u1", email_confirmed: false, verified: false, is_operator: false } });
    expect(await prepareLoginAccount(a.client, "op", "x@example.test")).toEqual({ ok: true, userId: "u1", kind: "unconfirmed" });
    const [[id, attrs]] = a.authAdmin.updateUserById.mock.calls as unknown as Array<[string, { password: string }]>;
    expect(id).toBe("u1");
    expect(attrs.password.length).toBeGreaterThan(60);
    expect(a.authAdmin.createUser).not.toHaveBeenCalled();
  });

  it("確認済み・本人確認済み: パスワードは変えない", async () => {
    const a = adminWith({ admin_account_lookup: { result: "found", user_id: "u2", email_confirmed: true, verified: true, is_operator: false } });
    expect(await prepareLoginAccount(a.client, "op", "y@example.test")).toEqual({ ok: true, userId: "u2", kind: "verified" });
    expect(a.authAdmin.updateUserById).not.toHaveBeenCalled();
  });

  it("管理者・店舗を持つ・確認済みで本人確認がまだ: 紐付けない(何も変えない)", async () => {
    for (const [lookup, reason] of [
      [{ result: "found", user_id: "u", email_confirmed: true, verified: true, is_operator: true }, "operator"],
      [{ result: "found", user_id: "u", email_confirmed: true, verified: true, is_operator: false, salon_id: "s", salon_name: "既存" }, "has_salon"],
      [{ result: "found", user_id: "u", email_confirmed: true, verified: false, is_operator: false }, "unverified"],
      [{ result: "ambiguous" }, "ambiguous"],
    ] as const) {
      const a = adminWith({ admin_account_lookup: lookup });
      const res = await prepareLoginAccount(a.client, "op", "z@example.test");
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.account.reason).toBe(reason);
      expect(a.authAdmin.updateUserById).not.toHaveBeenCalled();
      expect(a.authAdmin.createUser).not.toHaveBeenCalled();
    }
  });

  it("同時の操作で先に作られていたら、探し直して再利用する(重複して作らない)", async () => {
    const a = adminWith({
      admin_account_lookup: [{ result: "none" }, { result: "found", user_id: "u3", email_confirmed: false, verified: false, is_operator: false }],
    });
    a.authAdmin.createUser.mockResolvedValueOnce({ data: { user: null }, error: { code: "email_exists" } } as never);
    expect(await prepareLoginAccount(a.client, "op", "race@example.test")).toEqual({ ok: true, userId: "u3", kind: "unconfirmed" });
  });
});

describe("お客様の新規登録(requestSignup)", () => {
  it("アカウントが無い: 登録し、入れ直しで本人確認できる(confirm_or_set)", async () => {
    const a = adminWith({
      account_lookup_for_signup: [[], [{ user_id: "new-user", email_confirmed: false, created_at: "2026-10-14T00:00:00Z", verified: false }]],
    });
    expect(await requestSignup({ admin: a.client, policy: SIM }, "n@example.test", "pw-12345678")).toEqual({ result: "simulated" });
    expect(a.rpc).toHaveBeenCalledWith("account_requirement_set", { p_user_id: "new-user", p_mode: "confirm_or_set", p_reason: "self_signup", p_only_if_absent: true });
  });

  it("未確認のアカウントがある: パスワードには触れず、本人確認は「新しく設定する」にし、確認メールを送り直す", async () => {
    const a = adminWith({ account_lookup_for_signup: [[{ user_id: "u1", email_confirmed: false, created_at: "2026-10-01T00:00:00Z", verified: false }]] });
    const anonAuth = { resend: vi.fn(async () => ({ data: {}, error: null })), signUp: vi.fn() };
    const res = await requestSignup({ admin: a.client, policy: LIVE, appUrl: "https://app.example.test", newAnonClient: () => ({ auth: anonAuth }) as never }, "u1@example.test", "pw-12345678");
    expect(res).toEqual({ result: "resent" });
    expect(a.rpc).toHaveBeenCalledWith("account_requirement_set", { p_user_id: "u1", p_mode: "set_new", p_reason: "self_signup_repeat", p_only_if_absent: false });
    expect(anonAuth.signUp).not.toHaveBeenCalled();
    expect(a.authAdmin.updateUserById).not.toHaveBeenCalled();
  });

  it("確認済みのアカウントがある: 何もしない(応答は共通の文で出す)", async () => {
    const a = adminWith({ account_lookup_for_signup: [[{ user_id: "u2", email_confirmed: true, created_at: "2026-10-01T00:00:00Z", verified: true }]] });
    expect(await requestSignup({ admin: a.client, policy: LIVE, appUrl: "https://app.example.test" }, "u2@example.test", "pw-12345678")).toEqual({
      result: "already_registered",
    });
    expect(a.authAdmin.generateLink).not.toHaveBeenCalled();
    expect(a.authAdmin.updateUserById).not.toHaveBeenCalled();
    expect(await requestConfirmationResend({ admin: a.client, policy: LIVE }, "u2@example.test")).toEqual({ result: "already_registered" });
  });
});

describe("招待と案内の送信(sendInvitationNotice)", () => {
  it("始める → 送る → 結果を記録する。送信だけ失敗したら failed(店舗はそのまま)", async () => {
    const a = adminWith({ admin_invitation_begin: { result: "ok", attempt_id: "att", kind: "invite", email: "o@example.test" } });
    a.authAdmin.inviteUserByEmail.mockResolvedValueOnce({ data: {}, error: { code: "email_address_not_authorized" } } as never);
    const res = await sendInvitationNotice({ admin: a.client, policy: LIVE, appUrl: "https://app.example.test" }, { operatorId: "op", salonId: "s", requestId: "r" });
    expect(res).toEqual({ status: "failed", kind: "invite", code: "address_not_authorized" });
    expect(a.rpc).toHaveBeenCalledWith("admin_invitation_finish", { p_actor_user_id: "op", p_attempt_id: "att", p_result: "failed", p_error_code: "address_not_authorized" });
  });

  it("本人確認済みには店舗登録のお知らせ。送らない環境では simulated を記録する", async () => {
    const a = adminWith({ admin_invitation_begin: { result: "ok", attempt_id: "att", kind: "salon_notice", email: "o@example.test" } });
    expect(await sendInvitationNotice({ admin: a.client, policy: SIM }, { operatorId: "op", salonId: "s", requestId: "r" })).toEqual({ status: "simulated", kind: "salon_notice" });
    expect(a.rpc).toHaveBeenCalledWith("admin_invitation_finish", { p_actor_user_id: "op", p_attempt_id: "att", p_result: "simulated", p_error_code: null });
  });

  it("制限にかかったら送らない", async () => {
    const a = adminWith({ admin_invitation_begin: { result: "cooldown", retry_after_seconds: 42 } });
    expect(await sendInvitationNotice({ admin: a.client, policy: LIVE }, { operatorId: "op", salonId: "s", requestId: "r" })).toEqual({ status: "cooldown", retryAfterSeconds: 42 });
    expect(a.authAdmin.inviteUserByEmail).not.toHaveBeenCalled();
  });
});
