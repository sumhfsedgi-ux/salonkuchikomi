import { getNotificationsSupabaseAdmin } from "@/lib/notifications/admin";
import type { EventType } from "@/lib/notifications/hotpepper/types";

// (hmailの lib/db/lineConnections.ts を移植。ただし1店舗=1行だったhmailと異なり、
// review-appでは1店舗に複数のLINE送信先(スタッフ)を持てる設計にしている
// -- PLAN 11b節参照。新規のLINEひもづけ(setLineDestination相当)は今回の
// 既存ユーザーの接続先は移行スクリプトが、新しい通知先は招待と LINE ログイン
// (lib/notifications/line/login/flow.ts・DB の line_invite_redeem)が書き込む。)

export interface LineConnection {
  id: string;
  salonId: string;
  destinationId: string | null;
  label: string | null;
  status: "connected" | "not_connected";
  newReservationEnabled: boolean;
  cancellationEnabled: boolean;
  linkedAt: string | null;
}

interface LineConnectionRow {
  id: string;
  salon_id: string;
  destination_id: string | null;
  label: string | null;
  status: string;
  new_reservation_enabled: boolean;
  cancellation_enabled: boolean;
  linked_at: string | null;
}

const COLUMNS =
  "id, salon_id, destination_id, label, status, new_reservation_enabled, cancellation_enabled, linked_at";

function rowToConnection(row: LineConnectionRow): LineConnection {
  return {
    id: row.id,
    salonId: row.salon_id,
    destinationId: row.destination_id,
    label: row.label,
    status: row.status as LineConnection["status"],
    newReservationEnabled: row.new_reservation_enabled,
    cancellationEnabled: row.cancellation_enabled,
    linkedAt: row.linked_at,
  };
}

/**
 * 1店舗に紐づく LINE 送信先(スタッフ)。既定では解除した通知先を含めない(配信の宛先・テスト通知に使う)。
 * 過去の配信の表示名を引くときだけ includeRemoved を使う。ON/OFF・表示名・解除は lib/notifications/recipients/db.ts
 * (切り替え待ちの間の制限を DB の関数で確かめる)。
 */
export async function listLineConnections(salonId: string, options: { includeRemoved?: boolean } = {}): Promise<LineConnection[]> {
  const supabase = getNotificationsSupabaseAdmin();
  let query = supabase.from("line_connections").select(COLUMNS).eq("salon_id", salonId);
  if (!options.includeRemoved) query = query.is("removed_at", null);
  const { data, error } = await query.order("linked_at", { ascending: true });

  if (error) {
    console.error("listLineConnections failed:", error);
    throw new Error("LINE接続の取得に失敗しました。");
  }
  return (data ?? []).map(rowToConnection);
}

/**
 * スタッフがこの種別の通知を受け取る設定か(画面表示用。送信の可否は送信直前に DB の
 * notifications_begin_send が同じ規則で判定する)。分類できなかった通知('unknown'・'change')は
 * 専用の設定が無いため、新規予約・キャンセルのどちらかを受け取る設定のスタッフにだけ送る
 * (全通知を OFF にしたスタッフには送らない)。
 */
export function isEventTypeEnabledForConnection(connection: LineConnection, eventType: EventType): boolean {
  switch (eventType) {
    case "new_reservation":
      return connection.newReservationEnabled;
    case "cancellation":
      return connection.cancellationEnabled;
    default:
      return connection.newReservationEnabled || connection.cancellationEnabled;
  }
}
