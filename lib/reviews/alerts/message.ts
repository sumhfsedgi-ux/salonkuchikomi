import type { messagingApi } from "@line/bot-sdk";
import type { AlertMessageData } from "@/lib/reviews/alerts/store";

// 口コミの LINE 通知の文面(すべての口コミで同じ。低評価・本文なしでも変えない)。
//   【SalonPack】○○店
//   新しい口コミが届きました。
//   ［口コミを確認する］(SalonPack の口コミの詳細へのボタン)
// 送るのは登録店舗名と SalonPack の確認用の URL だけ。口コミの本文・抜粋・評価・投稿者名・写真・件数は載せない
// (配信の行にも保存しない。lib/reviews/alerts/store.ts の AlertMessageData)。

const BRAND = "【SalonPack】";
const BODY = "新しい口コミが届きました。";
const BUTTON = "口コミを確認する";

function salonLabel(salonName: string): string {
  const name = salonName.replace(/\s+/g, " ").trim();
  return name || "ご登録の店舗";
}

/** 通知の一覧(トーク一覧・プッシュ通知)に出る代替の文。 */
export function reviewAlertAltText(data: AlertMessageData): string {
  return `${BRAND}${salonLabel(data.salonName)} ${BODY}`;
}

/** 確認ボタン付きの Flex メッセージ。同じ data からは常に同じ内容になる(再試行で内容を変えない)。 */
export function buildReviewAlertMessage(data: AlertMessageData): messagingApi.FlexMessage {
  return {
    type: "flex",
    altText: reviewAlertAltText(data),
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          { type: "text", text: `${BRAND}${salonLabel(data.salonName)}`, weight: "bold", wrap: true },
          { type: "text", text: BODY, wrap: true },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [{ type: "button", style: "primary", height: "sm", action: { type: "uri", label: BUTTON, uri: data.url } }],
      },
    },
  };
}

/** テスト通知(ボタンなし)。 */
export function reviewAlertTestText(salonName: string): string {
  return `${BRAND}${salonLabel(salonName)}\n口コミのLINE通知のテストです。`;
}
