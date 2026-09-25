import { getNotificationsSupabaseAdmin } from "@/lib/notifications/admin";

// (hmailの lib/db/notificationHistory.ts を移植。1店舗に複数のLINE送信先
// (スタッフ)を持てるようにしたため、各行がどの送信先向けだったかを
// line_connection_idで判別できるようにしている -- PLAN 11b節参照。
// attempts = attempts + 1 のような生SQL式でのupdateはSupabase JSクライアントに
// 無いため、markRetryOutcome()は migration の notifications_mark_retry_outcome
// RPCを呼ぶ。)

export type NotificationStatus = "sent" | "failed" | "skipped_disabled" | "test";

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

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_WINDOW_HOURS = 24;

/**
 * 直近の失敗(テスト通知は除く)のうち、まだ再送対象になっているもの。
 * line_connection_idがnull(=そもそも送信先が1件も無かったケース)の行は
 * 再送しようがないため、呼び出し元(retrySweep)でスキップする。
 */
export async function listRetryableFailures(salonId: string): Promise<NotificationHistoryRow[]> {
  const cutoff = new Date(Date.now() - RETRY_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const supabase = getNotificationsSupabaseAdmin();
  const { data, error } = await supabase
    .from("notification_history")
    .select(COLUMNS)
    .eq("salon_id", salonId)
    .eq("status", "failed")
    .lt("attempts", MAX_RETRY_ATTEMPTS)
    .gt("sent_at", cutoff);

  if (error) {
    console.error("listRetryableFailures failed:", error);
    throw new Error("再送対象の取得に失敗しました。");
  }
  return (data ?? []).map(rowToHistory);
}

export async function markRetryOutcome(
  id: string,
  outcome: { status: "sent" | "failed"; errorMessage?: string }
): Promise<void> {
  const supabase = getNotificationsSupabaseAdmin();
  const { error } = await supabase.rpc("notifications_mark_retry_outcome", {
    p_id: id,
    p_status: outcome.status,
    p_error_message: outcome.errorMessage ?? null,
  });

  if (error) console.error("markRetryOutcome failed:", error);
}
