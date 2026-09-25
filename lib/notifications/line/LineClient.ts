import { messagingApi } from "@line/bot-sdk";

// (hmailの lib/line/LineClient.ts を移植。pushTextのみ -- replyTextは
// webhookのリンク完了返信専用で、今回はセルフサーブ連携フロー自体を
// スコープ外としているため持たない。)

let client: messagingApi.MessagingApiClient | undefined;

function getClient(): messagingApi.MessagingApiClient {
  if (!client) {
    const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (!channelAccessToken) {
      throw new Error("LINE_CHANNEL_ACCESS_TOKEN が設定されていません。.env.local を確認してください。");
    }
    client = new messagingApi.MessagingApiClient({ channelAccessToken });
  }
  return client;
}

export class LineSendError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "LineSendError";
  }
}

/** 特定のLINEユーザーへプッシュメッセージを送る。月間プッシュクォータを消費する。 */
export async function pushText(destinationId: string, text: string): Promise<void> {
  try {
    await getClient().pushMessage({ to: destinationId, messages: [{ type: "text", text }] });
  } catch (error) {
    throw new LineSendError("LINEへの通知送信に失敗しました", error);
  }
}
