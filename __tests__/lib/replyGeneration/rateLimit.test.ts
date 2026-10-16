import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// AI返信(D1)のレート制限:上限を確かめられないときは「一時停止」(scope: unavailable)にする。
// お客様が使う口コミ生成のレート制限は、DB のエラーで通す今までの動きのまま(変えていないことを確かめる)。

const { checkReplyRateLimit } = await import("@/lib/replyGeneration/rateLimit");
const { checkGenerationRateLimit } = await import("@/lib/reviewGeneration/rateLimit");

type RpcResult = { data: unknown; error: { code: string } | null };

function fakeAdmin(results: Array<RpcResult | Error>) {
  const calls: string[] = [];
  const admin = {
    rpc: vi.fn(async (_name: string, args: { p_key: string }) => {
      calls.push(args.p_key);
      const next = results.shift();
      if (next instanceof Error) throw next;
      return next ?? { data: true, error: null };
    }),
  } as unknown as SupabaseClient;
  return { admin, calls };
}

const SALON = "salon-a";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AI返信のレート制限", () => {
  it("10分・1日の両方が上限内なら作れる", async () => {
    const { admin, calls } = fakeAdmin([{ data: true, error: null }, { data: true, error: null }]);
    expect(await checkReplyRateLimit(admin, SALON)).toEqual({ allowed: true });
    expect(calls).toEqual([`rp:salon10m:${SALON}`, `rp:salonday:${SALON}`]);
  });

  it("上限に当たったら、10分と1日を区別して止める", async () => {
    expect(await checkReplyRateLimit(fakeAdmin([{ data: false, error: null }]).admin, SALON)).toEqual({
      allowed: false,
      scope: "short",
    });
    expect(
      await checkReplyRateLimit(fakeAdmin([{ data: true, error: null }, { data: false, error: null }]).admin, SALON),
    ).toEqual({ allowed: false, scope: "daily" });
  });

  it.each([
    ["DB のエラー(0012 の適用前など)", [{ data: null, error: { code: "PGRST202" } }]],
    ["想定外の応答", [{ data: null, error: null }]],
    ["接続できない", [new Error("network")]],
    ["1日の確認だけ失敗", [{ data: true, error: null }, { data: null, error: { code: "57014" } }]],
  ] as const)("上限を確かめられないときは一時停止する:%s", async (_name, results) => {
    const { admin } = fakeAdmin([...results]);
    expect(await checkReplyRateLimit(admin, SALON)).toEqual({ allowed: false, scope: "unavailable" });
  });
});

describe("お客様の口コミ生成のレート制限(変えていない)", () => {
  it("DB のエラーのときは、今までどおり通す", async () => {
    const { admin } = fakeAdmin([{ data: null, error: { code: "PGRST202" } }, { data: null, error: { code: "PGRST202" } }]);
    expect(await checkGenerationRateLimit(admin, { salonId: SALON, ip: "203.0.113.1" })).toEqual({ allowed: true });
  });
});
