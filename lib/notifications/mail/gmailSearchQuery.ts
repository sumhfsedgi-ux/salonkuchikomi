import { GMAIL_SENDER_SEARCH_QUERY } from "@/lib/notifications/hotpepper/senderPatterns";

// Gmail の検索条件。after: に UNIX 秒を渡すと秒単位で絞り込める(日付だけの指定より正確)。
// 以前の newer_than:3d(3日より前は二度と拾わない)は使わない -- 取りこぼしは
// 保存した基準日時(watermark)と続き(page token)で防ぐ(lib/notifications/mail/gmailScan.ts)。

export function buildCandidateSearchQuery(after: Date): string {
  return `${GMAIL_SENDER_SEARCH_QUERY} after:${Math.floor(after.getTime() / 1000)}`;
}
