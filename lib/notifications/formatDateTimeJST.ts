/** 「最近の通知」一覧の日時表示用。例: "9/11 15:30"。 */
export function formatDateTimeJST(iso: string): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.month}/${map.day} ${map.hour}:${map.minute}`;
}
