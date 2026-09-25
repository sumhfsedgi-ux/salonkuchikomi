import { GMAIL_SENDER_SEARCH_QUERY } from "@/lib/notifications/hotpepper/senderPatterns";

// (hmailの lib/mail/gmailSearchQuery.ts を無変更で移植)

const CANDIDATE_WINDOW_DAYS = 3;

// 実行環境のローカルタイムゾーンに依存させないためUTCで組み立てる
// (Gmail自体のafter:/before:解釈はメールボックス所有者のGmail設定
// タイムゾーンに対して行われるため、UTC厳密一致に意味は無いが、
// 計算自体を環境によらず決定的にするため)。
function formatGmailDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

/**
 * 1サロン分の予約メール候補を絞り込むGmail検索クエリを組み立てる。
 *  - newer_than:Nd -- 通常運用時のローリングウィンドウ。
 *  - after:connectedSince -- サロンが最初にGmailへ接続した時点より前の
 *    メールは絶対に「新着」として拾わない(初回接続時に受信箱の既存メールを
 *    新着扱いしないため)。
 * 日単位の精度のみ(Gmailのafter:は日単位でしか指定できない) -- 接続直前
 * 数時間以内の同日メールが一度だけすり抜ける可能性は、セットアップ時に
 * 数日〜数週間分の古いメールがLINEへ殺到する事態に比べれば許容できる
 * トレードオフとする。
 */
export function buildCandidateSearchQuery(connectedSince: Date): string {
  return `${GMAIL_SENDER_SEARCH_QUERY} newer_than:${CANDIDATE_WINDOW_DAYS}d after:${formatGmailDate(connectedSince)}`;
}
