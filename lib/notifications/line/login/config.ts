// スタッフの LINE 通知先の追加(招待 → スタッフ本人の LINE ログイン)の設定。値は環境変数からだけ読み、ログには出さない。
//
// 旧サービス(hmail)の LINE 公式アカウント(Messaging API チャネル)の Webhook・トークンは使わない・変えない。
// 本人確認は、同じプロバイダーに作る LINE ログインチャネルで行う(LINE 公式: "If the provider is the same,
// the user ID is the same regardless of the channel type (LINE Login channel or Messaging API channel).")。
// LINE ログインチャネルが作成・設定され、LINE_RECIPIENT_INVITES_ENABLED=1 になるまで、この機能は未有効化のまま
// (招待の発行は「運営にお問い合わせください」の案内に置き換わる)。

export const LINE_LOGIN_CALLBACK_PATH = "/api/line/login/callback";
export const LINE_SIMULATED_AUTHORIZE_PATH = "/api/line/login/simulated-authorize";
export const LINE_AUTHORIZE_ENDPOINT = "https://access.line.me/oauth2/v2.1/authorize";
export const LINE_ID_TOKEN_ISSUER = "https://access.line.me";
/** 擬似の LINE ログインで使うチャネル ID(本物のチャネルではない)。 */
export const SIMULATED_LINE_CHANNEL_ID = "2000000000";

export interface LineLoginConfig {
  channelId: string;
  channelSecret: string;
  redirectUri: string;
  authorizationEndpoint: string;
  simulated: boolean;
}

/**
 * 検証用の擬似 LINE ログインを使ってよいか。テスト用DBの検証モードで、本番ビルドでない場合に限る
 * (lib/google/config.ts の isSimulatedGoogleEnabled と同じ条件)。
 */
export function isSimulatedLineLoginEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.SALONPACK_VERIFY_MODE === "testdb" &&
    process.env.LINE_LOGIN_SIMULATED === "1"
  );
}

/** 有効でなければ null(招待の発行・LINE ログインを行わない)。 */
export function getLineLoginConfig(): LineLoginConfig | null {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) return null;
  const origin = new URL(appUrl).origin;
  if (isSimulatedLineLoginEnabled()) {
    return {
      channelId: SIMULATED_LINE_CHANNEL_ID,
      channelSecret: "simulated-line-secret",
      redirectUri: `${origin}${LINE_LOGIN_CALLBACK_PATH}`,
      authorizationEndpoint: `${origin}${LINE_SIMULATED_AUTHORIZE_PATH}`,
      simulated: true,
    };
  }
  if (process.env.LINE_RECIPIENT_INVITES_ENABLED !== "1") return null;
  const channelId = process.env.LINE_LOGIN_CHANNEL_ID;
  const channelSecret = process.env.LINE_LOGIN_CHANNEL_SECRET;
  if (!channelId || !channelSecret) return null;
  return {
    channelId,
    channelSecret,
    redirectUri: `${origin}${LINE_LOGIN_CALLBACK_PATH}`,
    authorizationEndpoint: LINE_AUTHORIZE_ENDPOINT,
    simulated: false,
  };
}

export function isLineInviteAvailable(): boolean {
  return getLineLoginConfig() !== null;
}
