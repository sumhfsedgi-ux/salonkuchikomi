// Google の OAuth エンドポイントとの通信(差し替え可能)。本番は HTTP、テストと検証用の
// 開発サーバーは擬似の実装(lib/google/simulated.ts)を使う。応答の値はログに出さない。

export interface GoogleTokenResponse {
  accessToken: string;
  expiresIn?: number;
  refreshToken?: string;
  /** 応答に scope が無いときは undefined(許可された権限は不明として扱う)。 */
  scope?: string;
  idToken?: string;
}

export type GoogleOAuthErrorKind = "invalid_grant" | "invalid_client" | "rejected" | "network" | "bad_response";

export class GoogleOAuthError extends Error {
  constructor(
    readonly kind: GoogleOAuthErrorKind,
    readonly status?: number,
    readonly oauthError?: string
  ) {
    super(`google_oauth:${kind}`);
    this.name = "GoogleOAuthError";
  }
}

export interface GoogleOAuthTransport {
  exchangeCode(params: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string;
  }): Promise<GoogleTokenResponse>;
  refreshAccessToken(params: { refreshToken: string; clientId: string; clientSecret: string }): Promise<GoogleTokenResponse>;
  /** Google の revoke エンドポイント。そのプロジェクトに対するユーザーの許可がすべて取り消される。 */
  revokeToken(token: string): Promise<void>;
  /** id_token の署名検証に使う Google の公開鍵(kid → PEM)。 */
  fetchSigningCerts(): Promise<Record<string, string>>;
}

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const CERTS_ENDPOINT = "https://www.googleapis.com/oauth2/v1/certs";
const TIMEOUT_MS = 10_000;

type FetchLike = typeof fetch;

function classifyTokenFailure(status: number, body: unknown): GoogleOAuthError {
  const oauthError =
    body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
      ? ((body as { error: string }).error)
      : undefined;
  const safeCode = oauthError && /^[a-z_]{1,40}$/.test(oauthError) ? oauthError : undefined;
  if (safeCode === "invalid_grant") return new GoogleOAuthError("invalid_grant", status, safeCode);
  if (safeCode === "invalid_client" || safeCode === "unauthorized_client") {
    return new GoogleOAuthError("invalid_client", status, safeCode);
  }
  if (status >= 500) return new GoogleOAuthError("network", status, safeCode);
  return new GoogleOAuthError("rejected", status, safeCode);
}

function readTokenResponse(body: unknown): GoogleTokenResponse {
  if (!body || typeof body !== "object") throw new GoogleOAuthError("bad_response");
  const b = body as Record<string, unknown>;
  if (typeof b.access_token !== "string" || b.access_token.length === 0) throw new GoogleOAuthError("bad_response");
  return {
    accessToken: b.access_token,
    expiresIn: typeof b.expires_in === "number" ? b.expires_in : undefined,
    refreshToken: typeof b.refresh_token === "string" && b.refresh_token.length > 0 ? b.refresh_token : undefined,
    scope: typeof b.scope === "string" ? b.scope : undefined,
    idToken: typeof b.id_token === "string" ? b.id_token : undefined,
  };
}

async function postForm(fetchImpl: FetchLike, url: string, form: Record<string, string>): Promise<Response> {
  try {
    return await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new GoogleOAuthError("network");
  }
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function createHttpGoogleTransport(fetchImpl: FetchLike = fetch): GoogleOAuthTransport {
  let certCache: { certs: Record<string, string>; expiresAt: number } | null = null;

  return {
    async exchangeCode({ code, codeVerifier, redirectUri, clientId, clientSecret }) {
      const response = await postForm(fetchImpl, TOKEN_ENDPOINT, {
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      });
      const body = await parseJson(response);
      if (!response.ok) throw classifyTokenFailure(response.status, body);
      return readTokenResponse(body);
    },

    async refreshAccessToken({ refreshToken, clientId, clientSecret }) {
      const response = await postForm(fetchImpl, TOKEN_ENDPOINT, {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      });
      const body = await parseJson(response);
      if (!response.ok) throw classifyTokenFailure(response.status, body);
      return readTokenResponse(body);
    },

    async revokeToken(token) {
      const response = await postForm(fetchImpl, REVOKE_ENDPOINT, { token });
      // 400 は「既に無効なトークン」。取り消し済みと同じ扱いにする。
      if (response.ok || response.status === 400) return;
      if (response.status >= 500) throw new GoogleOAuthError("network", response.status);
      throw new GoogleOAuthError("rejected", response.status);
    },

    async fetchSigningCerts() {
      if (certCache && certCache.expiresAt > Date.now()) return certCache.certs;
      let response: Response;
      try {
        response = await fetchImpl(CERTS_ENDPOINT, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch {
        throw new GoogleOAuthError("network");
      }
      if (!response.ok) throw new GoogleOAuthError(response.status >= 500 ? "network" : "rejected", response.status);
      const body = await parseJson(response);
      if (!body || typeof body !== "object") throw new GoogleOAuthError("bad_response");
      const certs: Record<string, string> = {};
      for (const [kid, pem] of Object.entries(body as Record<string, unknown>)) {
        if (typeof pem === "string") certs[kid] = pem;
      }
      certCache = { certs, expiresAt: Date.now() + 60 * 60 * 1000 };
      return certs;
    },
  };
}
