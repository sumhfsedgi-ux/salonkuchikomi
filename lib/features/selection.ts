import "server-only";
import { getNotificationsSupabaseAdmin as getServiceRoleClient } from "@/lib/notifications/admin";
import { FEATURE_REGISTRY, type FeatureKey } from "@/lib/features/registry";

// お客様が使う機能の選択を保存する。
//   - 登録されている全機能の行(true/false)を書き、保存日時を記録する(以後は推定しない)
//   - 契約(salons.plan)・データ・Google の認証情報には一切触れない
//   - 予約通知を OFF にすると、DB のトリガーが「手動で止めた期間」を記録する
//     (再開しても、その間に届いた予約はまとめて送らない)
//   - 予約通知を選んだら、運用状態の行が無ければ「開始前」で作る(既にあれば状態を変えない)

export async function saveFeatureSelection(params: {
  salonId: string;
  userId: string;
  /** 契約上利用でき、提供中の機能の中から選ばれたもの(呼び出し元で検証済み)。 */
  selected: FeatureKey[];
}): Promise<void> {
  const supabase = getServiceRoleClient();
  const now = new Date().toISOString();
  const rows = FEATURE_REGISTRY.map((def) => ({
    salon_id: params.salonId,
    feature_key: def.key,
    selected: params.selected.includes(def.key),
    updated_by: params.userId,
    updated_at: now,
  }));
  const { error } = await supabase.from("salon_feature_selections").upsert(rows, { onConflict: "salon_id,feature_key" });
  if (error) throw new Error("利用する機能の保存に失敗しました。");

  const { error: stateError } = await supabase
    .from("salon_setup_state")
    .upsert({ salon_id: params.salonId, feature_selection_saved_at: now, updated_at: now }, { onConflict: "salon_id" });
  if (stateError) throw new Error("利用する機能の保存に失敗しました。");

  if (params.selected.includes("reservation_notifications")) {
    const { error: opsError } = await supabase
      .from("reservation_notification_operations")
      .upsert({ salon_id: params.salonId }, { onConflict: "salon_id", ignoreDuplicates: true });
    if (opsError) throw new Error("利用する機能の保存に失敗しました。");
  }
}
