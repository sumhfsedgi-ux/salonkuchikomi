// 口コミの画面とサーバーで共通の文言(画面が、文言を見て「一覧を読み込み直す」の操作を付けるため)。

/** Google連携・店舗が変わった(今の画面の情報が古い)。 */
export const CONNECTION_CHANGED_MESSAGE = "連携先が変更されました。最新の情報を読み込んでください。";
/** 同上。返信を送る前に分かった(返信は送っていない)。 */
export const CONNECTION_CHANGED_NOT_SENT_MESSAGE = "連携先が変更されたため、返信は送っていません。最新の情報を読み込んでください。";

/** 連携先・店舗が変わったことを伝える文言か(画面に「一覧を読み込み直す」を付ける)。 */
export function isConnectionChangedMessage(message: string | null | undefined): boolean {
  return message === CONNECTION_CHANGED_MESSAGE || message === CONNECTION_CHANGED_NOT_SENT_MESSAGE;
}

/** 結果が分からない送信を確かめる操作(Google から取り直す)の名前。サーバーの文言でも同じ名前を使う。 */
export const RECHECK_LABEL = "反映状況を再確認";
