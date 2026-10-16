import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// 口コミ 第2段階の定期処理の入口: 専用の秘密の値で確かめる。dryRun は件数だけ。応答に口コミの内容・店舗を出さない。

const runReviewTick = vi.fn(async () => ({
  purged: { deliveries: 0 },
  entitlementStops: 0,
  autoSync: null,
  evaluate: null,
  deliver: null,
  errors: [],
}));
const dueLocations = vi.fn(async () => [{ salonId: "s1" }]);
const pendingEvents = vi.fn(async () => [{ id: "e1" }, { id: "e2" }]);
vi.mock("@/lib/reviews/alerts/tick", () => ({ runReviewTick }));
vi.mock("@/lib/reviews/alerts/runtime", () => ({
  getReviewTickDeps: () => ({}),
  getReviewAlertStore: () => ({ dueLocations, pendingEvents }),
}));

const { POST } = await import("@/app/api/cron/reviews/tick/route");
const SECRET = "test-reviews-cron-secret-000000000000000";

function call(authorization?: string, query = "") {
  return POST(new NextRequest(`http://localhost/api/cron/reviews/tick${query}`, { method: "POST", headers: authorization ? { authorization } : {} }));
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("POST /api/cron/reviews/tick", () => {
  it("秘密の値が未設定・短い・違う・無いなら何もしない(401)", async () => {
    vi.stubEnv("REVIEWS_CRON_SECRET", "");
    expect((await call(`Bearer ${SECRET}`)).status).toBe(401);
    vi.stubEnv("REVIEWS_CRON_SECRET", "short");
    expect((await call("Bearer short")).status).toBe(401);
    vi.stubEnv("REVIEWS_CRON_SECRET", SECRET);
    expect((await call()).status).toBe(401);
    expect((await call(`Bearer ${SECRET}x`)).status).toBe(401);
    expect(runReviewTick).not.toHaveBeenCalled();
  });

  it("dryRun は対象の件数だけを返す(処理しない)", async () => {
    vi.stubEnv("REVIEWS_CRON_SECRET", SECRET);
    const res = await call(`Bearer ${SECRET}`, "?dryRun=1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      dryRun: true,
      dueLocations: 1,
      pendingEvents: 2,
      flags: { autoSync: false, alerts: false },
      lineSendMode: "simulated",
    });
    expect(runReviewTick).not.toHaveBeenCalled();
  });

  it("定期処理を1回行い、件数とフラグ・LINE の送信の扱いを返す", async () => {
    vi.stubEnv("REVIEWS_CRON_SECRET", SECRET);
    vi.stubEnv("GBP_AUTO_SYNC_ENABLED", "1");
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flags).toEqual({ autoSync: true, alerts: false });
    expect(body.lineSendMode).toBe("simulated");
    expect(runReviewTick).toHaveBeenCalledTimes(1);
  });

  it("失敗したら 500(内容は返さない)", async () => {
    vi.stubEnv("REVIEWS_CRON_SECRET", SECRET);
    runReviewTick.mockRejectedValueOnce(new Error("db down"));
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "tick_failed" });
  });
});
