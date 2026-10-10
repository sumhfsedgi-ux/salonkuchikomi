import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "crypto";
import { GoogleOAuthError, type GoogleOAuthTransport, type GoogleTokenResponse } from "@/lib/google/transport";
import { IDENTITY_SCOPES } from "@/lib/google/scopes";

// テストと、テスト用DBでの画面確認(npm run dev:testdb)のための擬似 Google。
// 本番では使えない(lib/google/config.ts の isSimulatedGoogleEnabled)。実際の Google の
// 次の振る舞いを再現する(テストで確かめたい点):
//   - refresh token は、そのクライアントへの最初の同意か prompt=consent のときだけ返す
//   - include_granted_scopes=true なら、過去に許可した権限もまとめた認可になる
//   - 利用者は要求された権限の一部だけを許可できる
//   - revoke は、そのユーザーがこのプロジェクトに許可した権限をすべて取り消す
//   - id_token は RS256 で署名し、kid ごとの公開鍵で検証できる
// 外部への通信は一切しない。

export interface SimulatedUser {
  sub: string;
  email: string;
}

interface Grant {
  scopes: Set<string>;
  revoked: boolean;
}

interface PendingCode {
  sub: string;
  scope: string;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
  issueRefreshToken: boolean;
}

export interface SimulatedAuthorizeParams {
  sub: string;
  requestedScopes: string[];
  /** 利用者が実際に許可した権限(省略時は要求どおり全部)。 */
  grantScopes?: string[];
  includeGrantedScopes: boolean;
  prompt?: string | null;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
}

export interface SimulatedGoogle {
  clientId: string;
  users: SimulatedUser[];
  transport: GoogleOAuthTransport;
  authorize(params: SimulatedAuthorizeParams): string;
  /** 認可画面の URL を解釈して、そのまま認可した場合のコールバック用パラメータを返す(テスト用)。 */
  approve(authorizationUrl: string, options: { sub: string; grantScopes?: string[] }): { code: string; state: string };
  grantedScopes(sub: string): string[];
  revokedSubs(): string[];
  failNextRefresh(kind: GoogleOAuthError["kind"]): void;
  omitScopeOnNextResponse(): void;
  calls: Array<{ op: "exchange" | "refresh" | "revoke" | "certs" }>;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function signJwt(payload: Record<string, unknown>, privateKey: KeyObject, kid: string): string {
  const header = base64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${body}`), privateKey);
  return `${header}.${body}.${base64url(signature)}`;
}

export function createSimulatedGoogle(options: { clientId: string; users?: SimulatedUser[]; now?: () => Date }): SimulatedGoogle {
  const now = options.now ?? (() => new Date());
  const users = options.users ?? [
    { sub: "100000000000000000001", email: "owner@example.test" },
    { sub: "100000000000000000002", email: "staff@example.test" },
  ];
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = `sim-${randomBytes(4).toString("hex")}`;
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  const grants = new Map<string, Grant>();
  const refreshTokens = new Map<string, string>(); // token -> sub
  const codes = new Map<string, PendingCode>();
  let nextRefreshFailure: GoogleOAuthError["kind"] | null = null;
  let omitScopeOnce = false;
  const calls: SimulatedGoogle["calls"] = [];

  function userFor(sub: string): SimulatedUser {
    const user = users.find((u) => u.sub === sub);
    if (!user) throw new Error(`simulated google: unknown user ${sub}`);
    return user;
  }

  function authorize(params: SimulatedAuthorizeParams): string {
    userFor(params.sub);
    const existing = grants.get(params.sub);
    const live = existing && !existing.revoked ? existing : null;
    const consented = new Set(params.grantScopes ?? params.requestedScopes);
    for (const s of IDENTITY_SCOPES) consented.add(s);
    const combined = new Set<string>(params.includeGrantedScopes && live ? [...live.scopes] : []);
    for (const s of consented) if (params.requestedScopes.includes(s) || (IDENTITY_SCOPES as readonly string[]).includes(s)) combined.add(s);
    grants.set(params.sub, { scopes: combined, revoked: false });
    const promptConsent = (params.prompt ?? "").split(" ").includes("consent");
    const code = `simcode_${randomBytes(16).toString("hex")}`;
    codes.set(code, {
      sub: params.sub,
      scope: [...combined].join(" "),
      nonce: params.nonce,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      issueRefreshToken: !live || promptConsent,
    });
    return code;
  }

  function idTokenFor(sub: string, nonce: string): string {
    const user = userFor(sub);
    const iat = Math.floor(now().getTime() / 1000);
    return signJwt(
      {
        iss: "https://accounts.google.com",
        aud: options.clientId,
        sub,
        email: user.email,
        email_verified: true,
        nonce,
        iat,
        exp: iat + 3600,
      },
      privateKey,
      kid
    );
  }

  const transport: GoogleOAuthTransport = {
    async exchangeCode({ code, codeVerifier, redirectUri, clientId }): Promise<GoogleTokenResponse> {
      calls.push({ op: "exchange" });
      const pending = codes.get(code);
      codes.delete(code);
      if (!pending || clientId !== options.clientId || redirectUri !== pending.redirectUri) {
        throw new GoogleOAuthError("invalid_grant", 400, "invalid_grant");
      }
      const challenge = createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
      if (challenge !== pending.codeChallenge) throw new GoogleOAuthError("invalid_grant", 400, "invalid_grant");
      let refreshToken: string | undefined;
      if (pending.issueRefreshToken) {
        refreshToken = `simrefresh_${randomBytes(16).toString("hex")}`;
        refreshTokens.set(refreshToken, pending.sub);
      }
      const omit = omitScopeOnce;
      omitScopeOnce = false;
      return {
        accessToken: `simaccess_${randomBytes(8).toString("hex")}`,
        expiresIn: 3600,
        refreshToken,
        scope: omit ? undefined : pending.scope,
        idToken: idTokenFor(pending.sub, pending.nonce),
      };
    },
    async refreshAccessToken({ refreshToken, clientId }): Promise<GoogleTokenResponse> {
      calls.push({ op: "refresh" });
      if (nextRefreshFailure) {
        const kind = nextRefreshFailure;
        nextRefreshFailure = null;
        throw new GoogleOAuthError(kind, kind === "network" ? 503 : 400, kind === "invalid_grant" ? "invalid_grant" : undefined);
      }
      const sub = refreshTokens.get(refreshToken);
      const grant = sub ? grants.get(sub) : undefined;
      if (!sub || !grant || grant.revoked || clientId !== options.clientId) {
        throw new GoogleOAuthError("invalid_grant", 400, "invalid_grant");
      }
      const omit = omitScopeOnce;
      omitScopeOnce = false;
      return { accessToken: `simaccess_${randomBytes(8).toString("hex")}`, expiresIn: 3600, scope: omit ? undefined : [...grant.scopes].join(" ") };
    },
    async revokeToken(token) {
      calls.push({ op: "revoke" });
      const sub = refreshTokens.get(token);
      if (!sub) return;
      const grant = grants.get(sub);
      if (grant) grant.revoked = true;
      for (const [t, s] of refreshTokens) if (s === sub) refreshTokens.delete(t);
    },
    async fetchSigningCerts() {
      calls.push({ op: "certs" });
      return { [kid]: publicPem };
    },
  };

  return {
    clientId: options.clientId,
    users,
    transport,
    authorize,
    approve(authorizationUrl, approveOptions) {
      const url = new URL(authorizationUrl);
      const code = authorize({
        sub: approveOptions.sub,
        requestedScopes: (url.searchParams.get("scope") ?? "").split(" ").filter(Boolean),
        grantScopes: approveOptions.grantScopes,
        includeGrantedScopes: url.searchParams.get("include_granted_scopes") === "true",
        prompt: url.searchParams.get("prompt"),
        nonce: url.searchParams.get("nonce") ?? "",
        codeChallenge: url.searchParams.get("code_challenge") ?? "",
        redirectUri: url.searchParams.get("redirect_uri") ?? "",
      });
      return { code, state: url.searchParams.get("state") ?? "" };
    },
    grantedScopes(sub) {
      const grant = grants.get(sub);
      return grant && !grant.revoked ? [...grant.scopes] : [];
    },
    revokedSubs() {
      return [...grants.entries()].filter(([, g]) => g.revoked).map(([s]) => s);
    },
    failNextRefresh(kind) {
      nextRefreshFailure = kind;
    },
    omitScopeOnNextResponse() {
      omitScopeOnce = true;
    },
    calls,
  };
}

/** 開発サーバー(テスト用DBでの画面確認)で使う、プロセス内で1つの擬似 Google。 */
export function getDevSimulatedGoogle(clientId: string): SimulatedGoogle {
  const holder = globalThis as unknown as { __salonpackSimulatedGoogle?: SimulatedGoogle };
  if (!holder.__salonpackSimulatedGoogle || holder.__salonpackSimulatedGoogle.clientId !== clientId) {
    holder.__salonpackSimulatedGoogle = createSimulatedGoogle({ clientId });
  }
  return holder.__salonpackSimulatedGoogle;
}
