import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 新規登録・確認メールの再送の送信の制限(0026)と、登録済みかどうかを漏らさない応答。
//   - 応答は、アカウントの状態(新しい・確認待ち・確認済み)や Supabase の送信の結果(断られた・失敗した)で変えない
//   - 待ち時間はサーバーが決める(接続元の上限 → アドレスごとの間隔の順。間隔の記録が読めなければ、どのアドレスでも同じ応答)
//   - ログには失敗の種類だけを残す(メールアドレス・パスワードは残さない)

vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": "203.0.113.7" }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/supabase/standalone", () => ({ createStandaloneAnonClient: () => ({}) }));
vi.mock("@/lib/supabase/queries", () => ({ getAuthedUser: async () => null, getCurrentSalon: async () => null }));
vi.mock("@/lib/onboarding/accountState", () => ({ getAccountState: async () => null }));

let policyMode: "live" | "simulated" = "live";
let signupEnabled = true;
vi.mock("@/lib/onboarding/authEmailPolicy", () => ({
  isSelfSignupEnabled: () => signupEnabled,
  resolveAuthEmailPolicy: () => ({ mode: policyMode }),
}));

type SignupResult = { result: string; failureCode?: string };
const requestSignup = vi.fn<(deps: unknown, email: string, password: string) => Promise<SignupResult>>();
const requestConfirmationResend = vi.fn<(deps: unknown, email: string) => Promise<SignupResult>>();
vi.mock("@/lib/onboarding/signup", () => ({
  requestSignup: (...args: [unknown, string, string]) => requestSignup(...args),
  requestConfirmationResend: (...args: [unknown, string]) => requestConfirmationResend(...args),
}));
vi.mock("@/lib/onboarding/authEmail", () => ({ sendVerificationLink: vi.fn() }));

// DB: 接続元の上限(rate_limit_hit)と、アドレスごとの間隔(auth_email_cooldown_take)
let ipAllowed = true;
let cooldownLeft = 0;
let cooldownError = false;
const rpc = vi.fn(async (name: string, params: Record<string, unknown>) => {
  if (name === "rate_limit_hit") return { data: ipAllowed, error: null };
  if (name === "auth_email_cooldown_take") {
    void params;
    return cooldownError ? { data: null, error: { message: "db" } } : { data: cooldownLeft, error: null };
  }
  return { data: null, error: null };
});
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: () => ({ rpc }) }));

const input = { email: "Someone@Example.test", password: "Passw0rd-123", passwordConfirm: "Passw0rd-123" };

beforeEach(() => {
  vi.clearAllMocks();
  policyMode = "live";
  signupEnabled = true;
  ipAllowed = true;
  cooldownLeft = 0;
  cooldownError = false;
  requestSignup.mockResolvedValue({ result: "requested" });
  requestConfirmationResend.mockResolvedValue({ result: "resent" });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("新規登録(signupAction)", () => {
  it("アカウントの状態・Supabase の送信の結果にかかわらず、応答は同じ(断られた・失敗したことも伝えない)", async () => {
    const { signupAction } = await import("@/app/auth/actions");
    const outcomes: Array<() => void> = [
      () => requestSignup.mockResolvedValueOnce({ result: "requested" }),
      () => requestSignup.mockResolvedValueOnce({ result: "resent" }),
      () => requestSignup.mockResolvedValueOnce({ result: "already_registered" }),
      () => requestSignup.mockResolvedValueOnce({ result: "failed", failureCode: "rate_limited" }),
      () => requestSignup.mockResolvedValueOnce({ result: "failed", failureCode: "send_failed" }),
      () => requestSignup.mockRejectedValueOnce(new Error("network")),
    ];
    const responses = [];
    for (const arrange of outcomes) {
      arrange();
      responses.push(await signupAction(input));
    }
    for (const r of responses) expect(r).toEqual(responses[0]);
    expect(responses[0]).toEqual({ ok: true, simulated: false, retryAfterSeconds: 65, retryScope: "address" });
  });

  it("アドレスごとの間隔の中は、サーバーの残りの秒数を返し、アカウントを調べない", async () => {
    const { signupAction } = await import("@/app/auth/actions");
    cooldownLeft = 40;
    expect(await signupAction(input)).toMatchObject({ ok: false, retryAfterSeconds: 40, retryScope: "address" });
    expect(requestSignup).not.toHaveBeenCalled();
  });

  it("接続元の上限にかかったときは、アドレスの間隔を記録せず、どのアドレスにも当てはまる待ち時間を返す", async () => {
    const { signupAction } = await import("@/app/auth/actions");
    ipAllowed = false;
    const r = await signupAction(input);
    expect(r).toMatchObject({ ok: false, retryScope: "connection" });
    expect(r.retryAfterSeconds).toBeGreaterThan(0);
    expect(r.retryAfterSeconds).toBeLessThanOrEqual(3601);
    expect(rpc.mock.calls.some(([name]) => name === "auth_email_cooldown_take")).toBe(false);
    expect(requestSignup).not.toHaveBeenCalled();
  });

  it("間隔の記録が読めないときは、どのアドレスでも同じ「時間をおいて」の応答にし、送らない", async () => {
    const { signupAction } = await import("@/app/auth/actions");
    cooldownError = true;
    expect(await signupAction(input)).toEqual({ ok: false, error: "処理できませんでした。時間をおいて、もう一度お試しください。" });
    expect(requestSignup).not.toHaveBeenCalled();
  });

  it("間隔は AUTH_EMAIL_MIN_INTERVAL_SECONDS で変えられる。キーにアドレスをそのまま入れない", async () => {
    vi.stubEnv("AUTH_EMAIL_MIN_INTERVAL_SECONDS", "90");
    const { signupAction } = await import("@/app/auth/actions");
    expect(await signupAction(input)).toMatchObject({ ok: true, retryAfterSeconds: 90 });
    const call = rpc.mock.calls.find(([name]) => name === "auth_email_cooldown_take")!;
    expect(call[1]).toMatchObject({ p_seconds: 90 });
    expect(String(call[1].p_key)).toMatch(/^confirm:[0-9a-f]{32}$/);
    expect(String(call[1].p_key)).not.toMatch(/example/i);
  });

  it("送信の失敗のログには、失敗の種類だけを残す(アドレス・パスワードは残さない)", async () => {
    const { signupAction } = await import("@/app/auth/actions");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    requestSignup.mockResolvedValueOnce({ result: "failed", failureCode: "rate_limited" });
    await signupAction(input);
    expect(warn).toHaveBeenCalledWith("[auth-email] signup: rate_limited");
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).not.toMatch(/example\.test|Passw0rd/i);
    warn.mockRestore();
  });

  it("新規登録の受付が閉じているときは、送らない(DB も呼ばない)", async () => {
    const { signupAction } = await import("@/app/auth/actions");
    signupEnabled = false;
    expect(await signupAction(input)).toMatchObject({ ok: false });
    expect(rpc).not.toHaveBeenCalled();
    expect(requestSignup).not.toHaveBeenCalled();
  });
});

describe("確認メールの再送(resendConfirmationAction)", () => {
  it("アカウントの状態・送信の結果にかかわらず、応答は同じ。新規登録と同じアドレスの間隔を使う", async () => {
    const { resendConfirmationAction, signupAction } = await import("@/app/auth/actions");
    const responses = [];
    for (const result of ["resent", "already_registered", "failed"]) {
      requestConfirmationResend.mockResolvedValueOnce({ result });
      responses.push(await resendConfirmationAction({ email: input.email }));
    }
    requestConfirmationResend.mockRejectedValueOnce(new Error("network"));
    responses.push(await resendConfirmationAction({ email: input.email }));
    for (const r of responses) expect(r).toEqual(responses[0]);
    expect(responses[0]).toMatchObject({ ok: true, retryAfterSeconds: 65, retryScope: "address" });

    await signupAction(input);
    const keys = rpc.mock.calls.filter(([name]) => name === "auth_email_cooldown_take").map(([, p]) => p.p_key);
    expect(new Set(keys).size).toBe(1);
  });

  it("新規登録の受付が閉じていても止めない(招待のお客様の経路ではなく、Supabase の再送は直接も呼べるため)", async () => {
    const { resendConfirmationAction } = await import("@/app/auth/actions");
    signupEnabled = false;
    expect(await resendConfirmationAction({ email: input.email })).toMatchObject({ ok: true });
    expect(requestConfirmationResend).toHaveBeenCalledTimes(1);
  });

  it("検証モードでは、受付の文に「実際のメールは送信していません」を付ける(ログイン画面の再送)", async () => {
    const { resendConfirmationAction } = await import("@/app/auth/actions");
    policyMode = "simulated";
    expect(await resendConfirmationAction({ email: input.email })).toMatchObject({
      ok: true,
      simulated: true,
      message: "再送処理を受け付けました。現在は検証モードのため、実際のメールは送信していません。",
    });
  });
});
