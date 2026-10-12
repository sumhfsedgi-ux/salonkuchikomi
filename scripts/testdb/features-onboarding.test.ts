// 予約通知の内部スイッチ(salon_feature_selections の予約通知の行)と、お客様による開始・再開・停止の testdb テスト。
// 機能を選ぶ画面は廃止した。スイッチを書くのは「利用を停止する」「開始」「再開」の明示的な操作だけで、
// メール確認・送信をするかは DB が毎回、運用状態・契約・受信の ON/OFF・スイッチをそろって確かめて決める。
// 使う店舗は、このテストの中で作る架空の店舗だけ(既存の店舗の契約・スイッチは変えない)。Gmail・LINE には接続しない。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type postgres from "postgres";
import { closeConnections, openDirectConnections, setupNotificationsTestEnv } from "./setupNotificationsEnv";
import { createTestLineConnection, createTestSalon, notificationsTestAdminClient, setMasterEnabled, type TestSalonFixture } from "./notificationsFixtures";
import { activateNonLegacy, createTestGoogleAccount, deleteTestGoogleAccounts } from "./googleFixtures";

const target = setupNotificationsTestEnv();
const admin = notificationsTestAdminClient();
const { turnOffFeatureSwitch, turnOnReservationSwitch } = await import("@/lib/features/featureSwitch");
const { loadSetupContext } = await import("@/lib/features/setupContext");
const { resolveFeatureStates } = await import("@/lib/features/featureState");
const { startReservation, resumeReservation, STATE_CHANGED_ERROR } = await import("@/lib/notifications/reservationControl");
const { customerStartReservationNotifications, listPollableSalons } = await import("@/lib/notifications/db/operations");
const { claimDelivery, beginSend } = await import("@/lib/notifications/db/notificationDeliveries");
const { bindGoogleFeatures } = await import("@/lib/google/db/bindings");

const PLANS = ["salonpack"];
const salons: TestSalonFixture[] = [];
const accounts: string[] = [];
let conns: postgres.Sql[] = [];

beforeAll(async () => {
  conns = await openDirectConnections(target, 2);
});
afterAll(async () => {
  for (const s of salons) await s.cleanup();
  await deleteTestGoogleAccounts(accounts);
  await closeConnections(conns);
});

async function newSalon() {
  const salon = await createTestSalon();
  salons.push(salon);
  return salon;
}

/** 予約メールの Gmail を連携した状態にする(擬似の Google アカウント。Gmail には接続しない)。 */
async function bindGmail(salon: TestSalonFixture) {
  const accountId = await createTestGoogleAccount();
  accounts.push(accountId);
  await bindGoogleFeatures({
    salonId: salon.salonId,
    accountId,
    features: ["gmail"],
    accountEmail: "owner@example.test",
    userId: salon.userId,
    grantedScopes: ["openid", "https://www.googleapis.com/auth/gmail.readonly"],
  });
}

async function salonRow(salonId: string) {
  const { data } = await admin.from("salons").select("id, plan, onboarding_completed, google_review_url").eq("id", salonId).single();
  return { id: data!.id, plan: data!.plan, onboardingCompleted: data!.onboarding_completed, googleReviewUrl: data!.google_review_url };
}

async function selectionRows(salonId: string) {
  const { data } = await admin.from("salon_feature_selections").select("feature_key, selected, updated_at").eq("salon_id", salonId).order("feature_key");
  return data ?? [];
}

async function reservationSwitch(salonId: string) {
  const { data } = await admin
    .from("salon_feature_selections")
    .select("selected, updated_at")
    .eq("salon_id", salonId)
    .eq("feature_key", "reservation_notifications")
    .maybeSingle();
  return data ? { selected: data.selected as boolean, updatedAt: data.updated_at as string } : null;
}

async function opsState(salonId: string) {
  const { data } = await admin.from("reservation_notification_operations").select("state").eq("salon_id", salonId).maybeSingle();
  return (data?.state as string | undefined) ?? null;
}

async function intervals(salonId: string, kind: string) {
  const { data } = await admin.from("reservation_stop_intervals").select("started_at, ended_at").eq("salon_id", salonId).eq("kind", kind).order("started_at");
  return data ?? [];
}

async function isPollable(salonId: string) {
  return (await listPollableSalons(PLANS)).some((s) => s.salonId === salonId);
}

async function insertDelivery(salonId: string, lineConnectionId: string) {
  const { data: lc } = await admin.from("line_connections").select("destination_id").eq("id", lineConnectionId).single();
  const { error } = await admin.from("notification_deliveries").insert({
    salon_id: salonId,
    provider_message_id: `msg-${crypto.randomUUID()}`,
    line_connection_id: lineConnectionId,
    destination_id: lc!.destination_id,
    event_type: "new_reservation",
    line_text: "テスト本文",
    mail_received_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

function realDeps(salon: TestSalonFixture) {
  return {
    loadContext: async () => loadSetupContext(await salonRow(salon.salonId)),
    turnOnSwitch: (expected: Awaited<ReturnType<typeof reservationSwitch>>) =>
      turnOnReservationSwitch({ salonId: salon.salonId, userId: salon.userId, expected }),
    customerStart: () => customerStartReservationNotifications({ salonId: salon.salonId, userId: salon.userId, allowedPlans: PLANS }),
  };
}

async function reservationStatus(salon: TestSalonFixture) {
  const ctx = await loadSetupContext(await salonRow(salon.salonId));
  return resolveFeatureStates(ctx).states.find((s) => s.key === "reservation_notifications")!.status;
}

describe("画面の表示だけでは、スイッチ・運用状態・メール確認の対象は変わらない", () => {
  it("状態を読んで判定しても(ホーム・メニュー・予約通知の画面と同じ読み取り)、行を作らず、開始もしない", async () => {
    const salon = await newSalon();
    await bindGmail(salon);
    await createTestLineConnection(salon.salonId);
    expect(await reservationStatus(salon)).toBe("ready_to_start");
    expect(await selectionRows(salon.salonId)).toEqual([]);
    expect(await opsState(salon.salonId)).toBeNull();
    expect(await isPollable(salon.salonId)).toBe(false);
  });
});

describe("初回の開始", () => {
  it("予約通知の行だけを ON にしてから開始する(ほかの機能の行・保存日時・契約は変えない)", async () => {
    const salon = await newSalon();
    await bindGmail(salon);
    await createTestLineConnection(salon.salonId);
    // 機能を選んでいた頃の記録(ほかの機能の行・保存日時)が残っている店舗。
    await admin.from("salon_feature_selections").insert([
      { salon_id: salon.salonId, feature_key: "reviews", selected: true },
      { salon_id: salon.salonId, feature_key: "blog", selected: false },
    ]);
    const savedAt = "2026-10-01T00:00:00+00:00";
    await admin.from("salon_setup_state").insert({ salon_id: salon.salonId, feature_selection_saved_at: savedAt });
    const othersBefore = (await selectionRows(salon.salonId)).filter((r) => r.feature_key !== "reservation_notifications");
    const before = await salonRow(salon.salonId);

    expect(await startReservation(realDeps(salon))).toEqual({ ok: true });

    expect((await reservationSwitch(salon.salonId))?.selected).toBe(true);
    expect((await selectionRows(salon.salonId)).filter((r) => r.feature_key !== "reservation_notifications")).toEqual(othersBefore);
    const { data: setupState } = await admin.from("salon_setup_state").select("feature_selection_saved_at").eq("salon_id", salon.salonId).single();
    expect(new Date(setupState!.feature_selection_saved_at).toISOString()).toBe(new Date(savedAt).toISOString());
    expect(await salonRow(salon.salonId)).toEqual(before);
    expect(await opsState(salon.salonId)).toBe("active");
    expect(await isPollable(salon.salonId)).toBe(true);
  });

  it("スイッチが ON でも、開始していない店舗はメール確認・配信の対象にならない(開始に失敗した場合と同じ状態)", async () => {
    const salon = await newSalon();
    await bindGmail(salon);
    const line = await createTestLineConnection(salon.salonId);
    await admin.from("line_connections").update({ status: "not_connected" }).eq("id", line);
    // LINE の通知先が無いので DB の customer_start は開始しない(スイッチは ON のまま残る)。
    expect(await turnOnReservationSwitch({ salonId: salon.salonId, userId: salon.userId, expected: null })).toBe(true);
    expect(await customerStartReservationNotifications({ salonId: salon.salonId, userId: salon.userId, allowedPlans: PLANS })).toBe("no_line_recipients");
    expect((await reservationSwitch(salon.salonId))?.selected).toBe(true);
    expect(await opsState(salon.salonId)).toBe("setup_pending");
    expect(await isPollable(salon.salonId)).toBe(false);
    await admin.from("line_connections").update({ status: "connected" }).eq("id", line);
    await insertDelivery(salon.salonId, line);
    expect(await claimDelivery(salon.salonId, PLANS)).toBeNull();
    // 画面上の状態も「開始待ち」のまま(稼働中と出さない)。
    expect(await reservationStatus(salon)).toBe("ready_to_start");
  });
});

describe("停止(「予約通知の利用を停止する」)と再開", () => {
  async function activeSalon() {
    const salon = await newSalon();
    await bindGmail(salon);
    const line = await createTestLineConnection(salon.salonId);
    await activateNonLegacy(salon.salonId);
    return { salon, line };
  }

  it("停止するとメール確認の対象から外れ、確保済みの配信も送る直前で止まる。再開で停止期間が閉じ、対象に戻る", async () => {
    const { salon, line } = await activeSalon();
    expect(await isPollable(salon.salonId)).toBe(true);
    await insertDelivery(salon.salonId, line);
    const claimed = await claimDelivery(salon.salonId, PLANS);
    expect(claimed).not.toBeNull();

    await turnOffFeatureSwitch({ salonId: salon.salonId, userId: salon.userId, key: "reservation_notifications" });
    expect(await isPollable(salon.salonId)).toBe(false);
    expect(await beginSend(claimed!, PLANS)).toMatchObject({ decision: "released", reason: "feature_not_selected" });
    expect(await intervals(salon.salonId, "manual_feature_off")).toEqual([expect.objectContaining({ ended_at: null })]);
    expect(await reservationStatus(salon)).toBe("stopped");

    expect(await resumeReservation(realDeps(salon))).toEqual({ ok: true });
    expect((await intervals(salon.salonId, "manual_feature_off"))[0].ended_at).not.toBeNull();
    expect(await opsState(salon.salonId)).toBe("active");
    expect(await isPollable(salon.salonId)).toBe(true);
  });

  it("再開しても、受信 OFF・運営による停止・契約外は解除されない(メール確認の対象に入らない)", async () => {
    const { salon } = await activeSalon();
    await turnOffFeatureSwitch({ salonId: salon.salonId, userId: salon.userId, key: "reservation_notifications" });
    await setMasterEnabled(salon.salonId, false);
    expect(await resumeReservation(realDeps(salon))).toEqual({ ok: true });
    expect(await isPollable(salon.salonId)).toBe(false);
    const { data: master } = await admin.from("notification_settings").select("master_enabled").eq("salon_id", salon.salonId).single();
    expect(master!.master_enabled).toBe(false);
    expect(await intervals(salon.salonId, "manual_master_off")).toEqual([expect.objectContaining({ ended_at: null })]);

    // 運営による停止中は、再開の操作そのものを受け付けない(スイッチを書かない)。
    await setMasterEnabled(salon.salonId, true);
    await turnOffFeatureSwitch({ salonId: salon.salonId, userId: salon.userId, key: "reservation_notifications" });
    await admin.rpc("reservation_ops_pause", { p_salon_id: salon.salonId, p_by: "test", p_reason: "manual check", p_kind: "operator_pause" });
    const switchBefore = await reservationSwitch(salon.salonId);
    expect(await resumeReservation(realDeps(salon))).toEqual({ ok: false, error: STATE_CHANGED_ERROR });
    expect(await reservationSwitch(salon.salonId)).toEqual(switchBefore);
    expect(await opsState(salon.salonId)).toBe("paused");

    // 契約外(口コミプラン)になった店舗は、スイッチが ON でも対象にならない。
    const other = await activeSalon();
    await admin.from("salons").update({ plan: "reviews" }).eq("id", other.salon.salonId);
    expect(await isPollable(other.salon.salonId)).toBe(false);
  });
});

describe("同時の操作: 古い判定で、新しい停止を解除しない", () => {
  it("状態を読んだあとに停止が確定したら、開始・再開の書き込みは0件(停止のまま)", async () => {
    const salon = await newSalon();
    await activateNonLegacy(salon.salonId);
    await turnOffFeatureSwitch({ salonId: salon.salonId, userId: salon.userId, key: "reservation_notifications" });
    const seen = await reservationSwitch(salon.salonId);
    // 別の画面から、もう一度「利用を停止する」(値は同じ OFF でも、更新日時が変わる)。
    await new Promise((r) => setTimeout(r, 5));
    await turnOffFeatureSwitch({ salonId: salon.salonId, userId: salon.userId, key: "reservation_notifications" });
    expect(await turnOnReservationSwitch({ salonId: salon.salonId, userId: salon.userId, expected: seen })).toBe(false);
    expect((await reservationSwitch(salon.salonId))?.selected).toBe(false);
  });

  it("書き込みが先に確定したら、そのあとの停止で OFF になる(止める方向は常に通る)", async () => {
    const salon = await newSalon();
    await activateNonLegacy(salon.salonId);
    await turnOffFeatureSwitch({ salonId: salon.salonId, userId: salon.userId, key: "reservation_notifications" });
    expect(await turnOnReservationSwitch({ salonId: salon.salonId, userId: salon.userId, expected: await reservationSwitch(salon.salonId) })).toBe(true);
    await turnOffFeatureSwitch({ salonId: salon.salonId, userId: salon.userId, key: "reservation_notifications" });
    expect((await reservationSwitch(salon.salonId))?.selected).toBe(false);
  });

  it("停止の更新が確定する前に比べて書こうとしても、確定後に条件を確かめ直して0件になる(2本の接続で同時に)", async () => {
    const salon = await newSalon();
    await activateNonLegacy(salon.salonId);
    await turnOffFeatureSwitch({ salonId: salon.salonId, userId: salon.userId, key: "reservation_notifications" });
    const seen = (await reservationSwitch(salon.salonId))!;
    const [stopper, writer] = conns;
    let releaseStop!: () => void;
    const stopHeld = new Promise<void>((r) => (releaseStop = r));
    let stopLocked!: () => void;
    const locked = new Promise<void>((r) => (stopLocked = r));
    const stop = stopper.begin(async (tx) => {
      await tx`update public.salon_feature_selections set selected = false, updated_at = now()
                where salon_id = ${salon.salonId}::uuid and feature_key = 'reservation_notifications'`;
      stopLocked();
      await stopHeld;
    });
    await locked;
    // turnOnReservationSwitch と同じ条件の更新(読んだ値・更新日時のときだけ)。停止の行ロックで待たされる。
    const write = writer`update public.salon_feature_selections set selected = true, updated_at = now()
                          where salon_id = ${salon.salonId}::uuid and feature_key = 'reservation_notifications'
                            and selected = ${seen.selected} and updated_at = ${seen.updatedAt}::timestamptz
                          returning salon_id`.execute();
    await new Promise((r) => setTimeout(r, 300));
    releaseStop();
    await stop;
    expect(await write).toHaveLength(0);
    expect((await reservationSwitch(salon.salonId))?.selected).toBe(false);
  });

  it("開始の書き込みと customer_start の間に停止が入ったら、開始しない", async () => {
    const salon = await newSalon();
    await bindGmail(salon);
    await createTestLineConnection(salon.salonId);
    expect(await turnOnReservationSwitch({ salonId: salon.salonId, userId: salon.userId, expected: null })).toBe(true);
    await turnOffFeatureSwitch({ salonId: salon.salonId, userId: salon.userId, key: "reservation_notifications" });
    expect(await customerStartReservationNotifications({ salonId: salon.salonId, userId: salon.userId, allowedPlans: PLANS })).toBe("not_selected");
    expect(await opsState(salon.salonId)).toBe("setup_pending");
    expect(await isPollable(salon.salonId)).toBe(false);
  });

  it("行が無いと思って挿入しようとしても、先に行が作られていたら何もしない", async () => {
    const salon = await newSalon();
    await turnOffFeatureSwitch({ salonId: salon.salonId, userId: salon.userId, key: "reservation_notifications" });
    expect(await turnOnReservationSwitch({ salonId: salon.salonId, userId: salon.userId, expected: null })).toBe(false);
    expect((await reservationSwitch(salon.salonId))?.selected).toBe(false);
  });
});

describe("停止期間の記録(遅延通知のルールに使う)", () => {
  it("予約通知を止めた期間・全体スイッチを OFF にした期間・契約から外れた期間を、DB の時刻で記録する", async () => {
    const salon = await newSalon();
    await turnOnReservationSwitch({ salonId: salon.salonId, userId: salon.userId, expected: null });
    await turnOffFeatureSwitch({ salonId: salon.salonId, userId: salon.userId, key: "reservation_notifications" });
    expect(await intervals(salon.salonId, "manual_feature_off")).toEqual([expect.objectContaining({ ended_at: null })]);
    await turnOnReservationSwitch({ salonId: salon.salonId, userId: salon.userId, expected: await reservationSwitch(salon.salonId) });
    expect((await intervals(salon.salonId, "manual_feature_off"))[0].ended_at).not.toBeNull();

    await setMasterEnabled(salon.salonId, false);
    expect(await intervals(salon.salonId, "manual_master_off")).toEqual([expect.objectContaining({ ended_at: null })]);
    await setMasterEnabled(salon.salonId, true);
    expect((await intervals(salon.salonId, "manual_master_off"))[0].ended_at).not.toBeNull();

    await admin.from("salons").update({ plan: "reviews" }).eq("id", salon.salonId);
    expect(await intervals(salon.salonId, "contract")).toEqual([expect.objectContaining({ ended_at: null })]);
    await admin.from("salons").update({ plan: "salonpack" }).eq("id", salon.salonId);
    expect((await intervals(salon.salonId, "contract"))[0].ended_at).not.toBeNull();
    const { data: changes } = await admin.from("salon_plan_changes").select("old_plan, new_plan").eq("salon_id", salon.salonId).order("changed_at");
    expect(changes).toEqual([
      { old_plan: "salonpack", new_plan: "reviews" },
      { old_plan: "reviews", new_plan: "salonpack" },
    ]);
  });
});

describe("お客様による開始(旧サービスを使っていない店舗だけ)", () => {
  it("Google に接続しただけでは始まらない。条件がそろわないと開始できず、旧サービス利用店舗は画面から開始できない", async () => {
    const salon = await newSalon();
    const start = () => customerStartReservationNotifications({ salonId: salon.salonId, userId: salon.userId, allowedPlans: PLANS });
    expect(await start()).toBe("not_selected");
    await turnOnReservationSwitch({ salonId: salon.salonId, userId: salon.userId, expected: null });
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
