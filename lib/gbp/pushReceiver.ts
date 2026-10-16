import { google } from "googleapis";
import { isValidTopic } from "@/lib/gbp/notificationSetting";

// Google の通知(Cloud Pub/Sub の push)の受信(app/api/google/reviews/push/route.ts)。
//   ・認証: Pub/Sub が Authorization に付ける OIDC の JWT を、Google の公開鍵で署名検証する(lib/google/idToken.ts と同じ部品)。
//     aud(GBP_PUBSUB_AUDIENCE)・iss(accounts.google.com)・email(push 用のサービスアカウント)・email_verified を確かめる。
//     発行から最大1時間のトークンがあり得るので、発行時刻で厳しく弾かない(exp の確認はライブラリが行う)。
//   ・本文: { message: { data(base64 の JSON), messageId, publishTime, attributes }, subscription }。サブスクリプション名を確かめる。
//     通知の中身の項目名は本物の通知で確かめる(計画 §0 G6)。location は文字列の値から locations/{id} を探す。

export interface PushConfig {
  audience: string;
  serviceAccountEmail: string;
  subscription: string | null;
  topic: string | null;
}

/** GBP_PUBSUB_ENABLED=1 で、検証に要る値がそろっているときだけ。 */
export function pushConfig(env: Record<string, string | undefined> = process.env): PushConfig | null {
  if (env.GBP_PUBSUB_ENABLED !== "1") return null;
  const audience = env.GBP_PUBSUB_AUDIENCE?.trim();
  const serviceAccountEmail = env.GBP_PUBSUB_PUSH_SA_EMAIL?.trim();
  if (!audience || !serviceAccountEmail || !/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(serviceAccountEmail)) return null;
  const subscription = env.GBP_PUBSUB_SUBSCRIPTION?.trim() || null;
  const topic = isValidTopic(env.GBP_PUBSUB_TOPIC?.trim()) ? env.GBP_PUBSUB_TOPIC!.trim() : null;
  return { audience, serviceAccountEmail, subscription, topic };
}

const ISSUERS = ["accounts.google.com", "https://accounts.google.com"];

export async function verifyPushToken(authorization: string | null, config: PushConfig, certs: Record<string, string>): Promise<boolean> {
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization ?? "");
  if (!match) return false;
  try {
    const client = new google.auth.OAuth2();
    const ticket = await client.verifySignedJwtWithCertsAsync(match[1], certs, config.audience, ISSUERS);
    const payload = ticket.getPayload() as Record<string, unknown> | undefined;
    if (!payload) return false;
    const verified = payload.email_verified === true || payload.email_verified === "true";
    return verified && payload.email === config.serviceAccountEmail;
  } catch {
    return false;
  }
}

export interface PushMessage {
  messageId: string;
  publishTime: string | null;
  subscription: string | null;
  notificationType: string | null;
  locationName: string | null;
}

const LOCATION = /(?:^|\/)(locations\/[A-Za-z0-9_-]{1,100})(?:\/|$)/;

function findLocation(value: unknown, depth = 0): string | null {
  if (depth > 3) return null;
  if (typeof value === "string") return LOCATION.exec(value)?.[1] ?? null;
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      const found = findLocation(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** push の本文を読む。形が違えば null(400)。 */
export function parsePushBody(body: unknown): PushMessage | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { message?: unknown; subscription?: unknown };
  const m = b.message as { data?: unknown; messageId?: unknown; message_id?: unknown; publishTime?: unknown; attributes?: unknown } | undefined;
  if (!m || typeof m !== "object") return null;
  const messageId = typeof m.messageId === "string" ? m.messageId : typeof m.message_id === "string" ? m.message_id : null;
  if (!messageId || messageId.length > 200) return null;
  let data: unknown = null;
  if (typeof m.data === "string" && m.data.length <= 64_000) {
    try {
      data = JSON.parse(Buffer.from(m.data, "base64").toString("utf8"));
    } catch {
      data = null;
    }
  }
  const fields = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const typeValue = fields.type ?? fields.notificationType ?? fields.notification_type;
  const notificationType = typeof typeValue === "string" && /^[A-Z_]{1,40}$/.test(typeValue) ? typeValue : null;
  const publishTime = typeof m.publishTime === "string" && !Number.isNaN(Date.parse(m.publishTime)) ? new Date(m.publishTime).toISOString() : null;
  return {
    messageId,
    publishTime,
    subscription: typeof b.subscription === "string" ? b.subscription : null,
    notificationType,
    locationName: findLocation(data) ?? findLocation(m.attributes),
  };
}
