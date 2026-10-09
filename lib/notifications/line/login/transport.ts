// LINE ログインとの通信(差し替え可能)。本番は HTTP、テストと検証用の開発サーバーは擬似の実装
// (lib/notifications/line/login/simulated.ts)。応答の値・トークンはログに出さない。
//   - トークンの交換: POST https://api.line.me/oauth2/v2.1/token(PKCE の code_verifier を付ける)
//   - ID トークンの検証: POST https://api.line.me/oauth2/v2.1/verify(サーバー側で検証する。
//     LINE 公式: "Unless the ID token is obtained directly from the LINE Platform, validate the ID token on the server.")
//   - 友だち状態: GET https://api.line.me/friendship/v1/status(friendFlag)

export interface LineIdTokenPayload {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  nonce?: string;
}

export type LineLoginErrorKind = "rejected" | "network" | "bad_response";

export class LineLoginError extends Error {
  constructor(
    readonly kind: LineLoginErrorKind,
    readonly status?: number
  ) {
    super(`line_login:${kind}`);
    this.name = "LineLoginError";
  }
}

export interface LineLoginTransport {
  exchangeCode(params: {
    code: string;
    redirectUri: string;
    channelId: string;
    channelSecret: string;
    codeVerifier: string;
  }): Promise<{ accessToken: string; idToken: string }>;
  verifyIdToken(params: { idToken: string; channelId: string }): Promise<LineIdTokenPayload>;
  getFriendship(params: { accessToken: string }): Promise<{ friendFlag: boolean }>;
}

const TIMEOUT_MS = 10_000;

async function call(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new LineLoginError("network");
  }
  if (response.status >= 500) throw new LineLoginError("network", response.status);
  if (!response.ok) throw new LineLoginError("rejected", response.status);
  try {
    return await response.json();
  } catch {
    throw new LineLoginError("bad_response", response.status);
  }
}

export function createHttpLineLoginTransport(fetchImpl: typeof fetch = fetch): LineLoginTransport {
  return {
    async exchangeCode({ code, redirectUri, channelId, channelSecret, codeVerifier }) {
      const body = await call(fetchImpl, "https://api.line.me/oauth2/v2.1/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: channelId,
          client_secret: channelSecret,
          code_verifier: codeVerifier,
        }).toString(),
      });
      const b = body as Record<string, unknown>;
      if (typeof b?.access_token !== "string" || typeof b?.id_token !== "string") throw new LineLoginError("bad_response");
      return { accessToken: b.access_token, idToken: b.id_token };
    },
    async verifyIdToken({ idToken, channelId }) {
      const body = await call(fetchImpl, "https://api.line.me/oauth2/v2.1/verify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ id_token: idToken, client_id: channelId }).toString(),
      });
      const b = body as Record<string, unknown>;
      if (typeof b?.iss !== "string" || typeof b?.sub !== "string" || typeof b?.exp !== "number") throw new LineLoginError("bad_response");
      const aud = Array.isArray(b.aud) ? String(b.aud[0] ?? "") : String(b.aud ?? "");
      return { iss: b.iss, sub: b.sub, aud, exp: b.exp, nonce: typeof b.nonce === "string" ? b.nonce : undefined };
    },
    async getFriendship({ accessToken }) {
      const body = await call(fetchImpl, "https://api.line.me/friendship/v1/status", {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const b = body as Record<string, unknown>;
      if (typeof b?.friendFlag !== "boolean") throw new LineLoginError("bad_response");
      return { friendFlag: b.friendFlag };
    },
  };
}
