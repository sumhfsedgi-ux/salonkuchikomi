import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resendSignupConfirmation, sendInvite, sendSalonNotice, sendSignup, sendVerificationLink } from "@/lib/onboarding/authEmail";
import type { AuthEmailPolicy } from "@/lib/onboarding/authEmailPolicy";

// 認証のメールを送る呼び出しは lib/onboarding/authEmail.ts だけ。送らない環境では Supabase の送信の API を呼ばない。
// 既存のパスワード再設定(components/auth/ForgotPasswordForm.tsx のブラウザからの resetPasswordForEmail)は、
// 今回の送信の方針の対象外(例外)として、ここに固定する。

function clients() {
  const admin = {
    auth: {
      admin: {
        inviteUserByEmail: vi.fn(async () => ({ data: {}, error: null })),
        generateLink: vi.fn(async () => ({ data: { user: { id: "u1" }, properties: { hashed_token: "h" } }, error: null })),
      },
    },
  };
  const anonAuth = {
    signUp: vi.fn(async () => ({ data: { user: { id: "u2" } }, error: null })),
    resend: vi.fn(async () => ({ data: {}, error: null })),
    signInWithOtp: vi.fn(async () => ({ data: {}, error: null })),
    resetPasswordForEmail: vi.fn(async () => ({ data: {}, error: null })),
  };
  return { admin: admin as unknown as SupabaseClient, adminAuth: admin.auth.admin, anonAuth, newAnonClient: () => ({ auth: anonAuth }) as unknown as SupabaseClient };
}

const LIVE: AuthEmailPolicy = { mode: "live" };
const SIM: AuthEmailPolicy = { mode: "simulated", reason: "development" };
const VERIFY: AuthEmailPolicy = { mode: "verify", recipients: new Set(["ops@example.test"]) };
const APP = "https://app.example.test/some/path";

describe("認証のメールの送信(authEmail)", () => {
  it("送らない環境では、Supabase の送信の API を呼ばない(新規登録はメールを送らない generateLink でアカウントだけ作る)", async () => {
    const c = clients();
    const deps = { admin: c.admin, newAnonClient: c.newAnonClient, policy: SIM, appUrl: APP };
    expect(await sendSignup(deps, "a@example.test", "pw-12345678")).toEqual({ outcome: "simulated", userId: "u1" });
    expect(await resendSignupConfirmation(deps, "a@example.test")).toEqual({ outcome: "simulated" });
    expect(await sendInvite(deps, "a@example.test")).toEqual({ outcome: "simulated" });
    expect(await sendSalonNotice(deps, "a@example.test")).toEqual({ outcome: "simulated" });
    expect(await sendVerificationLink(deps, "a@example.test")).toEqual({ outcome: "simulated" });
    expect(c.adminAuth.generateLink).toHaveBeenCalledTimes(1);
    for (const fn of Object.values(c.anonAuth)) expect(fn).not.toHaveBeenCalled();
    expect(c.adminAuth.inviteUserByEmail).not.toHaveBeenCalled();
  });

  it("本番では、種類ごとのテンプレートの呼び出しで送り、戻り先は /auth/confirm", async () => {
    const c = clients();
    const deps = { admin: c.admin, newAnonClient: c.newAnonClient, policy: LIVE, appUrl: APP };
    await sendSignup(deps, "a@example.test", "pw-12345678");
    expect(c.anonAuth.signUp).toHaveBeenCalledWith({ email: "a@example.test", password: "pw-12345678", options: { emailRedirectTo: "https://app.example.test/auth/confirm" } });
    await sendInvite(deps, "a@example.test");
    expect(c.adminAuth.inviteUserByEmail).toHaveBeenCalledWith("a@example.test", { redirectTo: "https://app.example.test/auth/confirm" });
    await sendSalonNotice(deps, "a@example.test");
    expect(c.anonAuth.signInWithOtp).toHaveBeenCalledWith({ email: "a@example.test", options: { shouldCreateUser: false, emailRedirectTo: "https://app.example.test/auth/confirm" } });
    await sendVerificationLink(deps, "a@example.test");
    expect(c.anonAuth.resetPasswordForEmail).toHaveBeenCalledWith("a@example.test", { redirectTo: "https://app.example.test/auth/confirm" });
  });

  it("verify では許可したアドレスにだけ送る。許可していない新規登録は何もしない", async () => {
    const c = clients();
    const deps = { admin: c.admin, newAnonClient: c.newAnonClient, policy: VERIFY, appUrl: APP };
    expect(await sendSignup(deps, "customer@example.test", "pw-12345678")).toEqual({ outcome: "skipped" });
    expect(await sendInvite(deps, "customer@example.test")).toEqual({ outcome: "simulated" });
    expect(c.adminAuth.generateLink).not.toHaveBeenCalled();
    expect(c.adminAuth.inviteUserByEmail).not.toHaveBeenCalled();
    expect(await sendInvite(deps, "ops@example.test")).toEqual({ outcome: "accepted" });
  });

  it("戻り先の設定が無ければ送らない。エラーは分類して返す", async () => {
    const c = clients();
    expect(await sendInvite({ admin: c.admin, policy: LIVE, appUrl: undefined }, "a@example.test")).toEqual({ outcome: "failed", code: "config_missing" });
    c.adminAuth.inviteUserByEmail.mockResolvedValueOnce({ data: {}, error: { code: "over_email_send_rate_limit", status: 429 } } as never);
    expect(await sendInvite({ admin: c.admin, policy: LIVE, appUrl: APP }, "a@example.test")).toEqual({ outcome: "failed", code: "rate_limited" });
  });
});

describe("メールを送る呼び出しの場所(静的な確認)", () => {
  const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
  const CALLS = /\.(signUp|resend|signInWithOtp|inviteUserByEmail|resetPasswordForEmail)\s*\(/;
  const ALLOWED = new Set([
    path.join("lib", "onboarding", "authEmail.ts"),
    // 既存のパスワード再設定(ブラウザから)。今回の送信の方針の対象外。
    path.join("components", "auth", "ForgotPasswordForm.tsx"),
  ]);
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  }
  it("app・lib・components の中で、authEmail.ts と既存のパスワード再設定の画面だけ", () => {
    const found = ["app", "lib", "components"]
      .flatMap((d) => walk(path.join(ROOT, d)))
      .filter((f) => CALLS.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(ROOT, f));
    expect(new Set(found)).toEqual(ALLOWED);
  });
});
