// 届いた口コミの画面の日付の表示(日本時間)。サーバーとブラウザで同じ文字になるよう、
// 「何分前」のような今の時刻に依存する表示は使わない。

const DATE = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" });
const DATE_TIME = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** 2026/10/04 */
export function formatReviewDate(iso: string): string {
  return DATE.format(new Date(iso));
}

/** 10/04 10:32 */
export function formatCheckedAt(iso: string): string {
  return DATE_TIME.format(new Date(iso));
}

/** 投稿者が書き直したか(作成と更新が1分以上離れている)。 */
export function isEdited(createTime: string, updateTime: string): boolean {
  return Date.parse(updateTime) - Date.parse(createTime) > 60_000;
}
