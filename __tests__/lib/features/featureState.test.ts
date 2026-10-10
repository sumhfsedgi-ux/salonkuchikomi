import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSetupChecklist, resolveFeatureStates, resolveSelection, type SetupContext } from "@/lib/features/featureState";
import { FEATURE_REGISTRY } from "@/lib/features/registry";
import { isFeatureEnabledForPlan } from "@/lib/access/plan";

// 初期設定(機能の選択・設定項目の案内)の判定。予約通知の配信処理とは別に検証する。

function ctx(overrides: Partial<SetupContext> = {}): SetupContext {
  return {
    plan: "salonpack",
    explicitSelections: {},
    selectionSavedAt: null,
    hasActiveSurvey: false,
    onboardingCompleted: false,
    googleReviewUrl: null,
    hasSalonSettingsRow: false,
    hasBlogSettings: false,
    lineRecipientCount: 0,
    hasAnyLineConnection: false,
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

beforeEach(() => vi.stubEnv("NEXT_PUBLIC_APP_MODE", "salonpack"));
afterEach(() => vi.unstubAllEnvs());

describe("機能の一覧は契約(plan)から作り、固定の3択にしない", () => {
  it("reviews プランでは予約通知・ブログは選択肢に出ない", () => {
    const { states } = resolveFeatureStates(ctx({ plan: "reviews" }));
    expect(states.map((s) => s.key)).toEqual(["reviews", "google_reviews"]);
  });

  it("salonpack プランでは登録されている全機能(準備中を含む)", () => {
    const { states } = resolveFeatureStates(ctx());
    expect(states.map((s) => s.key)).toEqual(FEATURE_REGISTRY.map((f) => f.key));
    expect(states.find((s) => s.key === "google_reviews")!.status).toBe("coming_soon");
  });

  it("SQL のトリガー(0022)が前提とする「予約通知は salonpack のみ」と PLAN_FEATURES が一致する", () => {
    expect(isFeatureEnabledForPlan("salonpack", "notifications")).toBe(true);
    expect(isFeatureEnabledForPlan("reviews", "notifications")).toBe(false);
  });
});

describe("選んだ機能の未設定項目だけを案内する", () => {
  it("ブログだけのお客様には、口コミのアンケートや Gmail 接続を求めない", () => {
    const { states } = resolveFeatureStates(ctx({ selectionSavedAt: "2026-10-08T00:00:00Z", explicitSelections: { blog: true } }));
    const checklist = buildSetupChecklist(states);
    expect(checklist.map((c) => c.key)).toEqual(["blog_settings"]);
  });

  it("予約通知だけのお客様に、口コミの設定を求めない", () => {
    const { states } = resolveFeatureStates(ctx({ selectionSavedAt: "x", explicitSelections: { reservation_notifications: true } }));
    const keys = buildSetupChecklist(states).map((c) => c.key);
    expect(keys).toEqual(["google", "line"]);
    expect(keys).not.toContain("review_survey");
  });

  it("後から機能を追加した場合、追加した機能の未設定項目だけ", () => {
    const base = { hasActiveSurvey: true, onboardingCompleted: true, googleReviewUrl: "https://g.page/r/x", selectionSavedAt: "x" };
    const before = buildSetupChecklist(resolveFeatureStates(ctx({ ...base, explicitSelections: { reviews: true } })).states);
    expect(before).toEqual([]);
    const after = buildSetupChecklist(
      resolveFeatureStates(ctx({ ...base, explicitSelections: { reviews: true, blog: true } })).states
    );
    expect(after.map((c) => c.key)).toEqual(["blog_settings"]);
  });

  it("設定済みの既存店舗(保存したことが無い)には、何も案内しない(やり直しを求めない)", () => {
    const { states, selectionSource } = resolveFeatureStates(
      ctx({ hasActiveSurvey: true, onboardingCompleted: true, googleReviewUrl: "https://g.page/r/x", hasSalonSettingsRow: true, hasBlogSettings: true })
    );
    expect(selectionSource).toBe("implicit");
    expect(buildSetupChecklist(states)).toEqual([]);
  });

  it("同じGoogleアカウントで使う複数機能の Google 連携は1件にまとめる", () => {
    const { states } = resolveFeatureStates(
      ctx({ googleReviewsAvailable: true, selectionSavedAt: "x", explicitSelections: { reservation_notifications: true, google_reviews: true } })
    );
    const google = buildSetupChecklist(states).filter((c) => c.key === "google");
    expect(google).toHaveLength(1);
    expect(google[0].features).toEqual(["予約通知", "届いた口コミ"]);
  });

  it("外部接続が未完了の機能があっても、準備済みの別機能は利用中", () => {
    const { states } = resolveFeatureStates(
      ctx({ hasActiveSurvey: true, onboardingCompleted: true, selectionSavedAt: "x", explicitSelections: { reviews: true, reservation_notifications: true } })
    );
    expect(states.find((s) => s.key === "reviews")!.status).toBe("ready");
    expect(states.find((s) => s.key === "reservation_notifications")!.status).toBe("google_connect_required");
  });
});

describe("選択の保存と推定", () => {
  it("すべて未選択で保存しても、選択画面(初期設定)へ戻されない", () => {
    expect(resolveSelection(ctx({ selectionSavedAt: "x", explicitSelections: { reviews: false, blog: false } })).source).toBe("explicit");
  });

  it("設定済みの機能を OFF にして保存したら、使っている形跡があっても推定で ON に戻らない", () => {
    const result = resolveSelection(
      ctx({ hasActiveSurvey: true, hasSalonSettingsRow: true, selectionSavedAt: "x", explicitSelections: { reviews: false, blog: true } })
    );
    expect([...result.selected]).toEqual(["blog"]);
  });

  it("保存後に登録された新しい機能は「未選択」(推定しない)", () => {
    const result = resolveSelection(ctx({ hasAnyLineConnection: true, selectionSavedAt: "x", explicitSelections: { reviews: true } }));
    expect(result.selected.has("reservation_notifications")).toBe(false);
  });

  it("保存したことが無く形跡も無い新規店舗は、選択画面を出す(選択肢が1つなら省略)", () => {
    expect(resolveSelection(ctx()).source).toBe("none");
    expect(resolveSelection(ctx({ plan: "reviews" })).source).toBe("single");
  });
});

describe("予約通知: Google 接続だけでは通知を始めない(同意と稼働を混同させない)", () => {
  const selected = { selectionSavedAt: "x", explicitSelections: { reservation_notifications: true } };

  it("旧サービス利用店舗が必要な権限で再接続したら、お客様の操作は完了(内部の「切り替え待ち」は見せず、未完了の設定としても案内しない)", () => {
    const state = resolveFeatureStates(
      ctx({ ...selected, gmail: gmailOk, lineRecipientCount: 3, reservationOps: { state: "awaiting_cutover", legacy: true } })
    ).states.find((s) => s.key === "reservation_notifications")!;
    expect(state.status).toBe("setup_complete");
    expect(state.statusLabel).toBe("設定完了");
    expect(state.message).toBe("Googleとの連携が完了しました。\nお客様の操作は以上です。LINEの再登録は不要です。");
    expect(`${state.statusLabel}${state.message}`).not.toMatch(/切り替え|旧側|照合|通知中|今までの通知/);
    expect(buildSetupChecklist([state])).toEqual([]);
  });

  it("旧サービス利用店舗で Google 未連携: 連携をお願いするが、今までの通知が続くとは断定しない", () => {
    const state = resolveFeatureStates(
      ctx({ ...selected, lineRecipientCount: 3, reservationOps: { state: "awaiting_cutover", legacy: true } })
    ).states.find((s) => s.key === "reservation_notifications")!;
    expect(state.status).toBe("google_connect_required");
    expect(state.message).toContain("LINEの再登録は不要です");
    expect(state.message).not.toMatch(/切り替え|今までの通知/);
  });

  it("新規店舗で通知先が無い: LINE ログインが有効なら追加を案内、未有効なら運営への問い合わせ(押せないボタンへ案内しない)", () => {
    const base = { ...selected, gmail: gmailOk, lineRecipientCount: 0, reservationOps: { state: "setup_pending" as const, legacy: false } };
    const enabled = resolveFeatureStates(ctx(base)).states.find((s) => s.key === "reservation_notifications")!;
    expect(enabled.message).toContain("LINEの通知先を追加してください");
    expect(enabled.suggestSupport).toBe(false);
    const disabled = resolveFeatureStates(ctx({ ...base, lineInvitesAvailable: false })).states.find((s) => s.key === "reservation_notifications")!;
    expect(disabled.message).toContain("運営にお問い合わせください");
    expect(disabled.suggestSupport).toBe(true);
    expect(disabled.setupItems.find((i) => i.key === "line_recipients")!.description).toContain("運営にお問い合わせください");
  });

  it("停止が確定している状態(お客様の OFF・運営の停止)と、動作を確認できない状態(監視・確認の途絶)を分ける", () => {
    const active = { ...selected, gmail: gmailOk, lineRecipientCount: 2 };
    const now = new Date("2026-10-09T03:00:00Z");
    const of = (overrides: Parameters<typeof ctx>[0]) => resolveFeatureStates(ctx({ ...active, now, ...overrides })).states.find((s) => s.key === "reservation_notifications")!;
    const fresh = { state: "active" as const, legacy: false, activatedAt: "2026-10-01T00:00:00Z", lastMailCheckAt: "2026-10-09T02:58:00Z" };

    expect(of({ reservationOps: fresh }).status).toBe("active");
    expect(of({ reservationOps: fresh, masterEnabled: false })).toMatchObject({ status: "paused", message: "予約通知を受け取る設定がOFFになっています。" });
    expect(of({ reservationOps: { ...fresh, state: "paused", pauseReason: "manual check" } })).toMatchObject({ status: "paused", suggestSupport: true });
    const watchdog = of({ reservationOps: { ...fresh, state: "paused", pauseReason: "legacy_active" } });
    expect(watchdog).toMatchObject({ status: "checking", suggestSupport: true });
    expect(watchdog.message).not.toMatch(/今までの通知|通知が続/);
    const stale = of({ reservationOps: { ...fresh, lastMailCheckAt: "2026-10-09T02:30:00Z" } });
    expect(stale).toMatchObject({ status: "checking", suggestSupport: true });
    expect(stale.message).toContain("から予約メールの確認ができていません");
  });

  it("新規店舗は、接続と送信先がそろっても「開始待ち」(自動では始めない)", () => {
    const state = resolveFeatureStates(
      ctx({ ...selected, gmail: gmailOk, lineRecipientCount: 1, reservationOps: { state: "setup_pending", legacy: false } })
    ).states.find((s) => s.key === "reservation_notifications")!;
    expect(state.status).toBe("ready_to_start");
    expect(state.message).toContain("まだ始まっていません");
  });

  it("認可が失効したら再接続が必要(稼働中・切り替え待ちの表示より優先)", () => {
    const state = resolveFeatureStates(
      ctx({ ...selected, gmail: { ...gmailOk, authState: "needs_reauth" }, lineRecipientCount: 1, reservationOps: { state: "active", legacy: false } })
    ).states.find((s) => s.key === "reservation_notifications")!;
    expect(state.status).toBe("reconnect_required");
  });

  it("権限(scope)が無ければ接続済みとしない", () => {
    const state = resolveFeatureStates(
      ctx({ ...selected, gmail: { ...gmailOk, scopeGranted: false }, lineRecipientCount: 1 })
    ).states.find((s) => s.key === "reservation_notifications")!;
    expect(state.status).toBe("reconnect_required");
  });
});

describe("届いた口コミ: 承認確認まで準備中、認証後も店舗の選択を省略しない", () => {
  it("提供前は準備中", () => {
    const state = resolveFeatureStates(ctx({ selectionSavedAt: "x", explicitSelections: { google_reviews: true } })).states.find(
      (s) => s.key === "google_reviews"
    )!;
    expect(state.status).toBe("coming_soon");
    expect(state.selected).toBe(false);
  });

  it("認証済みでも店舗の選択前は設定が必要", () => {
    const state = resolveFeatureStates(
      ctx({
        googleReviewsAvailable: true,
        selectionSavedAt: "x",
        explicitSelections: { google_reviews: true },
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
        selectionSavedAt: "x",
        explicitSelections: { reservation_notifications: true, google_reviews: true },
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
        selectionSavedAt: "x",
        explicitSelections: { reservation_notifications: true, google_reviews: true },
        reservationOps: { state: "active", legacy: false },
        gmail: { bound: true, authState: "needs_reauth", scopeGranted: true, email: "shop@example.test" },
        gbp: { bound: true, authState: "needs_reauth", scopeGranted: true, email: "shop@example.test", selectionState: "selected" },
      })
    );
    expect(states.find((s) => s.key === "reservation_notifications")!.message).toContain("連携が切れています");
    expect(states.find((s) => s.key === "google_reviews")!.status).toBe("reconnect_required");
  });
});
