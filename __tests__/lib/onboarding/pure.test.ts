import { describe, expect, it } from "vitest";
import { amrMethods, isEmailLinkSession, parseSessionClaims } from "@/lib/onboarding/sessionClaims";
import { resolveNextStep } from "@/lib/onboarding/nextStep";
import type { AccountState } from "@/lib/onboarding/accountState";
import { linkProblemOf, nextActionsFor, parseAuthLink } from "@/lib/onboarding/authLink";
import { isRealAuthEmailAllowed, isSelfSignupEnabled, resolveAuthEmailPolicy } from "@/lib/onboarding/authEmailPolicy";
import { classifyAuthEmailError } from "@/lib/onboarding/authEmailErrors";
import { isServiceActive } from "@/lib/onboarding/serviceStatus";
import { normalizePhone, parseSalonProfile } from "@/lib/onboarding/salonProfile";

const UID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-8222-222222222222";

describe("JWT の本人確認に要る値(sessionClaims)", () => {
  it("amr は詳細の形・文字列の形のどちらも読む", () => {
    expect(amrMethods([{ method: "otp", timestamp: 1 }])).toEqual(["otp"]);
    expect(amrMethods(["password"])).toEqual(["password"]);
    expect(amrMethods(undefined)).toEqual([]);
  });

  it("メールのリンクの方法(testdb で確かめた otp を含む)だけをメールのリンクのセッションとする", () => {
    for (const m of ["otp", "magiclink", "recovery", "invite", "email/signup"]) expect(isEmailLinkSession([m])).toBe(true);
    for (const m of ["password", "oauth", "email_change", "token_refresh"]) expect(isEmailLinkSession([m])).toBe(false);
  });

  it("sub・session_id が UUID でなければ使わない", () => {
    expect(parseSessionClaims({ sub: UID, session_id: SID, amr: [{ method: "otp" }], email: "a@example.test" })).toEqual({
      userId: UID,
      sessionId: SID,
      email: "a@example.test",
      methods: ["otp"],
    });
    expect(parseSessionClaims({ sub: UID })).toBeNull();
    expect(parseSessionClaims({ sub: "x", session_id: SID })).toBeNull();
    expect(parseSessionClaims(null)).toBeNull();
  });
});

describe("次に進む場所(nextStep)", () => {
  const account = (over: Partial<AccountState> = {}): AccountState => ({
    emailConfirmed: true,
    verified: true,
    verificationMode: "set_new",
    sessionTrusted: true,
    emailLinkSession: false,
    isOperator: false,
    ...over,
  });
  it("ログイン → 本人確認 → 店舗の登録 → 利用開始 の、済んでいない段階へ", () => {
    expect(resolveNextStep({ account: null, salon: null })).toBe("/login");
    expect(resolveNextStep({ account: account({ verified: false, sessionTrusted: false }), salon: null })).toBe("/auth/verify");
    expect(resolveNextStep({ account: account({ sessionTrusted: false }), salon: { serviceStatus: "complimentary" } })).toBe("/auth/verify");
    expect(resolveNextStep({ account: account(), salon: null })).toBe("/onboarding/salon");
    expect(resolveNextStep({ account: account(), salon: { serviceStatus: "pending" } })).toBe("/onboarding/status");
    expect(resolveNextStep({ account: account(), salon: { serviceStatus: "complimentary" } })).toBe("/dashboard");
    expect(resolveNextStep({ account: account(), salon: { serviceStatus: "test" } })).toBe("/dashboard");
  });
  it("運営の管理者は、信頼できるセッションなら /ops。そうでなければ本人確認", () => {
    expect(resolveNextStep({ account: account({ isOperator: true }), salon: null })).toBe("/ops/salons");
    expect(resolveNextStep({ account: account({ isOperator: true, sessionTrusted: false }), salon: null })).toBe("/auth/verify");
  });
});

describe("メールのリンクの値(authLink)", () => {
  it("フラグメントの token_hash を優先し、query も読む", () => {
    expect(parseAuthLink("", "#token_hash=abcdefgh1234&type=invite")).toEqual({ kind: "token_hash", tokenHash: "abcdefgh1234", type: "invite" });
    expect(parseAuthLink("?token_hash=abcdefgh1234&type=email", "")).toEqual({ kind: "token_hash", tokenHash: "abcdefgh1234", type: "email" });
    expect(parseAuthLink("?code=abcdefgh-1234", "")).toEqual({ kind: "code", code: "abcdefgh-1234" });
    expect(parseAuthLink("", "#access_token=a&refresh_token=b&type=invite")).toEqual({ kind: "session", accessToken: "a", refreshToken: "b" });
    expect(parseAuthLink("", "#error=access_denied&error_code=otp_expired")).toEqual({ kind: "error", code: "otp_expired" });
    expect(parseAuthLink("", "")).toEqual({ kind: "none" });
    expect(parseAuthLink("", "#token_hash=abcdefgh1234&type=unknown")).toEqual({ kind: "none" });
  });
  it("期限切れ・使用済み・別のブラウザを分け、種類ごとに次の対応を案内する", () => {
    expect(linkProblemOf("otp_expired")).toBe("expired");
    expect(linkProblemOf("bad_code_verifier")).toBe("other_browser");
    expect(linkProblemOf("over_request_rate_limit")).toBe("rate_limited");
    expect(linkProblemOf(undefined)).toBe("invalid");
    expect(nextActionsFor("invite").join()).toMatch(/運営に招待メールの再送/);
    expect(nextActionsFor("email").join()).toMatch(/確認メールを再送/);
  });
});

describe("認証のメールの送信の方針(authEmailPolicy)", () => {
  it("開発・プレビュー・testdb では送らない。本番だけ送る。verify は許可したアドレスだけ", () => {
    expect(resolveAuthEmailPolicy({ NODE_ENV: "development" })).toEqual({ mode: "simulated", reason: "development" });
    expect(resolveAuthEmailPolicy({ NODE_ENV: "production", SALONPACK_VERIFY_MODE: "testdb" })).toEqual({ mode: "simulated", reason: "testdb" });
    expect(resolveAuthEmailPolicy({ NODE_ENV: "production", VERCEL_ENV: "preview" })).toEqual({ mode: "simulated", reason: "preview" });
    expect(resolveAuthEmailPolicy({ NODE_ENV: "production", VERCEL_ENV: "production" })).toEqual({ mode: "live" });
    const verify = resolveAuthEmailPolicy({ NODE_ENV: "production", AUTH_EMAIL_VERIFY: "1", AUTH_EMAIL_VERIFY_RECIPIENTS: "Ops@Example.test, bad" });
    expect(isRealAuthEmailAllowed(verify, "ops@example.test")).toBe(true);
    expect(isRealAuthEmailAllowed(verify, "customer@example.test")).toBe(false);
    expect(isRealAuthEmailAllowed({ mode: "simulated", reason: "development" }, "ops@example.test")).toBe(false);
  });
  it("新規登録の画面は、明示的に有効にしたときだけ出す", () => {
    expect(isSelfSignupEnabled({})).toBe(false);
    expect(isSelfSignupEnabled({ SELF_SIGNUP_ENABLED: "1" })).toBe(true);
  });
  it("送信のエラーは、記録・表示用の分類に直す(生のメッセージは使わない)", () => {
    expect(classifyAuthEmailError({ code: "over_email_send_rate_limit" })).toBe("rate_limited");
    expect(classifyAuthEmailError({ status: 429 })).toBe("rate_limited");
    expect(classifyAuthEmailError({ code: "email_address_not_authorized" })).toBe("address_not_authorized");
    expect(classifyAuthEmailError({ code: "email_exists" })).toBe("already_confirmed");
    expect(classifyAuthEmailError({ code: "something" })).toBe("send_failed");
  });
});

describe("利用区分と店舗の情報", () => {
  it("利用中は無料提供・テスト用だけ。知らない値は利用中にしない", () => {
    expect(isServiceActive("complimentary")).toBe(true);
    expect(isServiceActive("test")).toBe(true);
    expect(isServiceActive("pending")).toBe(false);
    expect(isServiceActive("paid")).toBe(false);
    expect(isServiceActive(undefined)).toBe(false);
  });
  it("必須(サロン名・担当者名)と任意を分け、誤りは項目ごとに返す", () => {
    const r = parseSalonProfile({ name: "", contactName: "", contactEmailMode: "other", contactEmail: "x", contactPhone: "電話" }, "a@example.test");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.fieldErrors).sort()).toEqual(["contactEmail", "contactName", "contactPhone", "name"]);
  });
  it("全角の数字・ハイフンを半角にし、連絡用メールがログイン用と同じなら保存しない", () => {
    expect(normalizePhone("０３ー１２３４ー５６７８")).toBe("03-1234-5678");
    const r = parseSalonProfile(
      { name: " サロン ", contactName: "担当", businessType: "", contactEmailMode: "other", contactEmail: "A@Example.test", contactPhone: "" },
      "a@example.test",
    );
    expect(r).toEqual({ ok: true, value: { name: "サロン", contactName: "担当", businessType: null, contactEmail: null, contactPhone: null } });
  });
});
