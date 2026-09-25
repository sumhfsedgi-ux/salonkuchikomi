import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { pollMailForAllSalons } from "@/lib/notifications/jobs/pollMailForAllSalons";

// 外部スケジューラ(cron-job.org)から呼ばれるエンドポイント。hmail自身の
// /api/cron/poll-mail と同じ「共有シークレットのBearerトークン」方式だが、
// 単純な文字列比較(hmail側の実装)ではなくtimingSafeEqualによる定数時間比較に
// している(26節の改善点)。salon解決はログインセッションに依存せず、各接続
// テーブル自身が持つsalon_id(移行時にreview-appの実salons.idへre-key済み)を
// そのまま使う -- ここにクライアント供給のsalon_idが入り込む余地はない。
//
// 60はVercel Hobbyプランの一般的な上限を前提にした値 -- 実際のプロジェクト
// 設定(Vercelダッシュボード → Settings → Functions)は本番反映前に確認すること
// (app/api/blog/generate/route.tsと同じ注意点)。
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
 * ?dryRun=1 を付けると、本番のprocessed_emailsへのクレーム・
 * notification_historyへの書き込み・実際のLINE送信を一切行わない検証モードで
 * 実行する(23節の切替手順における事前動作確認用)。cron-job.orgからの本番
 * 呼び出しではこのパラメータを付けない。
 */
export async function POST(request: NextRequest) {
  if (!isAuthorized(request.headers.get("authorization"))) {
    return new NextResponse(null, { status: 401 });
  }

  const dryRun = request.nextUrl.searchParams.get("dryRun") === "1";
  const summary = await pollMailForAllSalons(dryRun);
  return NextResponse.json(summary);
}
