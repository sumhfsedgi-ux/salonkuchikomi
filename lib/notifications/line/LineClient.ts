import { messagingApi, HTTPFetchError } from "@line/bot-sdk";
import { isRealLineSendAllowed, resolveLineSendPolicy } from "@/lib/notifications/line/sendPolicy";

// (hmailの lib/line/LineClient.ts を移植・再設計)
//
// LINE公式の X-Line-Retry-Key(developers.line.biz/en/docs/messaging-api/retrying-api-request/)に沿って、
// 送信結果を次のように分類する:
//   - 200: LINE が受け付けた(x-line-request-id を控える)。端末への到達ではない
//     ("X-Line-Retry-Key allows you to safely retry API requests without duplicating messages,
//      but it doesn't guarantee reliable delivery of messages.")
//   - 409: 同じ retry key の依頼が既に受け付け済みのときの応答。x-line-accepted-request-id が付いている
//     場合だけ「受付済み」とみなす(付いていない 409 は結果不明として扱う)
//   - 429: レート制限は「受け付けていない」ので待って同じ key で再試行。月間の上限は全体を止めて運営へ警告
//   - その他の 4xx: 確定した失敗(再試行しない)
//   - 5xx・タイムアウト・通信エラー: 結果不明(同じ key で、最初の送信から24時間以内だけ再試行してよい)
// 同じ配信の再試行では、本文と送信先を変えない("Make your retried request the same as the original request.")。

let client: messagingApi.MessagingApiClient | undefined;

function getClient(): messagingApi.MessagingApiClient {
  if (!client) {
    const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (!channelAccessToken) {
      throw new Error("LINE_CHANNEL_ACCESS_TOKEN が設定されていません。");
    }
    client = new messagingApi.MessagingApiClient({ channelAccessToken });
  }
  return client;
}

/** 設定不備など、送信を試みる以前の異常(LINE には何も送っていない = 未送信と断定できる)。 */
export class LineSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LineSendError";
  }
}

/** この環境では実際の送信をしない(開発・テスト用DB・擬似・プレビュー、または検証の宛先でない)。HTTP は呼んでいない。 */
export class LineSendBlockedError extends LineSendError {
  constructor() {
    super("この環境ではLINEへ実際には送信しません");
    this.name = "LineSendBlockedError";
  }
}

export type LineSendResult =
  | { outcome: "sent"; requestId: string | null }
  | { outcome: "failed"; status: number }
  | { outcome: "retry_wait"; retryAfterSeconds: number }
  | { outcome: "quota_exceeded" }
  | { outcome: "unknown"; reason: string };

export type LineSendOutcome = LineSendResult["outcome"];

const SEND_TIMEOUT_MS = 10_000;
const RATE_LIMIT_RETRY_SECONDS = 60;

function headerValue(headers: unknown, name: string): string | null {
  if (headers && typeof (headers as Headers).get === "function") {
    const value = (headers as Headers).get(name);
    return value && /^[A-Za-z0-9-]{1,100}$/.test(value) ? value : null;
  }
  return null;
}

/** HTTP の応答(またはSDKのエラー)を送信結果へ分類する(テストしやすいよう切り出し)。 */
export function classifyLineError(error: unknown): LineSendResult {
  if (error instanceof HTTPFetchError) {
    if (error.status === 409) {
      const accepted = headerValue(error.headers, "x-line-accepted-request-id");
      return accepted ? { outcome: "sent", requestId: accepted } : { outcome: "unknown", reason: "409_without_accepted_id" };
    }
    if (error.status === 429) {
      return /monthly limit/i.test(String(error.body ?? ""))
        ? { outcome: "quota_exceeded" }
        : { outcome: "retry_wait", retryAfterSeconds: RATE_LIMIT_RETRY_SECONDS };
    }
    if (error.status >= 400 && error.status < 500) return { outcome: "failed", status: error.status };
    return { outcome: "unknown", reason: `http_${error.status}` };
  }
  if (error instanceof Error && error.name === "LineSendTimeout") return { outcome: "unknown", reason: "timeout" };
  return { outcome: "unknown", reason: "network" };
}

export interface LineSendOptions {
  /** 応答を待つ上限(定期処理の締切に合わせて縮める。超えたら結果不明として、同じ retry key で後で再試行)。 */
  timeoutMs?: number;
}

/**
 * 特定の LINE ユーザーへプッシュメッセージを送る。retryKey は配信ごとに保存した値をそのまま使う。
 * HTTP レベルの失敗では例外を投げず結果で返す。設定不備は LineSendError を投げる。
 * この環境で実際の送信が許されていない宛先(lib/notifications/line/sendPolicy.ts)なら、クライアントを作る前・
 * HTTP を呼ぶ前に LineSendBlockedError を投げる(実送信用のトークンが設定されていても送らない)。
 */
export async function pushText(destinationId: string, text: string, retryKey: string, options?: LineSendOptions): Promise<LineSendResult> {
  if (!isRealLineSendAllowed(resolveLineSendPolicy(), destinationId)) throw new LineSendBlockedError();
  let sendClient: messagingApi.MessagingApiClient;
  try {
    sendClient = getClient();
  } catch {
    throw new LineSendError("LINEクライアントの初期化に失敗しました");
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error("timeout");
      err.name = "LineSendTimeout";
      reject(err);
    }, Math.min(SEND_TIMEOUT_MS, options?.timeoutMs ?? SEND_TIMEOUT_MS));
  });
  try {
    const response = await Promise.race([
      sendClient.pushMessageWithHttpInfo({ to: destinationId, messages: [{ type: "text", text }] }, retryKey),
      timeout,
    ]);
    return { outcome: "sent", requestId: headerValue(response.httpResponse.headers, "x-line-request-id") };
  } catch (error) {
    return classifyLineError(error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
