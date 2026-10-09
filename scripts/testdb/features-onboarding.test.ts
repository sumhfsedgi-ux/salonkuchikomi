// 初期設定(機能の選択)と停止期間の記録の testdb テスト。予約通知の配信処理とは別に検証する。
import { afterAll, describe, expect, it } from "vitest";
import { setupNotificationsTestEnv } from "./setupNotificationsEnv";
import { createTestSalon, notificationsTestAdminClient, setMasterEnabled, type TestSalonFixture } from "./notificationsFixtures";

setupNotificationsTestEnv();
const admin = notificationsTestAdminClient();
const { saveFeatureSelection } = await import("@/lib/features/selection");
const { loadSetupContext } = await import("@/lib/features/setupContext");
const { resolveFeatureStates, resolveSelection } = await import("@/lib/features/featureState");
const { FEATURE_REGISTRY } = await import("@/lib/features/registry");

const salons: TestSalonFixture[] = [];
afterAll(async () => {
  for (const s of salons) await s.cleanup();
});

async function salonRow(salonId: string) {
  const { data } = await admin.from("salons").select("id, plan, onboarding_completed, google_review_url").eq("id", salonId).single();
  return { id: data!.id, plan: data!.plan, onboardingCompleted: data!.onboarding_completed, googleReviewUrl: data!.google_review_url };
}

async function openIntervals(salonId: string, kind: string) {
  const { data } = await admin.from("reservation_stop_intervals").select("started_at, ended_at").eq("salon_id", salonId).eq("kind", kind);
  return data ?? [];
}

describe("機能の選択の保存", () => {
  it("登録されている全機能の行を書き、保存日時を記録する。以後は推定しない", async () => {
    const salon = await createTestSalon();
    salons.push(salon);
    await saveFeatureSelection({ salonId: salon.salonId, userId: salon.userId, selected: ["blog"] });
    const { data } = await admin.from("salon_feature_selections").select("feature_key, selected").eq("salon_id", salon.salonId);
    expect(data!.map((r) => r.feature_key).sort()).toEqual(FEATURE_REGISTRY.map((f) => f.key).sort());
    // 使っている形跡(LINE の送信先)があっても、保存した選択(予約通知 OFF)を推定で ON にしない。
    await admin.from("line_connections").insert({ salon_id: salon.salonId, destination_id: "U_test_x", status: "connected" });
    const ctx = await loadSetupContext(await salonRow(salon.salonId));
    expect([...resolveSelection(ctx).selected]).toEqual(["blog"]);
  });

  it("すべて未選択で保存しても、選択画面(初期設定)へ戻されない", async () => {
    const salon = await createTestSalon();
    salons.push(salon);
    await saveFeatureSelection({ salonId: salon.salonId, userId: salon.userId, selected: [] });
    const ctx = await loadSetupContext(await salonRow(salon.salonId));
    const { selectionSource, states } = resolveFeatureStates(ctx);
    expect(selectionSource).toBe("explicit");
    expect(states.every((s) => !s.selected)).toBe(true);
  });

  it("機能の選択を変えても、契約(plan)・データ・Google 連携は変わらない", async () => {
    const salon = await createTestSalon();
    salons.push(salon);
    const before = await salonRow(salon.salonId);
    await saveFeatureSelection({ salonId: salon.salonId, userId: salon.userId, selected: ["reservation_notifications"] });
    await saveFeatureSelection({ salonId: salon.salonId, userId: salon.userId, selected: [] });
    expect(await salonRow(salon.salonId)).toEqual(before);
    // 予約通知を選んだときに作った運用状態の行は、開始前のまま(開始はされない)。
    const { data: ops } = await admin.from("reservation_notification_operations").select("state, activated_at").eq("salon_id", salon.salonId).single();
    expect(ops).toEqual({ state: "setup_pending", activated_at: null });
  });
});

describe("停止期間の記録(遅延通知のルールに使う)", () => {
  it("予約通知を OFF にした期間・全体スイッチを OFF にした期間・契約から外れた期間を、DB の時刻で記録する", async () => {
    const salon = await createTestSalon();
    salons.push(salon);
    await saveFeatureSelection({ salonId: salon.salonId, userId: salon.userId, selected: ["reservation_notifications"] });
    await saveFeatureSelection({ salonId: salon.salonId, userId: salon.userId, selected: [] });
    expect(await openIntervals(salon.salonId, "manual_feature_off")).toEqual([expect.objectContaining({ ended_at: null })]);
    await saveFeatureSelection({ salonId: salon.salonId, userId: salon.userId, selected: ["reservation_notifications"] });
    expect((await openIntervals(salon.salonId, "manual_feature_off"))[0].ended_at).not.toBeNull();

    await setMasterEnabled(salon.salonId, false);
    expect(await openIntervals(salon.salonId, "manual_master_off")).toEqual([expect.objectContaining({ ended_at: null })]);
    await setMasterEnabled(salon.salonId, true);
    expect((await openIntervals(salon.salonId, "manual_master_off"))[0].ended_at).not.toBeNull();

    await admin.from("salons").update({ plan: "reviews" }).eq("id", salon.salonId);
    expect(await openIntervals(salon.salonId, "contract")).toEqual([expect.objectContaining({ ended_at: null })]);
    await admin.from("salons").update({ plan: "salonpack" }).eq("id", salon.salonId);
    expect((await openIntervals(salon.salonId, "contract"))[0].ended_at).not.toBeNull();
    const { data: changes } = await admin.from("salon_plan_changes").select("old_plan, new_plan").eq("salon_id", salon.salonId).order("changed_at");
    expect(changes).toEqual([
      { old_plan: "salonpack", new_plan: "reviews" },
      { old_plan: "reviews", new_plan: "salonpack" },
    ]);
  });
});

describe("お客様による開始(旧サービスを使っていない店舗だけ)", () => {
  it("Google に接続しただけでは始まらない。条件がそろわないと開始できず、旧サービス利用店舗は画面から開始できない", async () => {
    const salon = await createTestSalon();
    salons.push(salon);
    const { customerStartReservationNotifications } = await import("@/lib/notifications/db/operations");
    const start = () => customerStartReservationNotifications({ salonId: salon.salonId, userId: salon.userId, allowedPlans: ["salonpack"] });
    expect(await start()).toBe("not_selected");
    await saveFeatureSelection({ salonId: salon.salonId, userId: salon.userId, selected: ["reservation_notifications"] });
    expect(await start()).toBe("gmail_not_connected");

    // 旧サービスから移行したスタッフがいる店舗は、画面から開始できない(運営の切り替え手順が必要)。
    await admin.from("line_connections").insert({ salon_id: salon.salonId, destination_id: "U_legacy_staff", status: "connected", migrated_from_hmail_salon_id: "legacy-1" });
    expect(await start()).toBe("legacy_salon");
    // DB のトリガーも、旧サービス利用の印が無いまま稼働中にすることを拒否する。
    const { error } = await admin
      .from("reservation_notification_operations")
      .update({ state: "active", mail_fetch_since: new Date().toISOString(), activated_at: new Date().toISOString() })
      .eq("salon_id", salon.salonId);
    expect(error?.message).toContain("reservation_ops:legacy_staff_without_legacy_marker");
  });
});
