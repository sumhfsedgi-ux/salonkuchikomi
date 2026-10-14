import { entitlementsFor } from "../../helpers/entitlements";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFeatureStates, type SetupContext } from "@/lib/features/featureState";
import { FEATURE_REGISTRY } from "@/lib/features/registry";
import { isFeatureEnabledForPlan } from "@/lib/access/plan";

// 機能ごとの状態(契約・提供状況・設定の完了・外部接続・稼働状態)の判定。予約通知の配信処理とは別に検証する。
// お客様が機能を選ぶ仕組みは廃止したため、状態は選択に関係なく、全機能について出る。

function ctx(overrides: Partial<SetupContext> = {}): SetupContext {
  const plan = overrides.plan ?? "salonpack";
  return {
    plan,
    serviceActive: true,
    entitlements: entitlementsFor(plan),
    reservationSwitch: null,
    hasActiveSurvey: false,
    onboardingCompleted: false,
    googleReviewUrl: null,
    hasBlogSettings: false,
    lineRecipientCount: 0,
    gmail: { bound: false, authState: null, scopeGranted: false, email: null },
    gbp: { bound: false, authState: null, scopeGranted: false, email: null, selectionState: null },
    reservationOps: null,
    masterEnabled: true,
    lineInvitesAvailable: true,
    googleReviewsAvailable: false,
    ...overrides,
  };
}

const gmailOk = { bound: true, authState: "active" as const, scopeGranted: true, email: "owner@example.test" };
const of = (c: SetupContext, key: string) => resolveFeatureStates(c).states.find((s) => s.key === key)!;
const switchOn = { selected: true, updatedAt: "2026-10-01T00:00:00.000000+00:00" };
const switchOff = { selected: false, updatedAt: "2026-10-02T00:00:00.000000+00:00" };

beforeEach(() => vi.stubEnv("NEXT_PUBLIC_APP_MODE", "salonpack"));
afterEach(() => vi.unstubAllEnvs());

describe("全機能の状態を registry の順に出し、契約外・準備中も区別する", () => {
  it("口コミプラン: 口コミは利用でき、ブログ・予約通知は契約外、届いた口コミは準備中", () => {
    const { states } = resolveFeatureStates(ctx({ plan: "reviews" }));
    expect(states.map((s) => s.key)).toEqual(FEATURE_REGISTRY.map((f) => f.key));
    expect(states.map((s) => [s.key, s.access, s.status])).toEqual([
      ["reviews", "allowed", "setup_required"],
      ["blog", "not_allowed", "not_allowed"],
      ["reservation_notifications", "not_allowed", "not_allowed"],
      ["google_reviews", "coming_soon", "coming_soon"],
    ]);
    expect(of(ctx({ plan: "reviews" }), "blog")).toMatchObject({ statusLabel: "ご契約外", message: "ご契約のプランに含まれていません。" });
  });

  it("SalonPack: 口コミ・ブログ・予約通知は利用でき(設定の状況に応じた状態)、届いた口コミは準備中", () => {
    const { states } = resolveFeatureStates(ctx({ hasActiveSurvey: true, onboardingCompleted: true }));
    expect(states.map((s) => [s.key, s.access, s.status])).toEqual([
      ["reviews", "allowed", "ready"],
      ["blog", "allowed", "ready"],
      ["reservation_notifications", "allowed", "google_connect_required"],
      ["google_reviews", "coming_soon", "coming_soon"],
    ]);
  });

  it("契約外の機能は、提供前でも「準備中」ではなく「契約外」(判定は契約・APP_MODE が先)", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_MODE", "reviews");
    // reviews モードは予約通知を提供しない(契約が salonpack でも契約外の扱い)。
    expect(of(ctx(), "reservation_notifications").status).toBe("not_allowed");
  });

  it("SQL のトリガー(0022)が前提とする「予約通知は salonpack のみ」と PLAN_FEATURES が一致する", () => {
    expect(isFeatureEnabledForPlan("salonpack", "notifications")).toBe(true);
    expect(isFeatureEnabledForPlan("reviews", "notifications")).toBe(false);
  });
});

describe("予約通知の内部スイッチ: お客様が止めた状態だけを「停止中」として出す", () => {
  const ready = { gmail: gmailOk, lineRecipientCount: 2 };
  const active = { state: "active" as const, legacy: false, activatedAt: "2026-10-09T02:50:00Z", lastMailCheckAt: "2026-10-09T02:58:00Z" };
  const now = new Date("2026-10-09T03:00:00Z");

  it("開始済みでスイッチが OFF なら停止中(稼働中と出さない)", () => {
    const state = of(ctx({ ...ready, now, reservationOps: active, reservationSwitch: switchOff }), "reservation_notifications");
    expect(state).toMatchObject({ status: "stopped", statusLabel: "停止中" });
    expect(state.message).toContain("停止中に届いた予約は通知しません");
  });

  it("切り替え待ち(旧サービスの店舗)でスイッチが OFF でも停止中", () => {
    const state = of(ctx({ ...ready, reservationOps: { state: "awaiting_cutover", legacy: true }, reservationSwitch: switchOff }), "reservation_notifications");
    expect(state.status).toBe("stopped");
  });

  it("まだ開始していない店舗の OFF・行なしは停止中にせず、通常の設定の流れ(開始待ち)", () => {
    for (const reservationSwitch of [null, switchOff]) {
      for (const reservationOps of [null, { state: "setup_pending" as const, legacy: false }]) {
        expect(of(ctx({ ...ready, reservationOps, reservationSwitch }), "reservation_notifications").status).toBe("ready_to_start");
      }
    }
  });

  it("運営による停止・確認中・再接続が必要は、お客様の停止より優先して出す(再開ボタンを出さない)", () => {
    const paused = { ...active, state: "paused" as const };
    const at = (overrides: Partial<SetupContext>) => of(ctx({ ...ready, reservationSwitch: switchOff, ...overrides }), "reservation_notifications").status;
    expect(at({ reservationOps: { ...paused, pauseReason: "manual check" } })).toBe("paused");
    expect(at({ reservationOps: { ...paused, pauseReason: "legacy_active" } })).toBe("checking");
    expect(at({ gmail: { ...gmailOk, authState: "needs_reauth" }, reservationOps: active })).toBe("reconnect_required");
  });

  it("スイッチが ON なら、今まで通り稼働中・受信 OFF などを出す", () => {
    expect(of(ctx({ ...ready, now, reservationOps: active, reservationSwitch: switchOn }), "reservation_notifications").status).toBe("active");
    expect(of(ctx({ ...ready, now, reservationOps: active, reservationSwitch: switchOn, masterEnabled: false }), "reservation_notifications").status).toBe(
      "paused"
    );
  });
});

describe("予約通知: Google 接続だけでは通知を始めない(同意と稼働を混同させない)", () => {
  it("旧サービス利用店舗が必要な権限で再接続したら、お客様の操作は完了(内部の「切り替え待ち」は見せず、未完了の設定としても案内しない)", () => {
    const state = resolveFeatureStates(
      ctx({ gmail: gmailOk, lineRecipientCount: 3, reservationOps: { state: "awaiting_cutover", legacy: true } })
    ).states.find((s) => s.key === "reservation_notifications")!;
    expect(state.status).toBe("setup_complete");
    expect(state.statusLabel).toBe("設定完了");
    expect(state.message).toBe("Googleとの連携が完了しました。\nお客様の操作は以上です。LINEの再登録は不要です。");
    expect(`${state.statusLabel}${state.message}`).not.toMatch(/切り替え|旧側|照合|通知中|今までの通知/);
  });

  it("旧サービス利用店舗で Google 未連携: 連携をお願いするが、今までの通知が続くとは断定しない", () => {
    const state = resolveFeatureStates(
      ctx({ lineRecipientCount: 3, reservationOps: { state: "awaiting_cutover", legacy: true } })
    ).states.find((s) => s.key === "reservation_notifications")!;
    expect(state.status).toBe("google_connect_required");
    expect(state.message).toContain("LINEの再登録は不要です");
    expect(state.message).not.toMatch(/切り替え|今までの通知/);
  });

  it("新規店舗で通知先が無い: LINE ログインが有効なら追加を案内、未有効なら運営への問い合わせ(押せないボタンへ案内しない)", () => {
    const base = { gmail: gmailOk, lineRecipientCount: 0, reservationOps: { state: "setup_pending" as const, legacy: false } };
    const enabled = resolveFeatureStates(ctx(base)).states.find((s) => s.key === "reservation_notifications")!;
    expect(enabled.message).toContain("LINEの通知先を追加してください");
    expect(enabled.suggestSupport).toBe(false);
    const disabled = resolveFeatureStates(ctx({ ...base, lineInvitesAvailable: false })).states.find((s) => s.key === "reservation_notifications")!;
    expect(disabled.message).toContain("運営にお問い合わせください");
    expect(disabled.suggestSupport).toBe(true);
    expect(disabled.setupItems.find((i) => i.key === "line_recipients")!.description).toContain("運営にお問い合わせください");
  });

  it("停止が確定している状態(受信 OFF・運営の停止)と、動作を確認できない状態(監視・確認の途絶)を分ける", () => {
    const active = { gmail: gmailOk, lineRecipientCount: 2 };
    const now = new Date("2026-10-09T03:00:00Z");
    const ofOps = (overrides: Parameters<typeof ctx>[0]) => resolveFeatureStates(ctx({ ...active, now, ...overrides })).states.find((s) => s.key === "reservation_notifications")!;
    const fresh = { state: "active" as const, legacy: false, activatedAt: "2026-10-01T00:00:00Z", lastMailCheckAt: "2026-10-09T02:58:00Z" };

    expect(ofOps({ reservationOps: fresh }).status).toBe("active");
    expect(ofOps({ reservationOps: fresh, masterEnabled: false })).toMatchObject({ status: "paused", message: "予約通知を受け取る設定がOFFになっています。" });
    expect(ofOps({ reservationOps: { ...fresh, state: "paused", pauseReason: "manual check" } })).toMatchObject({ status: "paused", suggestSupport: true });
    const watchdog = ofOps({ reservationOps: { ...fresh, state: "paused", pauseReason: "legacy_active" } });
    expect(watchdog).toMatchObject({ status: "checking", suggestSupport: true });
    expect(watchdog.message).not.toMatch(/今までの通知|通知が続/);
    const stale = ofOps({ reservationOps: { ...fresh, lastMailCheckAt: "2026-10-09T02:30:00Z" } });
    expect(stale).toMatchObject({ status: "checking", suggestSupport: true });
    expect(stale.message).toContain("から予約メールの確認ができていません");
  });

  it("新規店舗は、接続と送信先がそろっても「開始待ち」(自動では始めない)", () => {
    const state = resolveFeatureStates(
      ctx({ gmail: gmailOk, lineRecipientCount: 1, reservationOps: { state: "setup_pending", legacy: false } })
    ).states.find((s) => s.key === "reservation_notifications")!;
    expect(state.status).toBe("ready_to_start");
    expect(state.message).toContain("まだ始まっていません");
  });

  it("認可が失効したら再接続が必要(稼働中・切り替え待ちの表示より優先)", () => {
    const state = resolveFeatureStates(
      ctx({ gmail: { ...gmailOk, authState: "needs_reauth" }, lineRecipientCount: 1, reservationOps: { state: "active", legacy: false } })
    ).states.find((s) => s.key === "reservation_notifications")!;
    expect(state.status).toBe("reconnect_required");
  });

  it("権限(scope)が無ければ接続済みとしない", () => {
    const state = resolveFeatureStates(
      ctx({ gmail: { ...gmailOk, scopeGranted: false }, lineRecipientCount: 1 })
    ).states.find((s) => s.key === "reservation_notifications")!;
    expect(state.status).toBe("reconnect_required");
  });
});

describe("届いた口コミ: 承認確認まで準備中、認証後も店舗の選択を省略しない", () => {
  it("提供前は準備中", () => {
    const state = resolveFeatureStates(ctx()).states.find((s) => s.key === "google_reviews")!;
    expect(state).toMatchObject({ access: "coming_soon", status: "coming_soon", statusLabel: "準備中" });
  });

  it("認証済みでも店舗の選択前は設定が必要", () => {
    const state = resolveFeatureStates(
      ctx({
        googleReviewsAvailable: true,
        gbp: { bound: true, authState: "active", scopeGranted: true, email: "a@example.test", selectionState: "selection_pending" },
      })
    ).states.find((s) => s.key === "google_reviews")!;
    expect(state.status).toBe("setup_required");
  });
});

describe("Gmail だけの権限不足は、同じアカウントの届いた口コミを巻き込まない", () => {
  it("予約通知は「権限を追加する」の案内、届いた口コミは利用中のまま", () => {
    const { states } = resolveFeatureStates(
      ctx({
        googleReviewsAvailable: true,
        lineRecipientCount: 1,
        reservationOps: { state: "active", legacy: false },
        gmail: { bound: true, authState: "active", scopeGranted: false, scopeMissing: true, email: "shop@example.test" },
        gbp: { bound: true, authState: "active", scopeGranted: true, email: "shop@example.test", selectionState: "selected" },
      })
    );
    const reservation = states.find((s) => s.key === "reservation_notifications")!;
    expect(reservation.status).toBe("reconnect_required");
    expect(reservation.message).toContain("Gmailの権限が足りません");
    expect(reservation.message).not.toContain("連携が切れています");
    expect(states.find((s) => s.key === "google_reviews")!.status).toBe("ready");
  });

  it("認可そのものが失効した(アカウント全体)場合は、両方とも再接続が必要", () => {
    const { states } = resolveFeatureStates(
      ctx({
        googleReviewsAvailable: true,
        reservationOps: { state: "active", legacy: false },
        gmail: { bound: true, authState: "needs_reauth", scopeGranted: true, email: "shop@example.test" },
        gbp: { bound: true, authState: "needs_reauth", scopeGranted: true, email: "shop@example.test", selectionState: "selected" },
      })
    );
    expect(states.find((s) => s.key === "reservation_notifications")!.message).toContain("連携が切れています");
    expect(states.find((s) => s.key === "google_reviews")!.status).toBe("reconnect_required");
  });
});
