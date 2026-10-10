import { openRefreshToken, type GoogleAccount } from "@/lib/google/db/accounts";
import type { GoogleOAuthConfig } from "@/lib/google/config";
import { parseGrantedScopes } from "@/lib/google/scopes";
import type { GoogleOAuthTransport } from "@/lib/google/transport";

// 保存済みの refresh token からアクセストークンを取得する(利用者の操作は不要。同意画面も出さない)。
// 失敗は GoogleOAuthError として呼び出し側へ渡し、lib/google/errors.ts で分類する
// (一時的な通信障害を、認可の失効と決めつけない)。

export async function obtainGoogleAccessToken(
  account: GoogleAccount,
  deps: { transport: GoogleOAuthTransport; config: GoogleOAuthConfig }
): Promise<{ accessToken: string; scopes: string[] | null }> {
  const refreshed = await deps.transport.refreshAccessToken({
    refreshToken: openRefreshToken(account),
    clientId: deps.config.clientId,
    clientSecret: deps.config.clientSecret,
  });
  return { accessToken: refreshed.accessToken, scopes: parseGrantedScopes(refreshed.scope) };
}
