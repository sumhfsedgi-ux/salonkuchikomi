import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { isFeatureServedByMode } from "@/lib/appMode";
import { plansIncluding } from "@/lib/access/plan";
import { getGoogleFlowDeps } from "@/lib/google/runtime";
import { listPollableSalons } from "@/lib/notifications/db/operations";
import { pollMailForAllSalons } from "@/lib/notifications/jobs/pollMailForAllSalons";
import { resolveLineSendPolicy } from "@/lib/notifications/line/sendPolicy";

// 外部スケジューラ(cron-job.org)から呼ばれるエンドポイント。共有シークレットの Bearer トークンを
// 定数時間で比較する。処理する店舗は DB の運用状態(稼働中)から決め、クライアントから受け取らない。
//
// 60 は Vercel の一般的な上限を前提にした値。本番反映前にプロジェクトの設定を確認すること。
// 処理は lib/notifications/jobs/runBudget.ts の CRON_RUN_BUDGET_MS(45秒)までに新しい処理を始めるのをやめ、
// 通信のタイムアウトと結果の記録を含めてこの上限の内側で終える(残りは次の回)。
export const runtime = "nodejs";
export const maxDuration = 60;

function isAuthorized(header: string | null): boolean {
  const secret = process.env.NOTIFICATIONS_CRON_SECRET;
  if (!secret || !header) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const provided = Buffer.from(header);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

/**
 * ?dryRun=1 は、処理の対象になる店舗の件数を返すだけ(メールの取得・クレーム・送信・記録を一切しない)。
 */
export async function POST(request: NextRequest) {
  if (!isAuthorized(request.headers.get("authorization"))) {
    return new NextResponse(null, { status: 401 });
  }

  if (request.nextUrl.searchParams.get("dryRun") === "1") {
    const plans = isFeatureServedByMode("notifications") ? plansIncluding("notifications") : [];
    const salons = plans.length > 0 ? await listPollableSalons(plans) : [];
    return NextResponse.json({ dryRun: true, pollableSalons: salons.length });
  }

  const deps = getGoogleFlowDeps();
  const summary = await pollMailForAllSalons({ transport: deps.transport, config: deps.config });
  return NextResponse.json({
    salonsProcessed: summary.salonsProcessed,
    salonsFailed: summary.salonsFailed,
    salonsSkipped: summary.salonsSkipped,
    salonsDeferred: summary.salonsDeferred,
    // 本番以外(開発・テスト用DB・擬似・プレビュー)では "simulated"(LINE へは実際に送らない。配信は未送信のまま)。
    lineSendMode: resolveLineSendPolicy().mode,
  });
}
