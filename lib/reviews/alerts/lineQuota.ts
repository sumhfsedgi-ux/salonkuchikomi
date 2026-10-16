import "server-only";
import { getMonthlyMessageQuota } from "@/lib/notifications/line/LineClient";

// LINE 公式アカウントの月の送信数は、予約通知と口コミの通知(全店舗)で共有している。口コミの通知で使い切って
// 予約通知が届かなくならないよう、月の上限の残りが REVIEW_ALERT_LINE_QUOTA_RESERVE(%。既定10)を下回ったら、
// 口コミの通知だけを止める(次の回にまた確かめる)。上限の無いプランは止めない。
// 取得に失敗したときは止めない(月間の上限に達したときの 429 は、配信の側で扱う)。値は10分だけ覚えておく。

const CACHE_MS = 10 * 60_000;
let cached: { at: number; allows: boolean } | null = null;

export function quotaReservePercent(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.REVIEW_ALERT_LINE_QUOTA_RESERVE ?? "10");
  return Number.isFinite(value) && value >= 0 && value <= 90 ? value : 10;
}

/** 上限・使った数・取っておく割合から、口コミの通知を送ってよいか。 */
export function quotaAllowsReviewAlerts(quota: { limit: number | null; used: number }, reservePercent: number): boolean {
  if (quota.limit === null) return true;
  const remaining = quota.limit - quota.used;
  return remaining > Math.ceil((quota.limit * reservePercent) / 100);
}

export async function lineQuotaAllowsReviewAlerts(now: () => number = Date.now): Promise<boolean> {
  if (cached && now() - cached.at < CACHE_MS) return cached.allows;
  let allows = true;
  try {
    allows = quotaAllowsReviewAlerts(await getMonthlyMessageQuota(), quotaReservePercent());
  } catch {
    allows = true;
  }
  cached = { at: now(), allows };
  return allows;
}
