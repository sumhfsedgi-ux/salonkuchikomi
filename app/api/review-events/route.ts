import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { generationExists, recordGenerationEvent } from "@/lib/reviewGeneration/events";
import { checkEventRateLimit, clientIp } from "@/lib/reviewGeneration/rateLimit";
import { loadReviewsAvailable } from "@/lib/reviewGeneration/availability";

export const runtime = "nodejs";

// review_copied = 「口コミをコピーして進む」でコピーできた、google_opened = 投稿のご案内の「Googleの投稿画面を開く」。
// kind の無い送信は、コピーと Google を同時に開いていた旧画面(開いたままのお客様)からのものとして cta_clicked にする。
const bodySchema = z.object({
  generationId: z.string().uuid(),
  salonId: z.string().uuid(),
  kind: z.enum(["review_copied", "google_opened"]).optional(),
});

// お客様ページの操作(コピー・Google の投稿画面を開く)を記録する(本文は受け取らない)。
// その店舗の生成として記録済みの generation_id だけを受け付け、同じ生成の2回目以降は無視する。
// 記録の成否はお客様に関係ないので、受け付けたら結果にかかわらず 204 を返す。
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return new NextResponse(null, { status: 400 });

  let admin;
  try {
    admin = getSupabaseAdmin();
  } catch {
    return new NextResponse(null, { status: 204 });
  }

  if (!(await checkEventRateLimit(admin, clientIp(request)))) {
    return new NextResponse(null, { status: 429 });
  }

  const { generationId, salonId } = parsed.data;
  const kind = parsed.data.kind ?? "cta_clicked";
  // 口コミを使えない店舗(運営による利用停止・利用開始待ち)の記録はしない(応答は同じ 204)。
  try {
    if ((await loadReviewsAvailable(admin, salonId)) !== true) return new NextResponse(null, { status: 204 });
  } catch {
    return new NextResponse(null, { status: 204 });
  }
  if (await generationExists(admin, generationId, salonId)) {
    await recordGenerationEvent(admin, { generationId, salonId, kind });
  }
  return new NextResponse(null, { status: 204 });
}
