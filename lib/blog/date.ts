// (blog-appの lib/date.ts を無変更で移植)
export function formatDateJST(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}/${map.month}/${map.day}`;
}
