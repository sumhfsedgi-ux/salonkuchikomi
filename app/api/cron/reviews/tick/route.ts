import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { resolveLineSendPolicy } from "@/lib/notifications/line/sendPolicy";
import { GBP_CONSENT_VERSION } from "@/lib/gbp/inbox";
import { isAutoSyncEnabled, isReviewAlertsEnabled } from "@/lib/reviews/alerts/config";
import { getReviewAlertStore, getReviewTickDeps } from "@/lib/reviews/alerts/runtime";
import { runReviewTick } from "@/lib/reviews/alerts/tick";

// 口コミ 第2段階の定期処理(外部のスケジューラー cron-job.org から5分ごと)。lib/reviews/alerts/tick.ts。
//   ・呼び出しは専用の秘密の値(Bearer REVIEWS_CRON_SECRET。32文字以上)で、定数時間で比較する。未設定なら動かさない。
//   ・処理する店舗は DB で決め、クライアントから受け取らない。応答は件数だけ(口コミの内容・店舗は返さない)。
//   ・期限切れの記録の削除は、フラグ・利用可否に関係なく毎回行う。自動取得は GBP_AUTO_SYNC_ENABLED、
//     LINE 通知は REVIEW_ALERTS_ENABLED。本番以外では LINE へ実際には送らない(lineSendMode)。
//   ・?dryRun=1 は、対象の件数を返すだけ(取得・削除・送信・記録をしない)。
export const runtime = "nodejs";
export const maxDuration = 60;

function isAuthorized(header: string | null): boolean {
  const secret = process.env.REVIEWS_CRON_SECRET;
  if (!secret || secret.length < 32 || !header) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const provided = Buffer.from(header);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request.headers.get("authorization"))) {
    return new NextResponse(null, { status: 401 });
  }
  const lineSendMode = resolveLineSendPolicy().mode;
  const flags = { autoSync: isAutoSyncEnabled(), alerts: isReviewAlertsEnabled() };

  if (request.nextUrl.searchParams.get("dryRun") === "1") {
    try {
      const store = getReviewAlertStore();
      const [due, pending] = await Promise.all([store.dueLocations(GBP_CONSENT_VERSION, 500), store.pendingEvents(500)]);
      return NextResponse.json({ dryRun: true, dueLocations: due.length, pendingEvents: pending.length, flags, lineSendMode });
    } catch {
      return NextResponse.json({ dryRun: true, error: "unavailable" }, { status: 500 });
    }
  }

  try {
    const summary = await runReviewTick(getReviewTickDeps());
    return NextResponse.json({
      purged: summary.purged,
      entitlementStops: summary.entitlementStops,
      autoSync: summary.autoSync,
      evaluate: summary.evaluate,
      deliver: summary.deliver,
      errors: summary.errors,
      flags,
      lineSendMode,
    });
  } catch {
    console.warn("reviews tick failed");
    return NextResponse.json({ error: "tick_failed" }, { status: 500 });
  }
}
