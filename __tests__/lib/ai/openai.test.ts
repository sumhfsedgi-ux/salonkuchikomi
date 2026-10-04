import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  callOpenAIJson,
  OpenAICallError,
  resolveOpenAIModel,
  type CallOpenAIJsonOptions,
} from "@/lib/ai/openai";

const SECRET_PROMPT = "お客様の回答-SECRET";
const SECRET_CONTENT = "生成された口コミ本文-SECRET";
const SECRET_ERROR_MESSAGE = "error-detail-SECRET";

const baseOptions: CallOpenAIJsonOptions = {
  task: "review_generation",
  systemPrompt: "system-SECRET",
  userPrompt: SECRET_PROMPT,
  schema: { name: "review_draft", schema: { type: "object" } },
  maxOutputTokens: 400,
  timeoutMs: 10_000,
  retryBaseDelayMs: 0,
};

function completion(content: string, finishReason = "stop"): Response {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: finishReason, message: { content } }],
      usage: { prompt_tokens: 120, completion_tokens: 30 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function errorResponse(status: number, code = "server_error"): Response {
  return new Response(JSON.stringify({ error: { message: SECRET_ERROR_MESSAGE, code } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.stubEnv("OPENAI_MODEL", "base-model");
  vi.stubEnv("OPENAI_MODEL_REVIEW_GENERATION", "");
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function expectCallError(promise: Promise<unknown>): Promise<OpenAICallError> {
  const error = await promise.then(
    () => {
      throw new Error("callOpenAIJson が成功してしまいました");
    },
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(OpenAICallError);
  return error as OpenAICallError;
}

describe("resolveOpenAIModel", () => {
  it("タスク別の設定があればそれを使い、無ければ OPENAI_MODEL を使う", () => {
    expect(resolveOpenAIModel("review_generation")).toBe("base-model");
    vi.stubEnv("OPENAI_MODEL_REVIEW_GENERATION", "task-model");
    expect(resolveOpenAIModel("review_generation")).toBe("task-model");
    expect(resolveOpenAIModel("reply_generation")).toBe("base-model");
  });

  it("どちらも無ければ null", () => {
    vi.stubEnv("OPENAI_MODEL", "");
    expect(resolveOpenAIModel("review_generation")).toBeNull();
  });
});

describe("callOpenAIJson", () => {
  it("APIキーが無ければ config エラーにして、APIを呼ばない", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const error = await expectCallError(callOpenAIJson(baseOptions));
    expect(error.kind).toBe("config");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("成功したら JSON・usage・モデル名・試行回数を返す", async () => {
    fetchMock.mockResolvedValueOnce(completion(JSON.stringify({ sentences: ["a"] })));
    const result = await callOpenAIJson<{ sentences: string[] }>(baseOptions);
    expect(result.data).toEqual({ sentences: ["a"] });
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 30 });
    expect(result.model).toBe("base-model");
    expect(result.attempts).toBe(1);
  });

  it("max_completion_tokens と strict な json_schema を送り、temperature は指定したときだけ送る", async () => {
    fetchMock.mockResolvedValueOnce(completion("{}"));
    await callOpenAIJson(baseOptions);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(firstBody.max_completion_tokens).toBe(400);
    expect(firstBody.max_tokens).toBeUndefined();
    expect(firstBody.temperature).toBeUndefined();
    expect(firstBody.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "review_draft", strict: true, schema: { type: "object" } },
    });

    fetchMock.mockResolvedValueOnce(completion("{}"));
    await callOpenAIJson({ ...baseOptions, temperature: 0.7 });
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(secondBody.temperature).toBe(0.7);
  });

  it("model を指定すれば、タスクの既定のモデルより優先する", async () => {
    fetchMock.mockResolvedValueOnce(completion("{}"));
    const result = await callOpenAIJson({ ...baseOptions, model: "override-model" });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).model).toBe("override-model");
    expect(result.model).toBe("override-model");
  });

  it("429 は再試行し、2回目で成功すれば attempts=2", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(429, "rate_limit_exceeded"));
    fetchMock.mockResolvedValueOnce(completion("{}"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await callOpenAIJson(baseOptions);
    expect(result.attempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("429 が続いたら rate_limited", async () => {
    fetchMock.mockImplementation(async () => errorResponse(429, "rate_limit_exceeded"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = await expectCallError(callOpenAIJson(baseOptions));
    expect(error.kind).toBe("rate_limited");
    expect(error.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 初回 + 既定の再試行1回
  });

  it("400 は再試行しない", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(400, "invalid_request_error"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = await expectCallError(callOpenAIJson(baseOptions));
    expect(error.kind).toBe("api_error");
    expect(error.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("通信エラーは再試行する", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    fetchMock.mockResolvedValueOnce(completion("{}"));
    const result = await callOpenAIJson(baseOptions);
    expect(result.attempts).toBe(2);
  });

  it("タイムアウトは timeout にして再試行しない", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    const error = await expectCallError(callOpenAIJson(baseOptions));
    expect(error.kind).toBe("timeout");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("モデルが応答を拒否したら refusal", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: null, refusal: "できません" } }] }), {
        status: 200,
      }),
    );
    const error = await expectCallError(callOpenAIJson(baseOptions));
    expect(error.kind).toBe("refusal");
  });

  it("出力上限で途中終了したら invalid_response", async () => {
    fetchMock.mockResolvedValueOnce(completion('{"sentences": ["途中', "length"));
    const error = await expectCallError(callOpenAIJson(baseOptions));
    expect(error.kind).toBe("invalid_response");
  });

  it("JSON として解析できない応答は invalid_response", async () => {
    fetchMock.mockResolvedValueOnce(completion("これはJSONではない"));
    const error = await expectCallError(callOpenAIJson(baseOptions));
    expect(error.kind).toBe("invalid_response");
  });

  it("ログにプロンプト・応答本文・エラーメッセージを出さない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    fetchMock.mockResolvedValueOnce(errorResponse(500));
    fetchMock.mockResolvedValueOnce(completion(SECRET_CONTENT));
    await expectCallError(callOpenAIJson(baseOptions));

    const logged = JSON.stringify([...warn.mock.calls, ...errorLog.mock.calls, ...log.mock.calls]);
    expect(logged).not.toContain("SECRET");
  });
});
