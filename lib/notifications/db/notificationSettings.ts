import { getNotificationsSupabaseAdmin } from "@/lib/notifications/admin";

// (hmailの lib/db/notificationSettings.ts を移植。ただしイベント種別ごとの
// ON/OFF(new_reservation_enabled/cancellation_enabled)はスタッフ単位の
// line_connections側へ移したため、ここには店舗全体のmaster_enabledのみを
// 持たせる -- PLAN 11b節参照。)

export interface NotificationSettings {
  salonId: string;
  masterEnabled: boolean;
}

interface NotificationSettingsRow {
  salon_id: string;
  master_enabled: boolean;
}

const COLUMNS = "salon_id, master_enabled";

function rowToSettings(row: NotificationSettingsRow): NotificationSettings {
  return {
    salonId: row.salon_id,
    masterEnabled: row.master_enabled,
  };
}

/** 行が無いサロンでも生成が動く必要があるため、既定値の行を自己修復的に作る。 */
export async function getNotificationSettings(salonId: string): Promise<NotificationSettings> {
  const supabase = getNotificationsSupabaseAdmin();
  const { data, error } = await supabase
    .from("notification_settings")
    .select(COLUMNS)
    .eq("salon_id", salonId)
    .maybeSingle();

  if (error) {
    console.error("getNotificationSettings failed:", error);
    throw new Error("通知設定の取得に失敗しました。");
  }
  if (data) return rowToSettings(data);

  const { data: created, error: upsertError } = await supabase
    .from("notification_settings")
    .upsert({ salon_id: salonId }, { onConflict: "salon_id", ignoreDuplicates: true })
    .select(COLUMNS);

  if (upsertError) {
    console.error("getNotificationSettings (self-heal insert) failed:", upsertError);
    throw new Error("通知設定の取得に失敗しました。");
  }

  return created?.[0] ? rowToSettings(created[0]) : { salonId, masterEnabled: true };
}

// 全体スイッチの変更は lib/notifications/recipients/db.ts の setMasterEnabled(切り替え待ちの間は DB が受け付けない)。
