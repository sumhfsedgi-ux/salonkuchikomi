// 口コミ作成中の表示(0033 の review_generation_showcases)。お客様ページで口コミの文章を作っている間に、
// 店舗の写真1枚とキャッチコピーを出す。管理画面・お客様ページ・Server Action で共通に使う(ブラウザからも import する)。
//
// 写真とコピーは口コミの生成には使わない(生成の入力はお客様の回答だけ。lib/reviewGeneration/requestBody.ts)。

/** キャッチコピーの上限(DB の check と同じ)。 */
export const CATCH_COPY_MAX_LENGTH = 30;
/** 画面に出す目安(写真の上で2行に収まる長さ)。 */
export const CATCH_COPY_RECOMMENDED = { min: 15, max: 25 } as const;

/** 写真1枚の上限(Storage のバケットの file_size_limit と同じ)。 */
export const SHOWCASE_IMAGE_MAX_BYTES = 1024 * 1024;
export const SHOWCASE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type ShowcaseImageType = (typeof SHOWCASE_IMAGE_TYPES)[number];

/** 管理画面で編集する設定。imageUrl は保存済みの写真の公開URL(無ければ null)。 */
export interface ShowcaseSettings {
  enabled: boolean;
  catchCopy: string;
  imageUrl: string | null;
}

export const DEFAULT_SHOWCASE_SETTINGS: ShowcaseSettings = { enabled: false, catchCopy: "", imageUrl: null };

/** お客様ページに渡す公開用のデータ(有効で、写真とコピーがそろっているときだけ作る)。 */
export interface PublicShowcase {
  imageUrl: string;
  catchCopy: string;
}

/** 文字数は見た目の1文字ずつで数える(絵文字・サロゲートペアを2文字にしない)。 */
export function catchCopyLength(text: string): number {
  return [...text].length;
}

/** 前後の空白を除く。改行は入れられない(1行の入力欄。写真の上では2行まで折り返して出す)。 */
export function normalizeCatchCopy(raw: string): string {
  return raw.trim();
}

/** 保存できない理由(保存できるなら null)。 */
export function catchCopyError(copy: string): string | null {
  if (/[\r\n]/.test(copy)) return "キャッチコピーに改行は入れられません。";
  if (catchCopyLength(copy) > CATCH_COPY_MAX_LENGTH) {
    return `キャッチコピーは${CATCH_COPY_MAX_LENGTH}文字以内で入力してください。`;
  }
  return null;
}

/** 有効にできない理由(有効にできるなら null)。写真とコピーの両方が必要。 */
export function enableError(input: { hasImage: boolean; catchCopy: string }): string | null {
  if (!input.hasImage && !input.catchCopy) return "表示するには、写真とキャッチコピーを設定してください。";
  if (!input.hasImage) return "表示するには、写真を設定してください。";
  if (!input.catchCopy) return "表示するには、キャッチコピーを入力してください。";
  return null;
}
