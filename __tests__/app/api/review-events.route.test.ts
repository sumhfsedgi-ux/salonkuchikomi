import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: vi.fn(() => ({ fake: "admin" })) }));
vi.mock("@/lib/reviewGeneration/rateLimit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reviewGeneration/rateLimit")>()),
  checkEventRateLimit: vi.fn(async () => true),
}));
let reviewsAvailable: boolean | null = true;
vi.mock("@/lib/reviewGeneration/availability", () => ({ loadReviewsAvailable: vi.fn(async () => reviewsAvailable) }));
vi.mock("@/lib/reviewGeneration/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reviewGeneration/events")>()),
  generationExists: vi.fn(async () => true),
  recordGenerationEvent: vi.fn(async () => {}),
}));

const { POST } = await import("@/app/api/review-events/route");
const { checkEventRateLimit } = await import("@/lib/reviewGeneration/rateLimit");
const { generationExists, recordGenerationEvent } = await import("@/lib/reviewGeneration/events");

const BODY = {
  generationId: "66666666-6666-4666-8666-666666666666",
  salonId: "11111111-1111-4111-8111-111111111111",
};

function post(body: unknown): Request {
  return new Request("http://localhost/api/review-events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

afterEach(() => {
  reviewsAvailable = true;
  vi.mocked(recordGenerationEvent).mockClear();
  vi.mocked(generationExists).mockClear();
});

describe("POST /api/review-events", () => {
  it("口コミを使えない店舗(運営による利用停止・利用開始待ち)・無い店舗の記録はしない(応答は同じ 204)", async () => {
    for (const value of [false, null]) {
      reviewsAvailable = value;
      const response = await POST(post(BODY));
      expect(response.status).toBe(204);
    }
    expect(generationExists).not.toHaveBeenCalled();
    expect(recordGenerationEvent).not.toHaveBeenCalled();
  });

  it("記録済みの生成なら cta_clicked を記録して 204", async () => {
    const response = await POST(post(BODY));
    expect(response.status).toBe(204);
    expect(generationExists).toHaveBeenCalledWith({ fake: "admin" }, BODY.generationId, BODY.salonId);
    expect(recordGenerationEvent).toHaveBeenCalledWith({ fake: "admin" }, { ...BODY, kind: "cta_clicked" });
  });

  it("記録されていない generation_id は記録しない(結果は同じ 204)", async () => {
    vi.mocked(generationExists).mockResolvedValueOnce(false);
    expect((await POST(post(BODY))).status).toBe(204);
    expect(recordGenerationEvent).not.toHaveBeenCalled();
  });

  it("形式が不正なら 400、上限を超えたら 429", async () => {
    expect((await POST(post("{"))).status).toBe(400);
    expect((await POST(post({ ...BODY, generationId: "x" }))).status).toBe(400);
    vi.mocked(checkEventRateLimit).mockResolvedValueOnce(false);
    expect((await POST(post(BODY))).status).toBe(429);
    expect(recordGenerationEvent).not.toHaveBeenCalled();
  });
});
