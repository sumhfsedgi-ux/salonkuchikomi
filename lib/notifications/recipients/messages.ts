// 予約通知の設定画面で共通の文言(サーバー・クライアントの両方から使う)。

/** 切り替え待ちの間、旧側で使われている設定(全体スイッチ・引き継いだ通知先)を変更できないときの案内。 */
export const LOCKED_SETTING_MESSAGE = "現在、設定の準備中のため変更できません。変更が必要な場合は運営にお問い合わせください。";

/** テスト通知で LINE に送る本文。 */
export const TEST_NOTIFICATION_TEXT = "予約通知の設定が完了しました";

/** テスト通知の送信のしかた(lib/notifications/line/sendPolicy.ts の判定を画面用にしたもの)。 */
export type TestSendMode = "live" | "verify" | "simulated";

/** テスト通知のボタンの前に出す案内(押す前に、実際に送るかどうかを示す)。 */
export function testSendNotice(mode: TestSendMode, realRecipientCount: number): string {
  if (mode === "simulated" || realRecipientCount === 0) return "この環境では、LINEへは実際には送信しません(送信のシミュレーションだけを行います)。";
  if (mode === "verify") {
    return `検証モード: 指定した検証用の宛先(${realRecipientCount}人)にだけ、実際にテストメッセージを送ります。ほかの通知先には送りません。`;
  }
  return `登録済みの通知先(${realRecipientCount}人)のLINEに、実際にテストメッセージを送ります。`;
}

/** 実際に送る前の確認の文。 */
export function testSendConfirmation(realRecipientCount: number): string {
  return `${realRecipientCount}人のLINEに、実際にテストメッセージ「${TEST_NOTIFICATION_TEXT}」を送ります。送信してよろしいですか?`;
}

export const TEST_SEND_RESULT_MESSAGES = {
  live: "テスト通知をLINEに送りました(LINEが受け付けました)",
  verify: "検証用の宛先にだけ送信しました（ほかの通知先には実際には送信していません）",
  simulated: "送信をシミュレーションしました（実際には送信していません）",
} as const;
