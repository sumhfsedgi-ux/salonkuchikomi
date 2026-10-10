import { generateKeyPairSync, randomBytes, sign } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGoogleAuthorizationUrl } from "@/lib/google/authUrl";
import { decideCredentialAction } from "@/lib/google/credentialDecision";
import { classifyGoogleError } from "@/lib/google/errors";
import { IdTokenError, verifyGoogleIdToken } from "@/lib/google/idToken";
import { pkceChallenge, sha256Hex } from "@/lib/google/randomness";
import { summarizeError } from "@/lib/google/safeError";
import { GOOGLE_SCOPES, grantedFeatures, parseGrantedScopes, scopesForFeatures } from "@/lib/google/scopes";
import { openSecret, refreshTokenAad, sealSecret, TokenBoxError } from "@/lib/google/tokenBox";
import { createHttpGoogleTransport, GoogleOAuthError } from "@/lib/google/transport";

const CLIENT_ID = "salonpack-test.apps.googleusercontent.com";

describe("scopes: 選んだ機能に必要な権限だけ", () => {
  it("予約通知だけなら gmail.readonly、口コミだけなら business.manage、両方なら両方(openid/email は常に)", () => {
    expect(scopesForFeatures(["gmail"])).toEqual(["openid", "email", GOOGLE_SCOPES.gmail]);
    expect(scopesForFeatures(["gbp"])).toEqual(["openid", "email", GOOGLE_SCOPES.gbp]);
    expect(scopesForFeatures(["gmail", "gbp", "gmail"])).toEqual(["openid", "email", GOOGLE_SCOPES.gmail, GOOGLE_SCOPES.gbp]);
  });

  it("応答に scope が無い・空なら null(要求した権限が全部あるとは推測しない)", () => {
    expect(parseGrantedScopes(undefined)).toBeNull();
    expect(parseGrantedScopes("")).toBeNull();
    expect(grantedFeatures(null, ["gmail", "gbp"])).toEqual([]);
  });

  it("片方だけ許可されたら、その機能だけ", () => {
    const granted = parseGrantedScopes(`openid ${GOOGLE_SCOPES.gmail}`);
    expect(grantedFeatures(granted, ["gmail", "gbp"])).toEqual(["gmail"]);
  });
});

describe("authUrl: 通常は同意画面を強制しない", () => {
  const base = {
    clientId: CLIENT_ID,
    redirectUri: "https://salonpack.example/api/google/oauth/callback",
    scopes: scopesForFeatures(["gmail"]),
    state: "s".repeat(43),
    codeChallenge: pkceChallenge("v".repeat(64)),
    nonce: "n".repeat(43),
  };

  it("prompt を付けない・offline・include_granted_scopes・PKCE S256・nonce", () => {
    const url = new URL(buildGoogleAuthorizationUrl(base));
    expect(url.searchParams.get("prompt")).toBeNull();
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(base.codeChallenge);
    expect(url.searchParams.get("nonce")).toBe(base.nonce);
    expect(url.searchParams.get("scope")).toBe(`openid email ${GOOGLE_SCOPES.gmail}`);
  });

  it("refresh token を取り直す1回だけ prompt=consent、再認証では login_hint", () => {
    const url = new URL(buildGoogleAuthorizationUrl({ ...base, forceConsent: true, loginHint: "owner@example.test" }));
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("login_hint")).toBe("owner@example.test");
  });
});

describe("tokenBox: 暗号文を別の行・別の世代へ付け替えても復号できない", () => {
  beforeEach(() => {
    vi.stubEnv("GOOGLE_TOKEN_KEYS", `v1:${randomBytes(32).toString("base64")},v2:${randomBytes(32).toString("base64")}`);
    vi.stubEnv("GOOGLE_TOKEN_KEY_CURRENT", "v2");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("同じ AAD なら復号でき、AAD が違えば失敗する", () => {
    const sealed = sealSecret("refresh-token-value", refreshTokenAad("acc-1", 1));
    expect(sealed.keyVersion).toBe("v2");
    expect(sealed.ciphertext).not.toContain("refresh-token-value");
    expect(openSecret(sealed, refreshTokenAad("acc-1", 1))).toBe("refresh-token-value");
    expect(() => openSecret(sealed, refreshTokenAad("acc-1", 2))).toThrow(TokenBoxError);
    expect(() => openSecret(sealed, refreshTokenAad("acc-2", 1))).toThrow(TokenBoxError);
  });

  it("鍵の設定が無い・32バイトでない場合は拒否する", () => {
    vi.stubEnv("GOOGLE_TOKEN_KEYS", "v1:short");
    vi.stubEnv("GOOGLE_TOKEN_KEY_CURRENT", "v1");
    expect(() => sealSecret("x", "aad")).toThrow(TokenBoxError);
  });
});

describe("idToken: 署名と iss/aud/exp/sub/nonce を検証する(デコードだけで済ませない)", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const certs = { k1: publicKey.export({ type: "spki", format: "pem" }).toString() };
  const nonce = "nonce-value-1234567890-abcdefghijkl";

  function jwt(payload: Record<string, unknown>, key = privateKey, kid = "k1"): string {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = sign("RSA-SHA256", Buffer.from(`${header}.${body}`), key).toString("base64url");
    return `${header}.${body}.${signature}`;
  }
  function claims(overrides: Record<string, unknown> = {}) {
    const iat = Math.floor(Date.now() / 1000);
    return {
      iss: "https://accounts.google.com",
      aud: CLIENT_ID,
      sub: "1234567890",
      email: "owner@example.test",
      email_verified: true,
      nonce,
      iat,
      exp: iat + 600,
      ...overrides,
    };
  }
  const options = { clientId: CLIENT_ID, expectedNonceHash: sha256Hex(nonce), certs };

  it("正しい id_token は通り、sub と確認済みの email を返す", async () => {
    await expect(verifyGoogleIdToken(jwt(claims()), options)).resolves.toEqual({
      sub: "1234567890",
      email: "owner@example.test",
      emailVerified: true,
    });
  });

  it.each([
    ["別の鍵で署名", () => jwt(claims(), other.privateKey), "invalid_signature_or_claims"],
    ["aud が別のクライアント", () => jwt(claims({ aud: "other.apps.googleusercontent.com" })), "invalid_signature_or_claims"],
    ["iss が Google でない", () => jwt(claims({ iss: "https://evil.example" })), "invalid_signature_or_claims"],
    ["期限切れ", () => jwt(claims({ iat: 1_600_000_000, exp: 1_600_000_600 })), "invalid_signature_or_claims"],
    ["sub が無い", () => jwt(claims({ sub: undefined })), "invalid_sub"],
    ["nonce が違う", () => jwt(claims({ nonce: "another-nonce-value-000000000000" })), "nonce_mismatch"],
  ])("%s → 拒否", async (_label, make, reason) => {
    await expect(verifyGoogleIdToken(make(), options)).rejects.toMatchObject({ reason });
  });

  it("id_token が無ければ拒否", async () => {
    await expect(verifyGoogleIdToken(undefined, options)).rejects.toBeInstanceOf(IdTokenError);
  });

  it("未確認のメールアドレスは表示用に使わない", async () => {
    const result = await verifyGoogleIdToken(jwt(claims({ email_verified: false })), options);
    expect(result.email).toBeNull();
  });
});

describe("credentialDecision: 保存済みトークンの扱い", () => {
  const gmail = GOOGLE_SCOPES.gmail;
  const gbp = GOOGLE_SCOPES.gbp;

  it("未保存のアカウント + 新しい refresh token → 作成", () => {
    expect(
      decideCredentialAction({ hasNewRefreshToken: true, existing: null, newGrantedScopes: [gmail], scopesNeededByExistingBindings: [], forcedConsentAlready: false })
    ).toEqual({ kind: "create" });
  });

  it("保存済み + 新しい許可が既存の権限を含む → 置き換え。含まない → 既存を壊さず拒否", () => {
    const existing = { authState: "active" as const, hasToken: true };
    expect(
      decideCredentialAction({ hasNewRefreshToken: true, existing, newGrantedScopes: [gmail, gbp], scopesNeededByExistingBindings: [gmail], forcedConsentAlready: false })
    ).toEqual({ kind: "replace" });
    expect(
      decideCredentialAction({ hasNewRefreshToken: true, existing, newGrantedScopes: [gbp], scopesNeededByExistingBindings: [gmail], forcedConsentAlready: false })
    ).toEqual({ kind: "reject", reason: "scope_regression" });
  });

  it("新しい refresh token が無い: 同じアカウント・有効な保存済みがあれば再利用、無ければ1回だけ同意を取り直す", () => {
    expect(
      decideCredentialAction({ hasNewRefreshToken: false, existing: { authState: "active", hasToken: true }, newGrantedScopes: [gmail], scopesNeededByExistingBindings: [gmail], forcedConsentAlready: false })
    ).toEqual({ kind: "reuse" });
    expect(
      decideCredentialAction({ hasNewRefreshToken: false, existing: { authState: "needs_reauth", hasToken: true }, newGrantedScopes: [gmail], scopesNeededByExistingBindings: [], forcedConsentAlready: false })
    ).toEqual({ kind: "force_consent" });
    expect(
      decideCredentialAction({ hasNewRefreshToken: false, existing: null, newGrantedScopes: [gmail], scopesNeededByExistingBindings: [], forcedConsentAlready: true })
    ).toEqual({ kind: "reject", reason: "no_refresh_token" });
  });
});

describe("errors / safeError: 一時的な障害を失効と決めつけない・秘密値をログに出さない", () => {
  it("分類", () => {
    expect(classifyGoogleError(new GoogleOAuthError("invalid_grant", 400, "invalid_grant"))).toBe("invalid_grant");
    expect(classifyGoogleError(new GoogleOAuthError("invalid_client", 401, "invalid_client"))).toBe("config");
    expect(classifyGoogleError(new GoogleOAuthError("network", 503))).toBe("transient");
    expect(classifyGoogleError({ response: { status: 401, data: {} } })).toBe("transient");
    expect(classifyGoogleError({ response: { status: 500 } })).toBe("transient");
    expect(
      classifyGoogleError({ response: { status: 403, data: { error: { errors: [{ reason: "insufficientPermissions" }] } } } })
    ).toBe("insufficient_scope");
    expect(classifyGoogleError({ response: { status: 400, data: { error: "invalid_grant" } } })).toBe("invalid_grant");
  });

  it("要約にメッセージ・トークン・認可コードを含めない", () => {
    const leaky = Object.assign(new Error("Invalid token signature: eyJhbGciOi.secret.jwt code=4/0Aabc client_secret=xyz"), {
      config: { data: "code=4/0Aabc&client_secret=xyz&code_verifier=abc" },
      response: { status: 400, data: { error: "invalid_grant", error_description: "Bad Request" } },
    });
    const summary = summarizeError(leaky);
    expect(summary).toEqual({ name: "Error", status: 400, reason: "invalid_grant" });
    expect(JSON.stringify(summary)).not.toMatch(/eyJ|4\/0A|client_secret|code_verifier/);
  });
});

describe("transport(HTTP): 応答の分類とタイムアウト", () => {
  function fetchReturning(status: number, body: unknown) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  }

  it("invalid_grant / invalid_client / 5xx を分ける", async () => {
    const params = { refreshToken: "r", clientId: "c", clientSecret: "s" };
    await expect(createHttpGoogleTransport(fetchReturning(400, { error: "invalid_grant" })).refreshAccessToken(params)).rejects.toMatchObject({ kind: "invalid_grant" });
    await expect(createHttpGoogleTransport(fetchReturning(401, { error: "invalid_client" })).refreshAccessToken(params)).rejects.toMatchObject({ kind: "invalid_client" });
    await expect(createHttpGoogleTransport(fetchReturning(503, {})).refreshAccessToken(params)).rejects.toMatchObject({ kind: "network" });
  });

  it("scope の無い応答はそのまま undefined(推測で補わない)", async () => {
    const transport = createHttpGoogleTransport(fetchReturning(200, { access_token: "a", expires_in: 3600 }));
    const result = await transport.refreshAccessToken({ refreshToken: "r", clientId: "c", clientSecret: "s" });
    expect(result.scope).toBeUndefined();
    expect(result.refreshToken).toBeUndefined();
  });

  it("通信の失敗は network", async () => {
    const transport = createHttpGoogleTransport(vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(transport.refreshAccessToken({ refreshToken: "r", clientId: "c", clientSecret: "s" })).rejects.toMatchObject({ kind: "network" });
  });

  it("revoke の 400(既に無効)は成功扱い", async () => {
    await expect(createHttpGoogleTransport(fetchReturning(400, {})).revokeToken("t")).resolves.toBeUndefined();
  });
});
