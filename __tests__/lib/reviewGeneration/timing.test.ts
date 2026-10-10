import { describe, expect, it } from "vitest";
import { OpenAICallError, type CallOpenAIJsonOptions } from "@/lib/ai/openai";
import { createRequestTimer, serverTimingHeader } from "@/lib/reviewGeneration/timing";
import type { CallJson } from "@/lib/reviewGeneration/verify";

const OPTIONS: CallOpenAIJsonOptions = {
  task: "review_generation",
  systemPrompt: "system",
  userPrompt: "回答の本文",
  schema: { name: "review_draft", schema: {} },
  maxOutputTokens: 100,
  timeoutMs: 1000,
};

function clock(...ticks: number[]) {
  let i = 0;
  return () => ticks[Math.min(i++, ticks.length - 1)];
}

describe("createRequestTimer", () => {
  it("AI の呼び出しを包んでも、渡す引数と返す結果は変えず、名前と時間と回数だけを残す", async () => {
    const seen: CallOpenAIJsonOptions[] = [];
    const base: CallJson = async <T>(options: CallOpenAIJsonOptions) => {
      seen.push(options);
      return { data: { ok: true } as T, model: "m", usage: null, latencyMs: 5, attempts: 2 };
    };
    const timer = createRequestTimer(clock(0, 10, 30, 40));
    const result = await timer.wrapCallJson(base)(OPTIONS);
    expect(seen).toEqual([OPTIONS]);
    expect(seen[0]).toBe(OPTIONS);
    expect(result).toEqual({ data: { ok: true }, model: "m", usage: null, latencyMs: 5, attempts: 2 });
    const summary = timer.summary();
    expect(summary.llm).toEqual([{ name: "review_draft", task: "review_generation", ms: 20, attempts: 2, ok: true }]);
    expect(JSON.stringify(summary)).not.toContain("回答の本文");
  });

  it("失敗した呼び出しも記録し、エラーはそのまま投げる", async () => {
    const error = new OpenAICallError("timeout", "timeout");
    const base: CallJson = async () => {
      throw error;
    };
    const timer = createRequestTimer(clock(0, 0, 7, 7));
    await expect(timer.wrapCallJson(base)(OPTIONS)).rejects.toBe(error);
    expect(timer.summary().llm).toEqual([{ name: "review_draft", task: "review_generation", ms: 7, attempts: null, ok: false }]);
  });

  it("区間・AI 以外の生成の時間・残り・全体を分けて出す", async () => {
    // 開始 0 → survey 0〜10 → generation 10〜110(うち AI 20〜80)→ 終了 120
    const timer = createRequestTimer(clock(0, 0, 10, 10, 20, 80, 110, 120));
    await timer.measure("survey", async () => null);
    await timer.measure("generation", async () => {
      await timer.wrapCallJson(async <T>() => ({ data: {} as T, model: "m", usage: null, latencyMs: 0, attempts: 1 }))(OPTIONS);
    });
    const summary = timer.summary();
    expect(summary.segments).toEqual({ survey: 10, generation: 100 });
    expect(summary.generationNonLlmMs).toBe(40);
    expect(summary.otherMs).toBe(10);
    expect(summary.totalMs).toBe(120);
    expect(serverTimingHeader(summary)).toBe(
      "survey;dur=10, generation;dur=100, llm1-review_draft;dur=60, other;dur=10, total;dur=120",
    );
  });
});
