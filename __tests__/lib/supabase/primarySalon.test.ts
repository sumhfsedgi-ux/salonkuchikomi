import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pickPrimarySalon, toRowArray } from "@/lib/supabase/primarySalon";
import { getCurrentSalon } from "@/lib/supabase/queries";

describe("toRowArray", () => {
  it("配列はそのまま返す", () => {
    expect(toRowArray([{ id: "a" }, { id: "b" }])).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("オブジェクト(1対1の embedding)は1件の配列にする", () => {
    expect(toRowArray({ id: "a" })).toEqual([{ id: "a" }]);
  });

  it("null / undefined は空配列にする", () => {
    expect(toRowArray(null)).toEqual([]);
    expect(toRowArray(undefined)).toEqual([]);
  });
});

describe("pickPrimarySalon", () => {
  it("店舗が無ければ null", () => {
    expect(pickPrimarySalon([])).toBeNull();
  });

  it("並び順に関係なく、最も古い店舗を選ぶ", () => {
    const rows = [
      { id: "b", created_at: "2026-09-02T00:00:00+00:00" },
      { id: "a", created_at: "2026-09-01T00:00:00+00:00" },
    ];
    expect(pickPrimarySalon(rows)?.id).toBe("a");
    expect(pickPrimarySalon([...rows].reverse())?.id).toBe("a");
  });

  it("作成日時が同じなら id の順で選ぶ", () => {
    const createdAt = "2026-09-01T00:00:00+00:00";
    const rows = [
      { id: "c", created_at: createdAt },
      { id: "a", created_at: createdAt },
      { id: "b", created_at: createdAt },
    ];
    expect(pickPrimarySalon(rows)?.id).toBe("a");
  });

  it("タイムゾーンの表記が違っても時刻で比較する", () => {
    const rows = [
      { id: "utc", created_at: "2026-09-01T00:30:00+00:00" },
      { id: "jst", created_at: "2026-09-01T09:00:00+09:00" }, // = 2026-09-01T00:00:00Z
    ];
    expect(pickPrimarySalon(rows)?.id).toBe("jst");
  });

  it("渡された配列そのものは並べ替えない", () => {
    const rows = [
      { id: "b", created_at: "2026-09-02T00:00:00+00:00" },
      { id: "a", created_at: "2026-09-01T00:00:00+00:00" },
    ];
    pickPrimarySalon(rows);
    expect(rows.map((row) => row.id)).toEqual(["b", "a"]);
  });
});

function salonRow(id: string, createdAt: string) {
  return {
    id,
    owner_id: "profile-1",
    name: `店舗${id}`,
    slug: `slug-${id}`,
    google_review_url: null,
    description: null,
    business_type: null,
    onboarding_completed: true,
    plan: "reviews",
    created_at: createdAt,
    updated_at: createdAt,
  };
}

// getCurrentSalon が使う呼び出し(auth.getUser と profiles の embedding 取得)だけを持つ偽クライアント。
function fakeSupabase(embeddedSalons: unknown): SupabaseClient {
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { id: "profile-1", salons: embeddedSalons } }),
        }),
      }),
    }),
  };
  return client as unknown as SupabaseClient;
}

describe("getCurrentSalon", () => {
  it("embedding が配列で返っても、最も古い店舗を決定的に返す", async () => {
    const salon = await getCurrentSalon(
      fakeSupabase([salonRow("new", "2026-09-02T00:00:00+00:00"), salonRow("old", "2026-09-01T00:00:00+00:00")]),
    );
    expect(salon?.id).toBe("old");
    expect(salon?.ownerId).toBe("profile-1");
  });

  it("embedding がオブジェクト(1対1)で返っても扱える", async () => {
    const salon = await getCurrentSalon(fakeSupabase(salonRow("only", "2026-09-01T00:00:00+00:00")));
    expect(salon?.id).toBe("only");
  });

  it("店舗が無ければ null", async () => {
    expect(await getCurrentSalon(fakeSupabase([]))).toBeNull();
  });
});
