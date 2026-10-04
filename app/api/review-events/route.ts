import { NextResponse } from "next/server";
import { z } from "zod";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { generationExists, recordGenerationEvent } from "@/lib/reviewGeneration/events";
import { checkEventRateLimit, clientIp } from "@/lib/reviewGeneration/rateLimit";

export const runtime = "nodejs";

const bodySchema = z.object({
  generationId: z.string().uuid(),
  salonId: z.string().uuid(),
});

// お客様ページの CTA(内容を確認してGoogleに投稿する)のクリックを記録する(本文は受け取らない)。
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
  if (await generationExists(admin, generationId, salonId)) {
    await recordGenerationEvent(admin, { generationId, salonId, kind: "cta_clicked" });
  }
  return new NextResponse(null, { status: 204 });
}
