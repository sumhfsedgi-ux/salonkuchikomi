// Google の認可画面の URL。
//   - 選んだ機能の scope だけを要求する(lib/google/scopes.ts)
//   - access_type=offline: 利用者がいない間(cron)もアクセストークンを更新できるようにする
//   - include_granted_scopes=true: 権限を追加するとき、既に許可済みの権限もまとめた認可にする
//   - PKCE(S256)と nonce を使う
//   - prompt は既定で付けない(通常の接続のたびに同意画面を出さない)。
//     新しい refresh token が必要なのに得られなかった場合の1回だけ prompt=consent を付ける。

export const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

export interface AuthorizationUrlParams {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
  nonce: string;
  loginHint?: string;
  forceConsent?: boolean;
  endpoint?: string;
}

export function buildGoogleAuthorizationUrl(params: AuthorizationUrlParams): string {
  const url = new URL(params.endpoint ?? GOOGLE_AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", params.scopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("nonce", params.nonce);
  if (params.loginHint) url.searchParams.set("login_hint", params.loginHint);
  if (params.forceConsent) url.searchParams.set("prompt", "consent");
  return url.toString();
}
