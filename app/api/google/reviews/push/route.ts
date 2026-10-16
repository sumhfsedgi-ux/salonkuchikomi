import { NextRequest, NextResponse, after } from "next/server";
import { getGoogleFlowDeps } from "@/lib/google/runtime";
import { parsePushBody, pushConfig, verifyPushToken } from "@/lib/gbp/pushReceiver";
import { getReviewAlertStore, getReviewTickDeps } from "@/lib/reviews/alerts/runtime";
import { runReviewTick } from "@/lib/reviews/alerts/tick";

// Google の通知(Business Profile の通知設定 → Cloud Pub/Sub の push)の受信。lib/gbp/pushReceiver.ts。
//   ・GBP_PUBSUB_ENABLED が空・検証に要る値が無いなら 404(受け取らない)。
//   ・OIDC の JWT を検証できなければ 401。本文の形が違えば 400。サブスクリプション名が違えば 403。
//   ・受信の記録と取り込み待ちを DB に書けてから 204 を返す(書けなければ 503 で Pub/Sub が再送する)。
//     どの店舗にも当たらない通知・再送も 204(記録だけ)。
//   ・after() は同じ定期処理(取り込み・評価・配信)を早く始めるだけ。止まっても次の定期処理が続きを拾う。
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const config = pushConfig();
  if (!config) return new NextResponse(null, { status: 404 });

  let certs: Record<string, string>;
  try {
    certs = await getGoogleFlowDeps().transport.fetchSigningCerts();
  } catch {
    return new NextResponse(null, { status: 503 });
  }
  if (!(await verifyPushToken(request.headers.get("authorization"), config, certs))) {
    return new NextResponse(null, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  const message = parsePushBody(body);
  if (!message) return new NextResponse(null, { status: 400 });
  if (config.subscription && message.subscription !== config.subscription) return new NextResponse(null, { status: 403 });

  let outcome: string;
  try {
    outcome = await getReviewAlertStore().recordPush({
      messageId: message.messageId,
      notificationType: message.notificationType,
      locationName: message.locationName,
      publishTime: message.publishTime,
    });
  } catch {
    return new NextResponse(null, { status: 503 });
  }

  if (outcome === "recorded" || outcome === "duplicate_pending") {
    after(async () => {
      try {
        await runReviewTick(getReviewTickDeps());
      } catch {
        console.warn("gbp push: follow-up tick failed");
      }
    });
  }
  return new NextResponse(null, { status: 204 });
}
