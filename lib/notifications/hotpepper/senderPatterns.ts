/**
 * Hot Pepper Beautyの予約通知メールの送信元・件名パターン。特定のサロンではなく
 * プラットフォーム自体の形式を表すため、lib/notifications/内で唯一のリテラル定数として持つ。
 * (hmailの lib/hotpepper/senderPatterns.ts を無変更で移植)
 */

// 実際の受信箱を直接確認して確定した送信元。予約・当日予約・キャンセルの
// 通知はすべてこの1アドレスから届く。isFromHotPepper()はこの1シグナルのみを
// 見る(件名・本文へのフォールバックは無い)。
export const SENDER_DOMAIN_PATTERNS: RegExp[] = [
  /yoyaku_system@salonboard\.com(?=>|$)/i,
];

// 実際の4通のSALON BOARDメールで確認済みの件名: "予約連絡"、
// "【当日】予約連絡"、"SALON BOARD直前予約のお知らせ..."(当日・直前予約だが
// 新規予約として扱う)、"キャンセル連絡"。「予約変更」に相当するメールは
// 一度も観測されていないため、変更専用パターンは意図的に持たない
// (未検証のまま持っていた過去の推測パターンは削除済み)。変更は現状
// eventType='unknown'として扱われ、通知自体は送られる(見逃しはしない)。
export const NEW_RESERVATION_SUBJECT_PATTERNS: RegExp[] = [
  /予約連絡/,
  /直前予約/,
  /新規.{0,4}(ご)?予約/,
  /予約が入りました/,
  /ネット予約受付/,
];

export const CANCELLATION_SUBJECT_PATTERNS: RegExp[] = [
  /キャンセル連絡/,
  /キャンセル/,
  /予約.{0,4}取消/,
];

export const GENERIC_RESERVATION_SUBJECT_PATTERNS: RegExp[] = [
  /ご予約/,
  /予約/,
];

/**
 * Gmail検索クエリの事前フィルタ。SENDER_DOMAIN_PATTERNSと同じ1アドレスに
 * 揃えている(detectEmail側に送信元のフォールバックが無いため、検索側も
 * それより広い範囲を取得する理由がない)。
 */
export const GMAIL_SENDER_SEARCH_QUERY = "from:yoyaku_system@salonboard.com";
