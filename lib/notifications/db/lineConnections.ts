import { getNotificationsSupabaseAdmin } from "@/lib/notifications/admin";
import type { EventType } from "@/lib/notifications/hotpepper/types";

// (hmailの lib/db/lineConnections.ts を移植。ただし1店舗=1行だったhmailと異なり、
// review-appでは1店舗に複数のLINE送信先(スタッフ)を持てる設計にしている
// -- PLAN 11b節参照。新規のLINEひもづけ(setLineDestination相当)は今回の
// スコープ外のセルフサーブ連携フロー用なので持たない。既存ユーザーの接続先は
// 移行スクリプトが直接書き込む。)

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

export type LineConnectionSettingsUpdate = Partial<
  Pick<LineConnection, "newReservationEnabled" | "cancellationEnabled" | "label">
>;

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

/** 1店舗に紐づく全LINE送信先(スタッフ)。 */
export async function listLineConnections(salonId: string): Promise<LineConnection[]> {
  const supabase = getNotificationsSupabaseAdmin();
  const { data, error } = await supabase
    .from("line_connections")
    .select(COLUMNS)
    .eq("salon_id", salonId)
    .order("linked_at", { ascending: true });

  if (error) {
    console.error("listLineConnections failed:", error);
    throw new Error("LINE接続の取得に失敗しました。");
  }
  return (data ?? []).map(rowToConnection);
}

/**
 * スタッフ単位のイベント種別トグルを更新する。salonIdも条件に含めることで、
 * クライアントから渡されたconnectionIdが呼び出し元自身の店舗のものであることを
 * DB側でも強制する(他店舗のline_connectionsを誤って/意図的に書き換えられない
 * ようにするため -- クライアント供給のIDを単体で信用しない、という設計原則)。
 */
export async function updateLineConnectionSettings(
  connectionId: string,
  salonId: string,
  update: LineConnectionSettingsUpdate
): Promise<void> {
  const supabase = getNotificationsSupabaseAdmin();
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (update.newReservationEnabled !== undefined) patch.new_reservation_enabled = update.newReservationEnabled;
  if (update.cancellationEnabled !== undefined) patch.cancellation_enabled = update.cancellationEnabled;
  if (update.label !== undefined) patch.label = update.label;

  const { error } = await supabase
    .from("line_connections")
    .update(patch)
    .eq("id", connectionId)
    .eq("salon_id", salonId);

  if (error) {
    console.error("updateLineConnectionSettings failed:", error);
    throw new Error("LINE送信先の設定保存に失敗しました。");
  }
}

export function isEventTypeEnabledForConnection(connection: LineConnection, eventType: EventType): boolean {
  switch (eventType) {
    case "new_reservation":
      return connection.newReservationEnabled;
    case "cancellation":
      return connection.cancellationEnabled;
    default:
      // 'unknown'(判定できない予約関連メール)は専用トグルが無いため常に通す。
      // 'change'もここを通るが、検出ロジックが'change'を生成することは無いため
      // 実質到達しない(hmailの既知の制約)。
      return true;
  }
}
