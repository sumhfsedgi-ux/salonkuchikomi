/**
 * hmail(スタッフ単位でmaster_enabled・new_reservation_enabled・cancellation_enabled
 * を持つ)から review-app(店舗単位のnotification_settings.master_enabled +
 * スタッフ単位のline_connections.{new_reservation_enabled,cancellation_enabled}の
 * 2層構造)へ、通知設定を変換する純粋関数。migrate-hmail-notifications.tsから
 * 呼ばれる(DB操作を含まないためユニットテスト可能 -- __tests__/scripts/
 * migrateHmailSettingsFold.test.ts参照)。
 *
 * 【直した不具合】旧実装はsource group内のmaster_enabledを「いずれか1つでも
 * trueならtrue」というORで店舗単位へ統合していた。これだと、あるスタッフが
 * 個人として通知を全てOFFにしていても(hmail側のmaster_enabled=false)、
 * 他のスタッフが1人でもONなら、そのスタッフのline_connections側の
 * new_reservation_enabled/cancellation_enabledが(各自の値のまま)有効化されて
 * しまい、「OFFにしていたはずなのに移行後は通知が来る」という結果になる。
 *
 * 【設計】hmail側に店舗単位の概念は無い(スタッフ単位のmaster_enabledしか
 * 存在しない)ため、各スタッフの「個人のmaster_enabled」は、そのスタッフの
 * line_connections側のnew_reservation_enabled/cancellation_enabledへ畳み込む
 * (AND演算: 実効値 = 個人のmaster_enabled AND 個人の種別別トグル)。
 * これにより「OFFだった人はOFFのまま」が種別を問わず正確に保たれる。
 * 店舗単位のnotification_settings.master_enabledは常にtrueから始める
 * (hmailに店舗単位の概念が無いため、過去の値を推測で作らない -- 代わりに
 * 全てスタッフ単位のline_connectionsトグルで表現する)。
 *
 * 設定が欠損している(hmail側にnotification_settings行が無い)スタッフは、
 * 「無条件でON」に倒さない(ユーザー指示)。安全側に倒し、通知を送らない
 * (false)として扱う -- 呼び出し元はmissingSettingsフラグを見て、運用者が
 * 個別に確認できるようにすること。
 */

export interface HmailStaffSettings {
  hmailSalonId: string;
  /** hmail.notification_settings行が見つからなかった場合はnull。 */
  masterEnabled: boolean | null;
  newReservationEnabled: boolean | null;
  cancellationEnabled: boolean | null;
}

export interface FoldedStaffSettings {
  hmailSalonId: string;
  newReservationEnabled: boolean;
  cancellationEnabled: boolean;
  /** true の場合、hmail側に設定行が無かったため安全側(false)に倒したことを示す。運用者の確認対象。 */
  missingSettings: boolean;
}

export function foldStaffSettings(staff: HmailStaffSettings): FoldedStaffSettings {
  const missingSettings = staff.masterEnabled === null;
  // 欠損時は安全側(false)。masterEnabled自体がfalseの場合も、種別を問わずfalseにする
  // (「個人としてOFFにした」をそのまま引き継ぐ -- 旧実装のORによる上書きを廃止)。
  const master = staff.masterEnabled === true;
  return {
    hmailSalonId: staff.hmailSalonId,
    newReservationEnabled: master && (staff.newReservationEnabled ?? true),
    cancellationEnabled: master && (staff.cancellationEnabled ?? true),
    missingSettings,
  };
}

export function foldAllStaffSettings(staffList: HmailStaffSettings[]): FoldedStaffSettings[] {
  return staffList.map(foldStaffSettings);
}
