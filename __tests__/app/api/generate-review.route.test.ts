import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveSurvey } from "@/lib/reviewGeneration/validateAnswers";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/reviewGeneration/legacyV1", () => ({ generateReviewV1: vi.fn() }));
vi.mock("@/lib/reviewGeneration/validateAnswers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reviewGeneration/validateAnswers")>()),
  loadActiveSurvey: vi.fn(),
}));
vi.mock("@/lib/reviewGeneration/pipeline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reviewGeneration/pipeline")>()),
  runReviewPipeline: vi.fn(),
}));

const { POST } = await import("@/app/api/generate-review/route");
const { generateReviewV1 } = await import("@/lib/reviewGeneration/legacyV1");
const { loadActiveSurvey } = await import("@/lib/reviewGeneration/validateAnswers");
const { runReviewPipeline, ReviewGenerationError } = await import("@/lib/reviewGeneration/pipeline");

const SALON_ID = "11111111-1111-4111-8111-111111111111";
const Q_FREE = "44444444-4444-4444-8444-444444444444";
const SECRET_ANSWER = "待ち時間が長かった-SECRET";

const SURVEY: ActiveSurvey = {
  salonId: SALON_ID,
  salonName: "DBのサロン名",
  businessType: "エステ",
  questions: [{ id: Q_FREE, text: "ご自由にお書きください", type: "text", options: [], maxSelections: null }],
};

function post(body: unknown): Request {
  return new Request("http://localhost/api/generate-review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const VALID_BODY = { salonId: SALON_ID, answers: [{ questionId: Q_FREE, values: [SECRET_ANSWER] }] };

beforeEach(() => {
  vi.mocked(loadActiveSurvey).mockResolvedValue(SURVEY);
  for (const method of ["log", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(generateReviewV1).mockReset();
  vi.mocked(runReviewPipeline).mockReset();
});

describe("POST /api/generate-review", () => {
  it("JSON でない・形式が不正なら 400", async () => {
    expect((await POST(post("{"))).status).toBe(400);
    expect((await POST(post({ salonId: "x", answers: [] }))).status).toBe(400);
  });

  it("店舗かアンケートが無ければ 404、DB のエラーは 503", async () => {
    vi.mocked(loadActiveSurvey).mockResolvedValueOnce(null);
    expect((await POST(post(VALID_BODY))).status).toBe(404);
    vi.mocked(loadActiveSurvey).mockRejectedValueOnce(new Error("db"));
    expect((await POST(post(VALID_BODY))).status).toBe(503);
  });

  it("アンケートと照合できない回答は 409", async () => {
    const response = await POST(
      post({ salonId: SALON_ID, answers: [{ questionId: SALON_ID, question: "消えた質問", values: ["はい"] }] }),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("再読み込み");
  });

  it("既定は v1。店舗名・業種は DB の値を渡す", async () => {
    vi.mocked(generateReviewV1).mockResolvedValue({ ok: true, review: "v1の口コミ", model: "m", latencyMs: 1, attempts: 1 });
    const response = await POST(post({ ...VALID_BODY, previousReview: "前回" }));
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.review).toBe("v1の口コミ");
    expect(json.generationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(generateReviewV1).toHaveBeenCalledWith({
      answers: [{ question: "ご自由にお書きください", answer: SECRET_ANSWER }],
      salonName: "DBのサロン名",
      businessType: "エステ",
      previousReview: "前回",
    });
    expect(runReviewPipeline).not.toHaveBeenCalled();
  });

  it("REVIEW_PIPELINE=v2 なら v2 を使い、再生成用のプランを返す", async () => {
    vi.stubEnv("REVIEW_PIPELINE", "v2");
    vi.mocked(runReviewPipeline).mockResolvedValue({
      draft: "v2の口コミ",
      plan: { mainIds: ["M1"], supportIds: [], unusedIds: ["M2"], length: "short", opening: "main", closing: "plain" },
      sentences: [],
      metadata: {} as never,
    });
    const response = await POST(post(VALID_BODY));
    const json = await response.json();
    expect(json).toMatchObject({
      review: "v2の口コミ",
      plan: { mainIds: ["M1"], supportIds: [], length: "short", opening: "main", closing: "plain" },
    });
    expect(json.plan.unusedIds).toBeUndefined();
    expect(generateReviewV1).not.toHaveBeenCalled();
    expect(vi.mocked(runReviewPipeline).mock.calls[0][0]).toMatchObject({ businessType: "エステ" });
  });

  it("v2 の失敗は、タイムアウトなら 504、設定が無ければ 500、それ以外は 502", async () => {
    vi.stubEnv("REVIEW_PIPELINE", "v2");
    vi.mocked(runReviewPipeline).mockRejectedValueOnce(
      new ReviewGenerationError("t", "generation_failed", undefined, "timeout"),
    );
    expect((await POST(post(VALID_BODY))).status).toBe(504);
    vi.mocked(runReviewPipeline).mockRejectedValueOnce(new ReviewGenerationError("c", "config"));
    expect((await POST(post(VALID_BODY))).status).toBe(500);
    vi.mocked(runReviewPipeline).mockRejectedValueOnce(new ReviewGenerationError("u", "unusable_draft"));
    expect((await POST(post(VALID_BODY))).status).toBe(502);
  });

  it("v1 の失敗はステータスをそのまま返す", async () => {
    vi.mocked(generateReviewV1).mockResolvedValue({ ok: false, status: 504, kind: "timeout" });
    expect((await POST(post(VALID_BODY))).status).toBe(504);
  });

  it("ログに回答の本文を出さない", async () => {
    vi.mocked(generateReviewV1).mockResolvedValue({ ok: false, status: 502, kind: "api_error" });
    await POST(post(VALID_BODY));
    vi.mocked(loadActiveSurvey).mockResolvedValueOnce({ ...SURVEY, questions: [] });
    await POST(post(VALID_BODY));
    const logged = JSON.stringify([
      ...vi.mocked(console.log).mock.calls,
      ...vi.mocked(console.warn).mock.calls,
      ...vi.mocked(console.error).mock.calls,
    ]);
    expect(logged).not.toContain("SECRET");
  });
});
