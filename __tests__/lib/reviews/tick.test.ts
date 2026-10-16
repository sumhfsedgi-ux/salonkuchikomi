import { describe, expect, it, vi } from "vitest";
import { runReviewTick, type ReviewTickDeps } from "@/lib/reviews/alerts/tick";
import { createDeadline } from "@/lib/notifications/jobs/runBudget";

function deps(overrides: Partial<ReviewTickDeps> = {}) {
  const store = {
    purge: vi.fn(async () => ({ deliveries: 1 })),
    purgePush: vi.fn(async () => 2),
    sweepEntitlement: vi.fn(async () => 0),
    dueLocations: vi.fn(async () => []),
    beginAutoSync: vi.fn(),
    finishAutoSync: vi.fn(),
    recordAuth: vi.fn(),
    recordRun: vi.fn(async () => {}),
    pendingEvents: vi.fn(async () => []),
    evaluate: vi.fn(),
    claim: vi.fn(async () => null),
    beginSend: vi.fn(),
    finish: vi.fn(),
    releaseClaim: vi.fn(),
    cancelSendStart: vi.fn(),
  };
  const send = vi.fn();
  const d: ReviewTickDeps = {
    store: store as unknown as ReviewTickDeps["store"],
    inbox: { syncForSchedule: vi.fn() },
    flags: { autoSync: false, alerts: false },
    baseUrl: "https://salonpack.example.test",
    consentVersion: "v",
    send,
    deadline: createDeadline(45_000),
    ...overrides,
  };
  return { d, store, send };
}

describe("口コミの定期処理", () => {
  it("フラグがすべて空でも、期限切れの記録の削除と利用許可の確認だけは行う(取得・評価・配信はしない)", async () => {
    const { d, store } = deps();
    const s = await runReviewTick(d);
    expect(store.purge).toHaveBeenCalledTimes(1);
    expect(store.sweepEntitlement).toHaveBeenCalledTimes(1);
    expect(store.dueLocations).not.toHaveBeenCalled();
    expect(store.pendingEvents).not.toHaveBeenCalled();
    expect(store.claim).not.toHaveBeenCalled();
    expect(s.purged).toEqual({ deliveries: 1, pushMessages: 2 });
    expect(store.purgePush).toHaveBeenCalledTimes(1);
    expect(store.recordRun).toHaveBeenCalledTimes(1);
  });

  it("フラグに合わせて、自動取得・評価・配信を行う", async () => {
    const { d, store } = deps({ flags: { autoSync: true, alerts: true } });
    await runReviewTick(d);
    expect(store.dueLocations).toHaveBeenCalledWith("v", 50);
    expect(store.pendingEvents).toHaveBeenCalled();
    expect(store.claim).toHaveBeenCalled();
  });

  it("Google口コミの処理が作れない(inbox が無い)なら自動取得はしない。URL が無ければ評価しないが、配信はする", async () => {
    const { d, store } = deps({ flags: { autoSync: true, alerts: true }, inbox: null, baseUrl: null });
    const s = await runReviewTick(d);
    expect(store.dueLocations).not.toHaveBeenCalled();
    expect(store.pendingEvents).not.toHaveBeenCalled();
    expect(store.claim).toHaveBeenCalled();
    expect(s.errors).toContain("base_url_missing");
  });

  it("ある段が失敗しても、ほかの段は続ける", async () => {
    const { d, store } = deps({ flags: { autoSync: true, alerts: true } });
    store.purge.mockRejectedValueOnce(new Error("db"));
    store.dueLocations.mockRejectedValueOnce(new Error("db"));
    const s = await runReviewTick(d);
    expect(s.errors).toEqual(["purge", "auto_sync"]);
    expect(store.sweepEntitlement).toHaveBeenCalled();
    expect(store.claim).toHaveBeenCalled();
  });
});
