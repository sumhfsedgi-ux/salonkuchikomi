import { describe, expect, it } from "vitest";
import { foldStaffSettings, foldAllStaffSettings } from "@/scripts/migrateHmailSettingsFold";

// Lavi Aromatic Herb切替PLAN シナリオ7の回帰テスト: 「旧側で一部スタッフだけ
// 処理済み/OFFになっている」設定が、移行後も正確に引き継がれること
// (無条件でONへ補完しない)。

describe("foldStaffSettings: 個人のmaster_enabled=falseをOFFのまま引き継ぐ", () => {
  it("masterEnabled=falseのスタッフは、個別トグルがtrueでも両方falseになる(旧実装のORバグの再現と修正確認)", () => {
    const result = foldStaffSettings({
      hmailSalonId: "staff-off",
      masterEnabled: false,
      newReservationEnabled: true, // 個別トグル自体はON(= masterだけをOFFにしていたケース)
      cancellationEnabled: true,
    });
    expect(result.newReservationEnabled).toBe(false);
    expect(result.cancellationEnabled).toBe(false);
    expect(result.missingSettings).toBe(false);
  });

  it("masterEnabled=trueのスタッフは、個別トグルの値がそのまま尊重される", () => {
    const result = foldStaffSettings({
      hmailSalonId: "staff-on",
      masterEnabled: true,
      newReservationEnabled: true,
      cancellationEnabled: false, // キャンセル通知だけ個別にOFF
    });
    expect(result.newReservationEnabled).toBe(true);
    expect(result.cancellationEnabled).toBe(false);
    expect(result.missingSettings).toBe(false);
  });

  it("hmail側に設定行自体が無い場合は、無条件でONへ補完せずfalseに倒し、missingSettingsを立てる", () => {
    const result = foldStaffSettings({
      hmailSalonId: "staff-missing",
      masterEnabled: null,
      newReservationEnabled: null,
      cancellationEnabled: null,
    });
    expect(result.newReservationEnabled).toBe(false);
    expect(result.cancellationEnabled).toBe(false);
    expect(result.missingSettings).toBe(true);
  });

  it("【旧実装のOR統合バグの再現】3人中1人だけmasterEnabled=falseでも、他の2人がtrueなら旧実装は店舗全体をONにしていた", () => {
    const staffList = [
      { hmailSalonId: "a", masterEnabled: true, newReservationEnabled: true, cancellationEnabled: true },
      { hmailSalonId: "b", masterEnabled: true, newReservationEnabled: true, cancellationEnabled: true },
      { hmailSalonId: "c", masterEnabled: false, newReservationEnabled: true, cancellationEnabled: true }, // 個人でOFFにした人
    ];

    // 旧実装の店舗単位OR統合(参考として再現): いずれか1つでもtrueならtrue。
    const oldStyleSalonLevelOr = staffList.some((s) => s.masterEnabled === true);
    expect(oldStyleSalonLevelOr).toBe(true); // 旧実装ならnotification_settings.master_enabledがtrueになる。

    // 旧実装では、店舗単位がtrueになった後もcさんのline_connections行自体は
    // 「新規予約=true・キャンセル=true」のまま(個人のmaster_enabledを一切見ない)で
    // 移行されていたため、OFFにしていたはずのcさんに通知が届いてしまっていた。
    const folded = foldAllStaffSettings(staffList);
    const c = folded.find((f) => f.hmailSalonId === "c")!;
    expect(c.newReservationEnabled).toBe(false); // 修正後: cさんは引き続き通知を受け取らない。
    expect(c.cancellationEnabled).toBe(false);

    // a・bさんは影響を受けない。
    expect(folded.find((f) => f.hmailSalonId === "a")!.newReservationEnabled).toBe(true);
    expect(folded.find((f) => f.hmailSalonId === "b")!.newReservationEnabled).toBe(true);
  });
});
