// 返信の文字数・長さの上限の計算(画面とサーバーの両方で使う純粋な関数)。
// Google の返信の上限は UTF-8 で 4096 bytes(ReviewReply.comment)。画面では bytes ではなく
// 文字数を主に表示し、送れるかどうかの判定にだけ bytes を使う(docs/plans/google-reviews-inbox-plan.md §8-5)。

export const REPLY_MAX_BYTES = 4096;
/** 貼り付ける口コミ本文の上限(文字数)。Google の口コミより十分長くしておく。 */
export const REVIEW_TEXT_MAX_CHARS = 4000;

const encoder = new TextEncoder();

export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/** 画面に出す文字数(改行は数えない)。 */
export function displayLength(text: string): number {
  return [...text.replace(/\r?\n/g, "")].length;
}

export const MASKED_CONTACT = "［連絡先］";

const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s　、。「」（）()<>]+/gi;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 日本の電話番号の形(全角の数字・ハイフンも)。郵便番号のような短い数字の並びは対象にしない。
const PHONE_PATTERN = /(?:\+81[\s-ｰ－‐]?|[0０])[0-9０-９]{1,4}[\s-ｰ－‐ー]?[0-9０-９]{1,4}[\s-ｰ－‐ー]?[0-9０-９]{3,4}/g;

/**
 * AI に送る前に、口コミ本文の中の URL・メールアドレス・電話番号を伏せ字にする(計画 第2版 §3-6)。
 * 人名は確実に見分けられないため対象にしない(投稿者名は、もともと AI に送らない)。
 */
export function maskContactDetails(text: string): string {
  return text.replace(URL_PATTERN, MASKED_CONTACT).replace(EMAIL_PATTERN, MASKED_CONTACT).replace(PHONE_PATTERN, MASKED_CONTACT);
}

/** 上限を超えていれば、減らす必要がある文字数の目安(日本語は1文字3 bytes として切り上げ)。超えていなければ 0。 */
export function charsOverLimit(text: string, maxBytes = REPLY_MAX_BYTES): number {
  const over = utf8Bytes(text) - maxBytes;
  return over > 0 ? Math.ceil(over / 3) : 0;
}
