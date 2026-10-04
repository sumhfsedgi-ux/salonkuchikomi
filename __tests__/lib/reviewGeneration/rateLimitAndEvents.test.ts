import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  checkEventRateLimit,
  checkGenerationRateLimit,
  clientIp,
  generationRateLimits,
  hashIp,
} from "@/lib/reviewGeneration/rateLimit";
import { generationExists, recordGenerationEvent } from "@/lib/reviewGeneration/events";

const SALON_ID = "11111111-1111-4111-8111-111111111111";
const GENERATION_ID = "66666666-6666-4666-8666-666666666666";

/** rpc と from(...).upsert / select をそれぞれ記録する偽の service role クライアント。 */
function fakeAdmin(options: { rpc?: Array<{ data: unknown; error?: { code: string } | null }>; upsertError?: unknown; selectData?: unknown } = {}) {
  const rpcCalls: Array<[string, Record<string, unknown>]> = [];
  const upserts: Array<[unknown, unknown]> = [];
  const filters: Array<[string, unknown]> = [];
  const rpcResults = [...(options.rpc ?? [])];
  const builder = {
    upsert: async (row: unknown, opts: unknown) => {
      upserts.push([row, opts]);
      return { error: options.upsertError ?? null };
    },
    select: () => builder,
    eq: (column: string, value: unknown) => {
      filters.push([column, value]);
      return builder;
    },
    in: (column: string, value: unknown) => {
      filters.push([column, value]);
      return builder;
    },
    limit: () => builder,
    maybeSingle: async () => ({ data: options.selectData ?? null, error: null }),
  };
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push([name, args]);
      return rpcResults.shift() ?? { data: true, error: null };
    },
    from: () => builder,
  } as unknown as SupabaseClient;
  return { client, rpcCalls, upserts, filters };
}

beforeEach(() => {
  vi.stubEnv("RATE_LIMIT_HASH_SECRET", "test-secret");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("clientIp / hashIp", () => {
  it("x-real-ip、無ければ x-forwarded-for の先頭を使う", () => {
    expect(clientIp(new Request("http://x", { headers: { "x-real-ip": "198.51.100.1" } }))).toBe("198.51.100.1");
    expect(clientIp(new Request("http://x", { headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" } }))).toBe(
      "203.0.113.5",
    );
    expect(clientIp(new Request("http://x"))).toBeNull();
  });

  it("IP はハッシュにして、そのままは使わない(同じ IP なら同じ値)", () => {
    const hashed = hashIp("203.0.113.5");
    expect(hashed).toMatch(/^[0-9a-f]{32}$/);
    expect(hashed).not.toContain("203");
    expect(hashIp("203.0.113.5")).toBe(hashed);
    expect(hashIp("203.0.113.6")).not.toBe(hashed);
  });
});

describe("checkGenerationRateLimit", () => {
  it("既定は IP+店舗で10分に20回、店舗ごとに1日300回。環境変数で変えられる", () => {
    expect(generationRateLimits()).toEqual({ ipSalonPer10Min: 20, salonPerDay: 300 });
    vi.stubEnv("REVIEW_RATE_LIMIT_IP_SALON_PER_10MIN", "40");
    vi.stubEnv("REVIEW_RATE_LIMIT_SALON_PER_DAY", "abc");
    expect(generationRateLimits()).toEqual({ ipSalonPer10Min: 40, salonPerDay: 300 });
  });

  it("IP+店舗と店舗の1日の上限を数える(キーに生の IP を入れない)", async () => {
    const admin = fakeAdmin();
    expect(await checkGenerationRateLimit(admin.client, { salonId: SALON_ID, ip: "203.0.113.5" })).toEqual({ allowed: true });
    expect(admin.rpcCalls).toEqual([
      ["rate_limit_hit", { p_key: `rg:ip:${hashIp("203.0.113.5")}:${SALON_ID}`, p_window_seconds: 600, p_limit: 20 }],
      ["rate_limit_hit", { p_key: `rg:salon:${SALON_ID}`, p_window_seconds: 86400, p_limit: 300 }],
    ]);
  });

  it("IP の上限に当たったら、店舗の回数は数えずに拒否する", async () => {
    const admin = fakeAdmin({ rpc: [{ data: false }] });
    expect(await checkGenerationRateLimit(admin.client, { salonId: SALON_ID, ip: "203.0.113.5" })).toEqual({
      allowed: false,
      scope: "ip_salon",
    });
    expect(admin.rpcCalls).toHaveLength(1);
  });

  it("店舗の1日の上限に当たったら拒否する", async () => {
    const admin = fakeAdmin({ rpc: [{ data: true }, { data: false }] });
    expect(await checkGenerationRateLimit(admin.client, { salonId: SALON_ID, ip: "203.0.113.5" })).toEqual({
      allowed: false,
      scope: "salon_daily",
    });
  });

  it("DB のエラー(0012 の適用前など)のときは通す", async () => {
    const admin = fakeAdmin({ rpc: [{ data: null, error: { code: "PGRST202" } }, { data: null, error: { code: "PGRST202" } }] });
    expect(await checkGenerationRateLimit(admin.client, { salonId: SALON_ID, ip: "203.0.113.5" })).toEqual({ allowed: true });
  });

  it("IP が分からなければ店舗の上限だけを数える", async () => {
    const admin = fakeAdmin();
    await checkGenerationRateLimit(admin.client, { salonId: SALON_ID, ip: null });
    expect(admin.rpcCalls.map(([, args]) => args.p_key)).toEqual([`rg:salon:${SALON_ID}`]);
  });

  it("CTA クリックの記録は IP ごとに10分60回まで", async () => {
    const admin = fakeAdmin({ rpc: [{ data: false }] });
    expect(await checkEventRateLimit(admin.client, "203.0.113.5")).toBe(false);
    expect(admin.rpcCalls[0][1]).toMatchObject({ p_window_seconds: 600, p_limit: 60 });
    expect(await checkEventRateLimit(fakeAdmin().client, null)).toBe(true);
  });
});

describe("recordGenerationEvent / generationExists", () => {
  it("メタデータを行にして記録し、同じ generation_id・kind は無視させる", async () => {
    const admin = fakeAdmin();
    await recordGenerationEvent(admin.client, {
      generationId: GENERATION_ID,
      salonId: SALON_ID,
      kind: "generated",
      pipeline: "v2",
      model: "x".repeat(150),
      lintFlags: ["template_phrase"],
    });
    expect(admin.upserts).toEqual([
      [
        expect.objectContaining({
          generation_id: GENERATION_ID,
          salon_id: SALON_ID,
          feature: "review_generation",
          kind: "generated",
          pipeline: "v2",
          model: "x".repeat(100),
          lint_flags: ["template_phrase"],
          verify_flags: [],
        }),
        { onConflict: "generation_id,kind", ignoreDuplicates: true },
      ],
    ]);
  });

  it("記録に失敗しても投げない", async () => {
    const admin = fakeAdmin({ upsertError: { code: "42P01" } });
    await expect(
      recordGenerationEvent(admin.client, { generationId: GENERATION_ID, salonId: SALON_ID, kind: "failed" }),
    ).resolves.toBeUndefined();
  });

  it("その店舗の生成として記録済みかを確かめる", async () => {
    const found = fakeAdmin({ selectData: { id: 1 } });
    expect(await generationExists(found.client, GENERATION_ID, SALON_ID)).toBe(true);
    expect(found.filters).toEqual([
      ["generation_id", GENERATION_ID],
      ["salon_id", SALON_ID],
      ["kind", ["generated", "regenerated"]],
    ]);
    expect(await generationExists(fakeAdmin().client, GENERATION_ID, SALON_ID)).toBe(false);
  });
});
