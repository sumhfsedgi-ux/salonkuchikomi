import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateReviewV1 } from "@/lib/reviewGeneration/legacyV1";

const SECRET = "回答本文-SECRET";
const fetchMock = vi.fn<typeof fetch>();

function completion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

const PARAMS = {
  answers: [
    { question: "今回のご来店は何回目ですか？", answer: "初めて" },
    { question: "ご自由にお書きください", answer: SECRET },
    { question: "空の回答", answer: "" },
  ],
  salonName: "テストサロン",
  businessType: "エステ",
};

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.stubEnv("OPENAI_MODEL", "gpt-4o-mini");
  vi.stubGlobal("fetch", fetchMock);
  for (const method of ["log", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("generateReviewV1(Phase 1 より前と同じ動き)", () => {
  it("同じモデル・temperature・メッセージの形で呼ぶ", async () => {
    fetchMock.mockResolvedValueOnce(completion("初めてでしたが良かったです。"));
    const result = await generateReviewV1(PARAMS);
    expect(result).toMatchObject({ ok: true, review: "初めてでしたが良かったです。", model: "gpt-4o-mini", attempts: 1 });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.temperature).toBe(1.0);
    expect(body.messages[0].content).toContain("店舗名: テストサロン");
    expect(body.messages[0].content).toContain("業種: エステ");
    expect(body.messages[1].content).toBe(`今回のご来店は何回目ですか？: 初めて\nご自由にお書きください: ${SECRET}`);
  });

  it("拒否文・業種外の内容なら1回だけ作り直す", async () => {
    fetchMock.mockResolvedValueOnce(completion("申し訳ありませんが…"));
    fetchMock.mockResolvedValueOnce(completion("説明が分かりやすかったです。"));
    const result = await generateReviewV1(PARAMS);
    expect(result).toMatchObject({ ok: true, attempts: 2 });

    fetchMock.mockResolvedValueOnce(completion("カフェのランチが美味しかった"));
    fetchMock.mockResolvedValueOnce(completion("ケーキも最高"));
    expect(await generateReviewV1(PARAMS)).toEqual({ ok: false, status: 502, kind: "invalid_review" });
  });

  it("設定が無ければ 500、API エラーは 502、タイムアウトは 504", async () => {
    vi.stubEnv("OPENAI_MODEL", "");
    expect(await generateReviewV1(PARAMS)).toEqual({ ok: false, status: 500, kind: "config" });
    vi.stubEnv("OPENAI_MODEL", "gpt-4o-mini");

    fetchMock.mockResolvedValueOnce(new Response(`{"error":{"message":"${SECRET}"}}`, { status: 500 }));
    expect(await generateReviewV1(PARAMS)).toEqual({ ok: false, status: 502, kind: "api_error" });

    fetchMock.mockRejectedValueOnce(Object.assign(new Error("t"), { name: "TimeoutError" }));
    expect(await generateReviewV1(PARAMS)).toEqual({ ok: false, status: 504, kind: "timeout" });
  });

  it("ログに回答・生成した文章・OpenAI のエラー本文を出さない", async () => {
    fetchMock.mockResolvedValueOnce(completion(`申し訳ありません ${SECRET}`));
    fetchMock.mockResolvedValueOnce(completion(`申し訳ありません ${SECRET}`));
    await generateReviewV1(PARAMS);
    fetchMock.mockResolvedValueOnce(new Response(`{"error":{"message":"${SECRET}"}}`, { status: 400 }));
    await generateReviewV1(PARAMS);

    const logged = JSON.stringify([
      ...vi.mocked(console.log).mock.calls,
      ...vi.mocked(console.warn).mock.calls,
      ...vi.mocked(console.error).mock.calls,
    ]);
    expect(logged).not.toContain("SECRET");
  });
});
