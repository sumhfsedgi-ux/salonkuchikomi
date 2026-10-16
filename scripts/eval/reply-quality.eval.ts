// 架空の既存21件を同じモデルで比較する。通常のテストでは実行しない。
// EVAL_RUN=1 + OPENAI_API_KEY を設定して明示的に実行:
// vitest run --config vitest.eval.config.mts scripts/eval/reply-quality.eval.ts
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { it, expect } from "vitest";
import { callOpenAIJson } from "@/lib/ai/openai";
import { generateReplyDraft, ReplyGenerationError } from "@/lib/replyGeneration/pipeline";
import { REPLY_PROMPT_VERSION } from "@/lib/replyGeneration/prompts";
import { maskContactDetails } from "@/lib/replyGeneration/text";
import { replyLanguage, replyLength, replyLengthTarget } from "@/lib/replyGeneration/quality";
import { DEFAULT_REPLY_SETTINGS, type ReplySettings } from "@/lib/replyGeneration/settings";
import type { StarRating } from "@/lib/replyGeneration/classify";

interface Sample { title: string; group: string; reviewText: string; rating: StarRating; settings: ReplySettings; reply: string; regenerated: string | null }
it.skipIf(process.env.EVAL_RUN !== "1")("架空の既存21件を比較する(外部AIのみ。DBやGoogleを呼ばない)", async () => {
  if (!process.env.OPENAI_API_KEY?.trim()) throw new Error("OPENAI_API_KEY is required for this opt-in evaluation");
  const baseline = JSON.parse(await readFile(path.resolve("scripts/eval/fixtures/reply-quality-baseline.json"), "utf8")) as {
    model: string; salon: { name: string; businessType: string; description: string }; samples: Sample[];
  };
  expect(baseline.model).toBe("gpt-4o-mini");
  expect(baseline.samples).toHaveLength(21);
  const output = path.resolve(".eval-output", `reply-quality-${REPLY_PROMPT_VERSION}`);
  await mkdir(output, { recursive: true });
  const results: Record<string, unknown>[] = [];
  // 原因確認時は指定ケースだけを実行し、全件比較を上書きしない。
  const indices = process.env.EVAL_SAMPLE_INDEXES?.split(",").map(Number);
  const samples = indices ? baseline.samples.filter((_, index) => indices.includes(index + 1)) : baseline.samples;
  expect(samples.length).toBeGreaterThan(0);
  const basename = indices ? "focused-comparison" : "comparison";
  let calls = 0;
  let traces: unknown[] = [];
  const deps = {
    resolveModel: () => baseline.model,
    random: () => 0,
    callJson: async <T,>(options: Parameters<typeof callOpenAIJson>[0]) => {
      if (++calls > 44) throw new Error("Evaluation call budget exceeded");
      const result = await callOpenAIJson<T>({ ...options, model: baseline.model, maxRetries: 0 });
      // この評価専用・架空データのみ。実サービスのログには追加しない。
      traces.push(result.data);
      return result;
    },
  };
  for (const sample of samples) {
    traces = [];
    const settings = { ...DEFAULT_REPLY_SETTINGS, ...sample.settings };
    const input = { salon: baseline.salon, reviewText: maskContactDetails(sample.reviewText), rating: sample.rating, settings };
    const row: Record<string, unknown> = { title: sample.title, group: sample.group, review: sample.reviewText, rating: sample.rating, settings: sample.settings, before: sample.reply, beforeRegenerated: sample.regenerated };
    try {
      const result = await generateReplyDraft(input, deps);
      Object.assign(row, { after: result.reply, mode: result.mode, metadata: result.metadata, language: replyLanguage(sample.reviewText), lengthIncludingClosings: replyLength(result.reply, replyLanguage(sample.reviewText)), bodyTarget: replyLengthTarget(result.mode, settings, replyLanguage(sample.reviewText)), warnings: result.warnings });
      if (sample.regenerated) {
        try { row.regenerated = await generateReplyDraft({ ...input, previousReply: maskContactDetails(result.reply) }, deps); }
        catch (error) { row.regenerationError = error instanceof ReplyGenerationError ? { kind: error.kind, metadata: error.metadata } : { kind: "unknown" }; }
      }
    } catch (error) {
      row.error = error instanceof ReplyGenerationError ? { kind: error.kind, metadata: error.metadata } : { kind: "unknown" };
    }
    results.push(row);
    row.traces = traces;
    await writeFile(path.join(output, `${basename}.json`), JSON.stringify({ generatedAt: new Date().toISOString(), model: baseline.model, promptVersion: REPLY_PROMPT_VERSION, calls, results }, null, 2), "utf8");
    console.log(`${results.length}/${samples.length} ${sample.title}: ${row.error ? "failed" : "ok"}`);
  }
  const report = ["# 口コミ返信案の比較", `モデル: ${baseline.model} / ${REPLY_PROMPT_VERSION}`, "架空の口コミのみ。文字数・語数は署名等を含む値、目安は本文のみ。旧出力は既存の保存例なので生成時の乱数等は同一ではありません。", ...results.flatMap((r, i) => [
    `## ${i + 1}. ${r.title}`, `★${r.rating} / ${r.mode ?? "生成失敗"} / 長さ: ${r.lengthIncludingClosings ?? "—"}`, `口コミ: ${r.review || "本文なし"}`, "### 変更前", String(r.before), "### 変更後", String(r.after ?? JSON.stringify(r.error)), `確認事項: ${JSON.stringify(r.warnings ?? [])}`, `検査・修正: ${JSON.stringify(r.metadata ?? {})}`, ...(r.regenerated ? ["### 作り直し", (r.regenerated as { reply: string }).reply] : []),
  ])].join("\n\n");
  await writeFile(path.join(output, `${basename}.md`), report, "utf8");
  expect(results.filter((r) => r.error || r.regenerationError).map((r) => ({ title: r.title, error: r.error ?? r.regenerationError }))).toEqual([]);
});
