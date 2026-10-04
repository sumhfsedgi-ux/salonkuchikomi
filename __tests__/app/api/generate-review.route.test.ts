import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveSurvey } from "@/lib/reviewGeneration/validateAnswers";

// 応答のあとに実行する処理(after)は、テストの中で明示的に実行する。
const afterCallbacks: Array<() => unknown> = [];
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (callback: () => unknown) => {
    afterCallbacks.push(callback);
  },
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: vi.fn(() => ({ fake: "admin" })) }));
vi.mock("@/lib/reviewGeneration/legacyV1", () => ({ generateReviewV1: vi.fn() }));
vi.mock("@/lib/reviewGeneration/rateLimit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reviewGeneration/rateLimit")>()),
  checkGenerationRateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/reviewGeneration/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reviewGeneration/events")>()),
  recordGenerationEvent: vi.fn(async () => {}),
}));
vi.mock("@/lib/reviewGeneration/validateAnswers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reviewGeneration/validateAnswers")>()),
  loadActiveSurvey: vi.fn(),
}));
vi.mock("@/lib/reviewGeneration/pipeline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reviewGeneration/pipeline")>()),
  runReviewPipeline: vi.fn(),
  runShadowVerification: vi.fn(),
}));

const { POST } = await import("@/app/api/generate-review/route");
const { generateReviewV1 } = await import("@/lib/reviewGeneration/legacyV1");
const { loadActiveSurvey } = await import("@/lib/reviewGeneration/validateAnswers");
const { runReviewPipeline, runShadowVerification, ReviewGenerationError } = await import(
  "@/lib/reviewGeneration/pipeline"
);
const { checkGenerationRateLimit } = await import("@/lib/reviewGeneration/rateLimit");
const { recordGenerationEvent } = await import("@/lib/reviewGeneration/events");
const { getSupabaseAdmin } = await import("@/lib/supabase/admin");

const SALON_ID = "11111111-1111-4111-8111-111111111111";
const Q_FREE = "44444444-4444-4444-8444-444444444444";
const SECRET_ANSWER = "待ち時間が長かった-SECRET";

const SURVEY: ActiveSurvey = {
  salonId: SALON_ID,
  salonName: "DBのサロン名",
  businessType: "エステ",
  questions: [{ id: Q_FREE, text: "ご自由にお書きください", type: "text", options: [], maxSelections: null }],
};

const V2_METADATA = {
  promptVersion: "review-v2.0",
  generationModel: "gpt-4o-mini",
  verificationModel: null,
  latencyMs: 1200,
  inputTokens: 800,
  outputTokens: 120,
  llmCalls: 1,
  lintCodes: ["main_not_used"],
  verifyMode: "none" as const,
  verifyFlags: [],
  repairAction: "none" as const,
};

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/generate-review", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const VALID_BODY = { salonId: SALON_ID, answers: [{ questionId: Q_FREE, values: [SECRET_ANSWER] }] };

async function runAfterCallbacks() {
  while (afterCallbacks.length > 0) await afterCallbacks.shift()!();
}

function recordedEvents() {
  return vi.mocked(recordGenerationEvent).mock.calls.map(([, event]) => event);
}

beforeEach(() => {
  vi.mocked(loadActiveSurvey).mockResolvedValue(SURVEY);
  for (const method of ["log", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(() => {
  afterCallbacks.length = 0;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(generateReviewV1).mockReset();
  vi.mocked(runReviewPipeline).mockReset();
  vi.mocked(runShadowVerification).mockReset();
  vi.mocked(recordGenerationEvent).mockClear();
  vi.mocked(checkGenerationRateLimit).mockClear();
});

describe("POST /api/generate-review: リクエストと照合", () => {
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

  it("アンケートと照合できない回答は 409(レート制限の回数にも数えない)", async () => {
    const response = await POST(
      post({ salonId: SALON_ID, answers: [{ questionId: SALON_ID, question: "消えた質問", values: ["はい"] }] }),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("再読み込み");
    expect(checkGenerationRateLimit).not.toHaveBeenCalled();
  });
});

describe("POST /api/generate-review: レート制限", () => {
  it("上限に当たったら 429 にし、生成しない", async () => {
    vi.mocked(checkGenerationRateLimit).mockResolvedValueOnce({ allowed: false, scope: "ip_salon" });
    const response = await POST(post(VALID_BODY, { "x-forwarded-for": "203.0.113.5, 10.0.0.1" }));
    expect(response.status).toBe(429);
    expect(generateReviewV1).not.toHaveBeenCalled();
    expect(vi.mocked(checkGenerationRateLimit).mock.calls[0][1]).toEqual({ salonId: SALON_ID, ip: "203.0.113.5" });
  });

  it("service role が使えなければ、レート制限と記録を諦めて生成は続ける", async () => {
    vi.mocked(getSupabaseAdmin).mockImplementationOnce(() => {
      throw new Error("no env");
    });
    vi.mocked(generateReviewV1).mockResolvedValue({ ok: true, review: "v1の口コミ", model: "m", latencyMs: 1, attempts: 1 });
    expect((await POST(post(VALID_BODY))).status).toBe(200);
    await runAfterCallbacks();
    expect(checkGenerationRateLimit).not.toHaveBeenCalled();
    expect(recordGenerationEvent).not.toHaveBeenCalled();
  });
});

describe("POST /api/generate-review: v1(既定)", () => {
  it("店舗名・業種は DB の値を渡し、メタデータだけを記録する", async () => {
    vi.mocked(generateReviewV1).mockResolvedValue({
      ok: true,
      review: "初めてでしたが大満足です。",
      model: "gpt-4o-mini",
      latencyMs: 900,
      attempts: 1,
    });
    const response = await POST(post({ ...VALID_BODY, previousReview: "前回" }));
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.review).toBe("初めてでしたが大満足です。");
    expect(generateReviewV1).toHaveBeenCalledWith({
      answers: [{ question: "ご自由にお書きください", answer: SECRET_ANSWER }],
      salonName: "DBのサロン名",
      businessType: "エステ",
      previousReview: "前回",
    });
    expect(runReviewPipeline).not.toHaveBeenCalled();

    await runAfterCallbacks();
    expect(recordedEvents()).toEqual([
      expect.objectContaining({
        generationId: json.generationId,
        salonId: SALON_ID,
        kind: "regenerated",
        pipeline: "v1",
        promptVersion: "review-v1",
        model: "gpt-4o-mini",
        latencyMs: 900,
        // v1 の下書きにも同じ Linter をかけて、指摘コードだけを残す。
        lintFlags: expect.arrayContaining(["extreme_emotional_exaggeration:strong"]),
      }),
    ]);
    expect(JSON.stringify(recordedEvents())).not.toContain("SECRET");
    expect(JSON.stringify(recordedEvents())).not.toContain("大満足です");
  });

  it("v1 の失敗はステータスをそのまま返し、failed を記録する", async () => {
    vi.mocked(generateReviewV1).mockResolvedValue({ ok: false, status: 504, kind: "timeout" });
    expect((await POST(post(VALID_BODY))).status).toBe(504);
    await runAfterCallbacks();
    expect(recordedEvents()).toEqual([expect.objectContaining({ kind: "failed", pipeline: "v1", errorKind: "timeout" })]);
  });
});

describe("POST /api/generate-review: v2", () => {
  beforeEach(() => {
    vi.stubEnv("REVIEW_PIPELINE", "v2");
  });

  it("v2 を使い、再生成用のプランを返し、メタデータを記録する", async () => {
    vi.stubEnv("REVIEW_SHADOW_VERIFY_RATE", "0");
    vi.mocked(runReviewPipeline).mockResolvedValue({
      draft: "v2の口コミ",
      plan: { mainIds: ["M1"], supportIds: [], unusedIds: ["M2"], length: "short", opening: "main", closing: "plain" },
      sentences: [],
      metadata: V2_METADATA,
    });
    const response = await POST(post(VALID_BODY));
    const json = await response.json();
    expect(json).toMatchObject({
      review: "v2の口コミ",
      plan: { mainIds: ["M1"], supportIds: [], length: "short", opening: "main", closing: "plain" },
    });
    expect(json.plan.unusedIds).toBeUndefined();
    expect(generateReviewV1).not.toHaveBeenCalled();

    await runAfterCallbacks();
    expect(recordedEvents()).toEqual([
      expect.objectContaining({ kind: "generated", pipeline: "v2", promptVersion: "review-v2.0", lintFlags: ["main_not_used"] }),
    ]);
    expect(runShadowVerification).not.toHaveBeenCalled();
  });

  it("同期検証をしなかった下書きは、割合に応じて影の検証をかけて記録する", async () => {
    vi.stubEnv("REVIEW_SHADOW_VERIFY_RATE", "1");
    vi.mocked(runReviewPipeline).mockResolvedValue({
      draft: "v2の口コミ",
      plan: { mainIds: ["M1"], supportIds: [], unusedIds: [], length: "short", opening: "main", closing: "plain" },
      sentences: [{ text: "v2の口コミ", sourceIds: ["M1"], breakAfter: false }],
      metadata: V2_METADATA,
    });
    vi.mocked(runShadowVerification).mockResolvedValue({
      verifyFlags: ["exaggeration"],
      unsupportedCount: 1,
      model: "verifier",
      usage: { inputTokens: 300, outputTokens: 40 },
      latencyMs: 800,
    });
    await POST(post(VALID_BODY));
    await runAfterCallbacks();
    expect(recordedEvents()).toEqual([
      expect.objectContaining({ kind: "generated" }),
      expect.objectContaining({
        kind: "shadow_verified",
        verifyMode: "shadow",
        verificationModel: "verifier",
        verifyFlags: ["exaggeration", "has_unsupported"],
      }),
    ]);
  });

  it("失敗は、タイムアウトなら 504、設定が無ければ 500、それ以外は 502 にし、failed を記録する", async () => {
    vi.mocked(runReviewPipeline).mockRejectedValueOnce(
      new ReviewGenerationError("t", "generation_failed", undefined, "timeout"),
    );
    expect((await POST(post(VALID_BODY))).status).toBe(504);
    vi.mocked(runReviewPipeline).mockRejectedValueOnce(new ReviewGenerationError("c", "config"));
    expect((await POST(post(VALID_BODY))).status).toBe(500);
    vi.mocked(runReviewPipeline).mockRejectedValueOnce(new ReviewGenerationError("u", "unusable_draft", V2_METADATA));
    expect((await POST(post(VALID_BODY))).status).toBe(502);

    await runAfterCallbacks();
    expect(recordedEvents().map((e) => [e.kind, e.errorKind])).toEqual([
      ["failed", "generation_failed:timeout"],
      ["failed", "config"],
      ["failed", "unusable_draft"],
    ]);
  });
});

describe("POST /api/generate-review: ログ", () => {
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
