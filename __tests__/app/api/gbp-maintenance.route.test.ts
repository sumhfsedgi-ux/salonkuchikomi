import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// 期限切れの内容の削除(計画 第2版 §3-9):利用可否・GOOGLE_REVIEWS_OAUTH_ENABLED に関係なく動く。呼び出しは専用の秘密の値で確かめる。

const purgeExpiredContent = vi.fn(async () => ({ deactivated_locations: 1, deleted_cache: 2, deleted_drafts: 0 }));
vi.mock("@/lib/gbp/runtime", () => ({ getGbpMaintenanceStore: () => ({ purgeExpiredContent }) }));

const { POST } = await import("@/app/api/jobs/gbp-maintenance/route");

const SECRET = "test-gbp-maintenance-secret-0000000000000";

function call(authorization?: string) {
  return POST(
    new NextRequest("http://localhost/api/jobs/gbp-maintenance", {
      method: "POST",
      headers: authorization ? { authorization } : {},
    }),
  );
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("POST /api/jobs/gbp-maintenance", () => {
  it("秘密の値が未設定なら、何もしない(401)", async () => {
    vi.stubEnv("GBP_MAINTENANCE_SECRET", "");
    expect((await call(`Bearer ${SECRET}`)).status).toBe(401);
    expect(purgeExpiredContent).not.toHaveBeenCalled();
  });

  it("秘密の値が違う・無いなら、何もしない(401)", async () => {
    vi.stubEnv("GBP_MAINTENANCE_SECRET", SECRET);
    expect((await call()).status).toBe(401);
    expect((await call(`Bearer ${SECRET}x`)).status).toBe(401);
    expect((await call(SECRET)).status).toBe(401);
    expect(purgeExpiredContent).not.toHaveBeenCalled();
  });

  it("届いた口コミが準備中・フラグが空でも、期限切れの内容を消す(件数だけを返す)", async () => {
    vi.stubEnv("GBP_MAINTENANCE_SECRET", SECRET);
    vi.stubEnv("GOOGLE_REVIEWS_OAUTH_ENABLED", "");
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ purged: { deactivated_locations: 1, deleted_cache: 2, deleted_drafts: 0 } });
    expect(purgeExpiredContent).toHaveBeenCalledTimes(1);
  });

  it("削除に失敗したら 500(内容は返さない)", async () => {
    vi.stubEnv("GBP_MAINTENANCE_SECRET", SECRET);
    purgeExpiredContent.mockRejectedValueOnce(new Error("db down"));
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "purge_failed" });
  });
});
