import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getGbpMaintenanceStore } from "@/lib/gbp/runtime";

// 届いた口コミの一時保存の期限切れの内容を消す(計画 第2版 §3-9)。外部のスケジューラーから1日1回呼ぶ。
//   ・利用可否(準備中・許可が無い・契約外・利用開始待ち)・GOOGLE_REVIEWS_OAUTH_ENABLED・Google の連携の状態を見ない。
//     利用を止めた店舗の内容も、期限が来たら必ず消す。Google は呼ばない(DB の中の削除だけ)。
//   ・呼び出しは専用の秘密の値(Bearer)で確かめる(poll-mail と同じ形。定数時間で比較)。値が未設定なら動かさない。
//   ・消した件数だけを返す(口コミの内容・店舗は返さない)。
export const runtime = "nodejs";
export const maxDuration = 60;

function isAuthorized(header: string | null): boolean {
  const secret = process.env.GBP_MAINTENANCE_SECRET;
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
  try {
    const purged = await getGbpMaintenanceStore().purgeExpiredContent();
    return NextResponse.json({ purged });
  } catch {
    console.warn("gbp: purge of expired content failed");
    return NextResponse.json({ error: "purge_failed" }, { status: 500 });
  }
}
