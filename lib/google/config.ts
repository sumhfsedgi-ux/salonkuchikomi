// SalonPack 共通の Google OAuth クライアントの設定。値は環境変数からだけ読み、ログには出さない。

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export class GoogleConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleConfigError";
  }
}

export const GOOGLE_CALLBACK_PATH = "/api/google/oauth/callback";

export function getGoogleOAuthConfig(): GoogleOAuthConfig {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!clientId || !clientSecret) {
    throw new GoogleConfigError("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET が設定されていません。");
  }
  if (!appUrl) {
    throw new GoogleConfigError("NEXT_PUBLIC_APP_URL が設定されていません(OAuth の戻り先に使います)。");
  }
  return { clientId, clientSecret, redirectUri: `${new URL(appUrl).origin}${GOOGLE_CALLBACK_PATH}` };
}

/**
 * 届いた口コミ(Google ビジネスプロフィール)の権限を要求してよいか。
 * Google の API 利用承認と整合を確認するまで、本番では有効にしない(既定は無効)。
 */
export function isGoogleReviewsOAuthEnabled(): boolean {
  return process.env.GOOGLE_REVIEWS_OAUTH_ENABLED === "1";
}

/**
 * 検証用の擬似 Google を使ってよいか。テスト用DBの検証モード(npm run dev:testdb 等)で、
 * 本番ビルドでない場合に限る。本番の環境変数がそろっていても本番では使えない。
 */
export function isSimulatedGoogleEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.SALONPACK_VERIFY_MODE === "testdb" &&
    process.env.GOOGLE_OAUTH_SIMULATED === "1"
  );
}
