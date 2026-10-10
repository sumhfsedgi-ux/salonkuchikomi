// 口コミ生成 API の待ち時間を、区間ごとに測る(docs: 性能改善の計測)。
// 持つのは区間の名前・ミリ秒・回数だけ。回答・生成した文章・IP アドレスは持たない。
// 既存の metadata.latencyMs(生成の処理だけの時間)はそのまま残し、こちらは DB の待ちや
// API 全体を含めて測る。

import type { CallOpenAIJsonOptions } from "@/lib/ai/openai";
import type { CallJson } from "@/lib/reviewGeneration/verify";

export interface LlmCallTiming {
  /** JSON Schema の名前(どの呼び出しか)。 */
  name: string;
  task: string;
  ms: number;
  /** 通信の再試行を含めた回数(失敗したときは分からないので null)。 */
  attempts: number | null;
  ok: boolean;
}

const round = (ms: number) => Math.round(ms * 10) / 10;

export function createRequestTimer(now: () => number = () => performance.now()) {
  const startedAt = now();
  const segments: Record<string, number> = {};
  const llm: LlmCallTiming[] = [];

  return {
    /** fn の時間を name の区間に足す(失敗しても足す)。 */
    async measure<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
      const start = now();
      try {
        return await fn();
      } finally {
        segments[name] = round((segments[name] ?? 0) + now() - start);
      }
    },

    /** AI の呼び出しを包んで、1回ごとの時間を記録する(引数と結果は変えない)。 */
    wrapCallJson(base: CallJson): CallJson {
      return async <T>(options: CallOpenAIJsonOptions) => {
        const start = now();
        try {
          const result = await base<T>(options);
          llm.push({ name: options.schema.name, task: options.task, ms: round(now() - start), attempts: result.attempts, ok: true });
          return result;
        } catch (err) {
          llm.push({ name: options.schema.name, task: options.task, ms: round(now() - start), attempts: null, ok: false });
          throw err;
        }
      };
    },

    summary() {
      const totalMs = round(now() - startedAt);
      const measuredMs = Object.values(segments).reduce((sum, ms) => sum + ms, 0);
      const llmMs = llm.reduce((sum, call) => sum + call.ms, 0);
      return {
        segments: { ...segments },
        llm: [...llm],
        /** 生成の区間のうち、AI の待ち以外(下書きの検査・組み立てなど)。 */
        generationNonLlmMs: segments.generation === undefined ? null : round(Math.max(0, segments.generation - llmMs)),
        /** 区間に入らない残り(JSON の組み立てなど)。 */
        otherMs: round(Math.max(0, totalMs - measuredMs)),
        totalMs,
      };
    },
  };
}

export type RequestTimer = ReturnType<typeof createRequestTimer>;

/** Server-Timing ヘッダーの値(REVIEW_SERVER_TIMING=1 のときだけ付ける)。 */
export function serverTimingHeader(summary: ReturnType<RequestTimer["summary"]>): string {
  const parts = Object.entries(summary.segments).map(([name, ms]) => `${name};dur=${ms}`);
  summary.llm.forEach((call, i) => parts.push(`llm${i + 1}-${call.name.replace(/[^A-Za-z0-9_-]/g, "")};dur=${call.ms}`));
  parts.push(`other;dur=${summary.otherMs}`, `total;dur=${summary.totalMs}`);
  return parts.join(", ");
}
