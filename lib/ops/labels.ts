// 運営管理の画面の表示名(運営向け)。色だけに頼らず、状態は必ず文字で出す。

export const PLAN_LABELS = { reviews: "口コミプラン", salonpack: "SalonPack" } as const;

export const ACTOR_KIND_LABELS: Record<string, string> = {
  operator: "管理画面",
  cli: "運用CLI",
  sql: "SQL・移行",
  system: "自動",
  owner: "お客様",
};

export function formatJst(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}
