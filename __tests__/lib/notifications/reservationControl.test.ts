import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SetupContext } from "@/lib/features/featureState";
import { resumeReservation, startReservation, STATE_CHANGED_ERROR, type ReservationControlDeps } from "@/lib/notifications/reservationControl";

// お客様による予約通知の開始・再開。DB の操作は差し替え、呼ぶ順番と、呼ばないことを確かめる
// (DB 側の条件・同時の操作は scripts/testdb/features-onboarding.test.ts で確かめる)。

const gmailOk = { bound: true, authState: "active" as const, scopeGranted: true, email: "owner@example.test" };
const activeOps = { state: "active" as const, legacy: false, activatedAt: "2026-10-09T02:50:00Z", lastMailCheckAt: "2026-10-09T02:58:00Z" };
const switchOff = { selected: false, updatedAt: "2026-10-02T00:00:00.123456+00:00" };
const switchOn = { selected: true, updatedAt: "2026-10-01T00:00:00.123456+00:00" };

function ctx(overrides: Partial<SetupContext> = {}): SetupContext {
  return {
    plan: "salonpack",
    reservationSwitch: null,
    hasActiveSurvey: true,
    onboardingCompleted: true,
    googleReviewUrl: null,
    hasBlogSettings: false,
    lineRecipientCount: 1,
    gmail: gmailOk,
    gbp: { bound: false, authState: null, scopeGranted: false, email: null, selectionState: null },
    reservationOps: { state: "setup_pending", legacy: false },
    masterEnabled: true,
    lineInvitesAvailable: true,
    googleReviewsAvailable: false,
    now: new Date("2026-10-09T03:00:00Z"),
    ...overrides,
  };
}

function deps(context: SetupContext, opts: { switchWritten?: boolean; start?: Awaited<ReturnType<ReservationControlDeps["customerStart"]>> } = {}) {
  const calls: string[] = [];
  const d: ReservationControlDeps = {
    loadContext: vi.fn(async () => {
      calls.push("load");
      return context;
    }),
    turnOnSwitch: vi.fn(async () => {
      calls.push("switch");
      return opts.switchWritten ?? true;
    }),
    customerStart: vi.fn(async () => {
      calls.push("start");
      return opts.start ?? "started";
    }),
  };
  return { d, calls };
}

beforeEach(() => vi.stubEnv("NEXT_PUBLIC_APP_MODE", "salonpack"));
afterEach(() => vi.unstubAllEnvs());

describe("初回の開始", () => {
  it("開始待ちなら、読んだときの値でスイッチを ON にしてから customer_start を呼ぶ", async () => {
    const { d, calls } = deps(ctx({ reservationSwitch: switchOff }));
    expect(await startReservation(d)).toEqual({ ok: true });
    expect(calls).toEqual(["load", "switch", "start"]);
    expect(d.turnOnSwitch).toHaveBeenCalledWith(switchOff);
  });

  it("行が無い店舗も、行なしを前提に書く(誰かが同時に行を作っていたら書かない)", async () => {
    const { d } = deps(ctx({ reservationSwitch: null }));
    await startReservation(d);
    expect(d.turnOnSwitch).toHaveBeenCalledWith(null);
  });

  it("スイッチがすでに ON なら書かずに開始する(DB の customer_start がスイッチを確かめ直す)", async () => {
    const { d, calls } = deps(ctx({ reservationSwitch: switchOn }));
    expect(await startReservation(d)).toEqual({ ok: true });
    expect(calls).toEqual(["load", "start"]);
  });

  it("確かめたあとに別の操作でスイッチが変わっていたら、customer_start を呼ばずに止める", async () => {
    const { d, calls } = deps(ctx({ reservationSwitch: switchOff }), { switchWritten: false });
    expect(await startReservation(d)).toEqual({ ok: false, error: STATE_CHANGED_ERROR });
    expect(calls).toEqual(["load", "switch"]);
  });

  it.each([
    ["Google 未連携", { gmail: { bound: false, authState: null, scopeGranted: false, email: null } }],
    ["LINE の通知先なし", { lineRecipientCount: 0 }],
    ["稼働中", { reservationOps: activeOps }],
    ["運営による停止", { reservationOps: { ...activeOps, state: "paused" as const, pauseReason: "manual" } }],
    ["旧サービスの店舗(切り替え待ち)", { reservationOps: { state: "awaiting_cutover" as const, legacy: true } }],
    ["契約外", { plan: "reviews" as const }],
  ])("開始待ちでなければ(%s)、スイッチも customer_start も触らない", async (_label, overrides) => {
    const { d, calls } = deps(ctx(overrides));
    expect(await startReservation(d)).toEqual({ ok: false, error: STATE_CHANGED_ERROR });
    expect(calls).toEqual(["load"]);
  });

  it("customer_start が開始しなかった理由を、そのまま案内する(停止が間に入った場合は状態の変化として案内)", async () => {
    expect(await startReservation(deps(ctx(), { start: "no_line_recipients" }).d)).toEqual({ ok: false, error: "LINEの送信先が登録されていません。" });
    expect(await startReservation(deps(ctx(), { start: "not_selected" }).d)).toEqual({ ok: false, error: STATE_CHANGED_ERROR });
  });
});

describe("停止後の再開", () => {
  const stopped = { reservationOps: activeOps, reservationSwitch: switchOff };

  it("お客様が止めた状態なら、読んだときの値でスイッチを ON に戻すだけ(customer_start は呼ばない)", async () => {
    const { d, calls } = deps(ctx(stopped));
    expect(await resumeReservation(d)).toEqual({ ok: true });
    expect(calls).toEqual(["load", "switch"]);
    expect(d.turnOnSwitch).toHaveBeenCalledWith(switchOff);
    expect(d.customerStart).not.toHaveBeenCalled();
  });

  it("確かめたあとに別の操作でスイッチが変わっていたら、再開しない", async () => {
    expect(await resumeReservation(deps(ctx(stopped), { switchWritten: false }).d)).toEqual({ ok: false, error: STATE_CHANGED_ERROR });
  });

  it.each([
    ["運営による停止", { reservationOps: { ...activeOps, state: "paused" as const, pauseReason: "manual" } }],
    ["監視による停止(確認中)", { reservationOps: { ...activeOps, state: "paused" as const, pauseReason: "legacy_active" } }],
    ["再接続が必要", { gmail: { ...gmailOk, authState: "needs_reauth" as const } }],
    ["契約外", { plan: "reviews" as const }],
    ["止めていない(スイッチ ON)", { reservationSwitch: switchOn }],
    ["まだ開始していない", { reservationOps: { state: "setup_pending" as const, legacy: false } }],
  ])("お客様が止めた状態でなければ(%s)、スイッチを書かない", async (_label, overrides) => {
    const { d, calls } = deps(ctx({ ...stopped, ...overrides }));
    expect(await resumeReservation(d)).toEqual({ ok: false, error: STATE_CHANGED_ERROR });
    expect(calls).toEqual(["load"]);
  });
});
