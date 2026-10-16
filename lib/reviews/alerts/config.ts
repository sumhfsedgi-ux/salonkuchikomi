// 口コミ 第2段階の環境変数(既定はすべて無効)。
//   GBP_AUTO_SYNC_ENABLED=1 : 画面を開いていないときの自動取得(定期の確認・Google の通知)を行う
//   REVIEW_ALERTS_ENABLED=1 : 口コミの LINE 通知の評価と配信を行う(LINE の実送信の可否は sendPolicy が別に決める)
//   REVIEWS_CRON_SECRET     : 定期処理の呼び出しの秘密の値(32文字以上)
// GOOGLE_REVIEWS_OAUTH_ENABLED(第1段階)が空なら、Google口コミの処理そのものを作らない(自動取得もしない)。

export function isAutoSyncEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.GBP_AUTO_SYNC_ENABLED === "1";
}

export function isReviewAlertsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.REVIEW_ALERTS_ENABLED === "1";
}

/** 確認用のリンクの元(NEXT_PUBLIC_APP_URL のオリジン)。無い・形が違うなら null。 */
export function reviewAlertBaseUrl(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.NEXT_PUBLIC_APP_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}
