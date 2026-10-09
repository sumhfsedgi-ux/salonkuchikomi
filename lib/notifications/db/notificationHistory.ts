import { getNotificationsSupabaseAdmin } from "@/lib/notifications/admin";

// (hmailの lib/db/notificationHistory.ts を移植。1店舗に複数のLINE送信先
// (スタッフ)を持てるようにしたため、各行がどの送信先向けだったかを
// line_connection_idで判別できるようにしている -- PLAN 11b節参照。
//
// 【Lavi Aromatic Herb切替PLAN】このテーブルへの書き込みは「最近の通知」
// 表示用の履歴に専念する(recordNotification呼び出し時点のスナップショット)。
// 再送の排他制御・状態管理は notification_deliveries(0020、
// lib/notifications/db/notificationDeliveries.ts)へ移したため、旧
// listRetryableFailures/markRetryOutcome(排他制御なしで同時実行に弱かった)は
// 削除した。0009のnotifications_mark_retry_outcome RPC自体は書き換え禁止の
// migrationに含まれるため残るが、呼び出し元は無い。)

export type NotificationStatus = "sent" | "failed" | "skipped_disabled" | "test" | "unknown";

export interface NotificationHistoryRow {
  id: string;
  salonId: string;
  lineConnectionId: string | null;
  eventType: string;
  providerMessageId: string | null;
  lineText: string | null;
  status: NotificationStatus;
  attempts: number;
  errorMessage: string | null;
  sentAt: string;
}

interface RawHistoryRow {
  id: string;
  salon_id: string;
  line_connection_id: string | null;
  event_type: string;
  provider_message_id: string | null;
  line_text: string | null;
  status: string;
  attempts: number;
  error_message: string | null;
  sent_at: string;
}

const COLUMNS =
  "id, salon_id, line_connection_id, event_type, provider_message_id, line_text, status, attempts, error_message, sent_at";

function rowToHistory(row: RawHistoryRow): NotificationHistoryRow {
  return {
    id: row.id,
    salonId: row.salon_id,
    lineConnectionId: row.line_connection_id,
    eventType: row.event_type,
    providerMessageId: row.provider_message_id,
    lineText: row.line_text,
    status: row.status as NotificationStatus,
    attempts: row.attempts,
    errorMessage: row.error_message,
    sentAt: row.sent_at,
  };
}

export async function recordNotification(params: {
  salonId: string;
  lineConnectionId?: string | null;
  eventType: string;
  providerMessageId?: string;
  lineText?: string;
  status: NotificationStatus;
  errorMessage?: string;
}): Promise<void> {
  const supabase = getNotificationsSupabaseAdmin();
  const { error } = await supabase.from("notification_history").insert({
    salon_id: params.salonId,
    line_connection_id: params.lineConnectionId ?? null,
    event_type: params.eventType,
    provider_message_id: params.providerMessageId ?? null,
    line_text: params.lineText ?? null,
    status: params.status,
    error_message: params.errorMessage ?? null,
  });

  if (error) console.error("recordNotification failed:", error);
}

export async function listRecentHistory(salonId: string, limit = 10): Promise<NotificationHistoryRow[]> {
  const supabase = getNotificationsSupabaseAdmin();
  const { data, error } = await supabase
    .from("notification_history")
    .select(COLUMNS)
    .eq("salon_id", salonId)
    .order("sent_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("listRecentHistory failed:", error);
    throw new Error("通知履歴の取得に失敗しました。");
  }
  return (data ?? []).map(rowToHistory);
}

const TEST_NOTIFICATION_DEBOUNCE_MS = 10_000;

/**
 * 「テスト通知を送る」の連打対策。ボタン自体もクライアント側で送信中は
 * 無効化するが、それだけでは間に合わない連打(両方が無効化前に開始する)に
 * 備えたサーバー側の最終防御。
 */
export async function hasRecentTestNotification(salonId: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - TEST_NOTIFICATION_DEBOUNCE_MS).toISOString();
  const supabase = getNotificationsSupabaseAdmin();
  const { data, error } = await supabase
    .from("notification_history")
    .select("id")
    .eq("salon_id", salonId)
    .eq("event_type", "test")
    .gt("sent_at", cutoff)
    .limit(1);

  if (error) {
    console.error("hasRecentTestNotification failed:", error);
    return false;
  }
  return (data?.length ?? 0) > 0;
}
