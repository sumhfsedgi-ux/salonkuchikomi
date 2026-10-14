import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import * as verification from "@/lib/onboarding/verification";

// 本人確認の手続き(サーバー)。Supabase は模擬。実際の Supabase Auth での確認は scripts/testdb/auth-verification.test.ts。
const UID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-8222-222222222222";

function userClient(opts: { methods?: string[]; updateError?: { code?: string; status?: number; name?: string } | null; claims?: boolean } = {}) {
  const updateUser = vi.fn(async () => ({ data: {}, error: opts.updateError ?? null }));
  const signOut = vi.fn(async () => ({ error: null }));
  const client = {
    auth: {
      getClaims: vi.fn(async () =>
        opts.claims === false
          ? { data: null, error: { message: "no" } }
          : { data: { claims: { sub: UID, session_id: SID, email: "owner@example.test", amr: (opts.methods ?? ["otp"]).map((method) => ({ method })) } }, error: null },
      ),
      updateUser,
      signOut,
    },
  } as unknown as SupabaseClient;
  return { client, updateUser, signOut };
}

function admin(result: string | null = "recorded") {
  const rpc = vi.fn(async () => (result === null ? { data: null, error: { message: "db" } } : { data: result, error: null }));
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

function anon(ok: boolean) {
  const signOut = vi.fn(async () => ({ error: null }));
  const signInWithPassword = vi.fn(async () =>
    ok ? { data: { user: { id: UID }, session: { access_token: "t" } }, error: null } : { data: { user: null, session: null }, error: { code: "invalid_credentials" } },
  );
  return { factory: () => ({ auth: { signInWithPassword, signOut } }) as unknown as SupabaseClient, signInWithPassword, signOut };
}

describe("本人確認(lib/onboarding/verification.ts)", () => {
  it("記録だけを行う入口は無い(公開しているのは手続きの関数だけ)", () => {
    expect(Object.keys(verification).sort()).toEqual(["readSessionClaims", "resetPasswordWithRecoverySession", "verifyByCurrentPassword", "verifyBySettingPassword"]);
  });

  it("パスワードでログインしたセッションでは、パスワードを変えず、記録もしない", async () => {
    const u = userClient({ methods: ["password"] });
    const a = admin();
    expect(await verification.verifyBySettingPassword({ userClient: u.client, admin: a.client, newAnonClient: anon(true).factory }, "new-password-1")).toEqual({
      ok: false,
      reason: "not_email_link",
    });
    expect(u.updateUser).not.toHaveBeenCalled();
    expect(a.rpc).not.toHaveBeenCalled();
  });

  it("設定に失敗したら記録しない(弱い・同じ・セッションが消えた を分ける)", async () => {
    for (const [error, reason] of [
      [{ code: "weak_password" }, "weak_password"],
      [{ code: "same_password" }, "same_password"],
      [{ name: "AuthSessionMissingError", status: 400 }, "session_expired"],
      [{ code: "unexpected_failure", status: 500 }, "update_failed"],
    ] as const) {
      const u = userClient({ updateError: error });
      const a = admin();
      expect(await verification.verifyBySettingPassword({ userClient: u.client, admin: a.client, newAnonClient: anon(true).factory }, "new-password-1")).toEqual({ ok: false, reason });
      expect(a.rpc).not.toHaveBeenCalled();
    }
  });

  it("設定に成功したら、検証済みの JWT のセッションで記録し、ほかのセッションを切る", async () => {
    const u = userClient();
    const a = admin("recorded");
    expect(await verification.verifyBySettingPassword({ userClient: u.client, admin: a.client, newAnonClient: anon(true).factory }, "new-password-1")).toEqual({ ok: true, status: "recorded" });
    expect(a.rpc).toHaveBeenCalledWith("account_verification_record", { p_user_id: UID, p_session_id: SID, p_method: "password_set" });
    expect(u.signOut).toHaveBeenCalledWith({ scope: "others" });
  });

  it("DB が記録を断ったら成功にしない", async () => {
    for (const r of ["not_email_link", "email_unconfirmed", null]) {
      const u = userClient();
      const res = await verification.verifyBySettingPassword({ userClient: u.client, admin: admin(r).client, newAnonClient: anon(true).factory }, "new-password-1");
      expect(res.ok).toBe(false);
      expect(u.signOut).not.toHaveBeenCalled();
    }
  });

  it("入れ直し: 照合に失敗したら記録しない。成功したら照合のセッションを消してから記録する", async () => {
    const bad = anon(false);
    const a1 = admin();
    expect(await verification.verifyByCurrentPassword({ userClient: userClient().client, admin: a1.client, newAnonClient: bad.factory }, "wrong")).toEqual({
      ok: false,
      reason: "password_mismatch",
    });
    expect(a1.rpc).not.toHaveBeenCalled();
    const good = anon(true);
    const a2 = admin("recorded");
    expect(await verification.verifyByCurrentPassword({ userClient: userClient().client, admin: a2.client, newAnonClient: good.factory }, "right")).toEqual({
      ok: true,
      status: "recorded",
    });
    expect(good.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(a2.rpc).toHaveBeenCalledWith("account_verification_record", { p_user_id: UID, p_session_id: SID, p_method: "password_confirmed" });
  });

  it("パスワード再設定: どのアカウントでも設定し、メールのリンクのセッションのときだけ本人確認を記録する", async () => {
    const recovery = userClient({ methods: ["otp"] });
    const a = admin("recorded");
    expect(await verification.resetPasswordWithRecoverySession({ userClient: recovery.client, admin: a.client, newAnonClient: anon(true).factory }, "new-password-1")).toEqual({
      ok: true,
      verified: true,
    });
    const pw = userClient({ methods: ["password"] });
    const a2 = admin("recorded");
    expect(await verification.resetPasswordWithRecoverySession({ userClient: pw.client, admin: a2.client, newAnonClient: anon(true).factory }, "new-password-1")).toEqual({
      ok: true,
      verified: false,
    });
    expect(a2.rpc).not.toHaveBeenCalled();
  });
});
