import "server-only";
import { getNotificationsSupabaseAdmin as getServiceRoleClient } from "@/lib/notifications/admin";
import type { FeatureKey } from "@/lib/features/registry";
import type { ReservationSwitchSnapshot } from "@/lib/features/featureState";

// 機能ごとの内部スイッチ(salon_feature_selections)を、1つの機能の行だけ書き換える。
// お客様が機能を選ぶ画面は廃止した。ここで書くのは、お客様の明示的な操作のときだけ:
//   - 「〜の利用を停止する」 → その機能の行を OFF(比べずに必ず書く。止める方向を常に優先する)
//   - 予約通知の開始・再開   → 予約通知の行を ON(読んだときの値のままのときだけ書く)
// 予約通知の行は、DB がメール確認・送信のたびに確かめる(運用状態・契約・受信の ON/OFF と同時に満たす条件)。
// OFF にすると DB のトリガーが「お客様が止めた期間」を記録し、その間に届いた予約は再開しても送らない。
// 契約(salons.plan)・運用状態・Google の認証情報・ほかの機能の行には触れない。

const SAVE_ERROR = "設定の保存に失敗しました。";

export async function turnOffFeatureSwitch(params: { salonId: string; userId: string; key: FeatureKey }): Promise<void> {
  const { error } = await getServiceRoleClient()
    .from("salon_feature_selections")
    .upsert(
      { salon_id: params.salonId, feature_key: params.key, selected: false, updated_by: params.userId, updated_at: new Date().toISOString() },
      { onConflict: "salon_id,feature_key" }
    );
  if (error) throw new Error(SAVE_ERROR);
}

/**
 * 予約通知の内部スイッチを ON にする。状態を確かめたときに読んだ値(expected)から変わっていない場合だけ書く
 * (確かめたあとに別の画面から「利用を停止する」が入っていたら、古い判定で解除しない)。
 * 書けたら true、別の操作で変わっていて書かなかったら false。
 */
export async function turnOnReservationSwitch(params: {
  salonId: string;
  userId: string;
  expected: ReservationSwitchSnapshot | null;
}): Promise<boolean> {
  const supabase = getServiceRoleClient();
  const row = { selected: true, updated_by: params.userId, updated_at: new Date().toISOString() };
  if (params.expected === null) {
    // 行が無かった: 挿入する。同時に誰かが行を作っていたら何もしない(0件)。
    const { data, error } = await supabase
      .from("salon_feature_selections")
      .upsert({ salon_id: params.salonId, feature_key: "reservation_notifications", ...row }, { onConflict: "salon_id,feature_key", ignoreDuplicates: true })
      .select("salon_id");
    if (error) throw new Error(SAVE_ERROR);
    return (data ?? []).length === 1;
  }
  // 行があった: 読んだときの値と更新日時のままの場合だけ書く(同時に書き換えられた行は、DB が条件を確かめ直す)。
  const { data, error } = await supabase
    .from("salon_feature_selections")
    .update(row)
    .eq("salon_id", params.salonId)
    .eq("feature_key", "reservation_notifications")
    .eq("selected", params.expected.selected)
    .eq("updated_at", params.expected.updatedAt)
    .select("salon_id");
  if (error) throw new Error(SAVE_ERROR);
  return (data ?? []).length === 1;
}
