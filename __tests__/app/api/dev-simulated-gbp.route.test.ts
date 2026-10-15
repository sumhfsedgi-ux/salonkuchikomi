import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getDevSimulatedGbp, resetDevSimulatedGbp } from "@/lib/gbp/simulated";
import { simulatedGbpDevUsers } from "@/lib/gbp/dev/simulatedFixtures";
import { GbpApiError } from "@/lib/gbp/apiClient";

// 画面確認用の架空の Google の操作の口(app/api/dev/simulated-gbp)。架空モード(テスト用DBの検証・本番ビルドでない)
// のときだけ使え、それ以外は 404。プロセスの中の架空の Google の状態だけを変える。

const { GET, POST } = await import("@/app/api/dev/simulated-gbp/route");

function post(body: unknown) {
  return POST(new NextRequest("http://localhost/api/dev/simulated-gbp", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
}

function enableSimulated() {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("SALONPACK_VERIFY_MODE", "testdb");
  vi.stubEnv("GOOGLE_OAUTH_SIMULATED", "1");
}

beforeEach(() => {
  vi.unstubAllEnvs();
  resetDevSimulatedGbp();
});
afterEach(() => vi.unstubAllEnvs());

describe("dev/simulated-gbp", () => {
  it("架空モードでなければ 404(本番ビルドでは、ほかの値がそろっていても 404)", async () => {
    expect((await post({ action: "reset" })).status).toBe(404);
    expect((await GET(new NextRequest("http://localhost/api/dev/simulated-gbp"))).status).toBe(404);
    enableSimulated();
    vi.stubEnv("NODE_ENV", "production");
    expect((await post({ action: "reset" })).status).toBe(404);
  });

  it("次の1回の失敗を仕込み、架空の Google の口コミの API がその失敗を返す", async () => {
    enableSimulated();
    expect((await post({ action: "fail_next", operation: "reviews", kind: "timeout" })).status).toBe(200);
    const sim = getDevSimulatedGbp(() => simulatedGbpDevUsers());
    await expect(sim.api.listReviews("simgbp:100000000000000000001:x", "accounts/sim-1", "locations/sim-101", null)).rejects.toBeInstanceOf(GbpApiError);
    // 次の呼び出しは通常どおり
    const page = await sim.api.listReviews("simgbp:100000000000000000001:x", "accounts/sim-1", "locations/sim-101", null);
    expect(page.reviews.length).toBeGreaterThan(0);
  });

  it("返信の書き込みを時間切れにして、あとから反映できる(遅れて反映される場合の確認)", async () => {
    enableSimulated();
    const token = "simgbp:100000000000000000001:x";
    const name = "accounts/sim-1/locations/sim-101/reviews/sim-r1";
    expect((await post({ action: "defer_next_write", operation: "reply" })).status).toBe(200);
    const sim = getDevSimulatedGbp(() => simulatedGbpDevUsers());
    await expect(sim.api.updateReply(token, name, "遅れて届く返信")).rejects.toMatchObject({ kind: "timeout" });
    expect(sim.replyOf(name)).toBeNull();
    const applied = await post({ action: "apply_deferred_writes" });
    expect(await applied.json()).toEqual({ ok: true, applied: 1 });
    expect(sim.replyOf(name)?.comment).toBe("遅れて届く返信");
  });

  it("口コミを足すと、その店舗のアカウントの名前で作る。知らない値・形の違う値は受け付けない", async () => {
    enableSimulated();
    const res = await post({ action: "add_review", locationName: "locations/sim-201", starRating: "FIVE", comment: "(架空)追加" });
    const body = await res.json();
    expect(body.reviewName).toMatch(/^accounts\/sim-2\/locations\/sim-201\/reviews\/sim-add-/);
    expect((await post({ action: "add_review", locationName: "locations/unknown", starRating: "FIVE", comment: "x" })).status).toBe(400);
    expect((await post({ action: "fail_next", operation: "reviews", kind: "drop_table" })).status).toBe(400);
    expect((await post({ action: "delay_next", operation: "reviews", ms: 3_600_000 })).status).toBe(400);
  });

  it("画面確認用のアカウント(口コミ0件の店・口コミが多い店)は、開発サーバーの架空の Google にだけ入る", () => {
    const owner = simulatedGbpDevUsers().find((u) => u.sub === "100000000000000000001")!;
    expect(owner.accounts.map((a) => a.name)).toEqual(["accounts/sim-1", "accounts/sim-2"]);
    const [zero, many] = owner.accounts[1].locations;
    expect([zero.reviews.length, zero.totalReviewCount, zero.averageRating]).toEqual([0, 0, null]);
    expect(many.reviews.length).toBe(120);
  });
});
