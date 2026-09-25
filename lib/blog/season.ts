// (blog-appの lib/season.ts を無変更で移植)
export type SeasonId = "spring" | "summer" | "autumn" | "winter";

export interface Season {
  id: SeasonId;
  label: string;
  month: number;
}

// Vercelのサーバー実行環境はUTCが基準になるため、日本時間の月を明示的に取り出す。
export function deriveSeason(date: Date): Season {
  const month = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", month: "numeric" }).format(date)
  );

  if (month >= 3 && month <= 5) return { id: "spring", label: "春", month };
  if (month >= 6 && month <= 8) return { id: "summer", label: "夏", month };
  if (month >= 9 && month <= 11) return { id: "autumn", label: "秋", month };
  return { id: "winter", label: "冬", month };
}
