// 運営管理の画面の表示名(運営向け)。色だけに頼らず、状態は必ず文字で出す。

export const PLAN_LABELS = { reviews: "口コミプラン", salonpack: "SalonPack" } as const;

export const OPS_STATE_LABELS: Record<string, string> = {
  setup_pending: "開始前",
  awaiting_cutover: "旧サービスからの切り替え待ち",
  active: "稼働中",
  paused: "運営による停止中",
};

export const STOP_KIND_LABELS: Record<string, string> = {
  outage: "障害による停止",
  auth: "Google認証切れ",
  gmail_scope: "Gmailの権限不足",
  manual_feature_off: "お客様の利用停止",
  manual_master_off: "受信OFF",
  operator_pause: "運営による停止",
  contract: "契約による停止(旧方式)",
  legacy_active: "旧側の稼働を検知",
  legacy_cutover: "旧側からの切り替え待ち",
  entitlement: "権限による停止",
};

export const AUTH_STATE_LABELS: Record<string, string> = {
  active: "有効",
  needs_reauth: "再接続が必要",
  revoking: "解除中",
  revoked: "解除済み",
  unknown: "不明",
};

export const ACTOR_KIND_LABELS: Record<string, string> = {
  operator: "管理画面",
  cli: "運用CLI",
  sql: "SQL・移行",
  system: "自動",
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
