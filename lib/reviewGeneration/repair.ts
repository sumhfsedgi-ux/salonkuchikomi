// 口コミ下書きの部分修正(docs/plans/reviews-465-plan.md §14-3)。
// 部分修正するのは事実違反と、否定的な内容の反映漏れだけ。指摘された文だけを直させ、
// 反映されていない否定的な素材があれば反映させる(構造の問題は、パイプラインが全文を作り直す)。
// 1回だけ呼ぶ(直らなければ、呼び出し側が削除や本人の原文で対応する)。

import type { OpenAIUsage } from "@/lib/ai/openai";
import type { Material } from "@/lib/reviewGeneration/materials";
import {
  buildRepairUserPrompt,
  draftSchema,
  REPAIR_SYSTEM_PROMPT,
  type RawDraft,
} from "@/lib/reviewGeneration/prompts";
import type { CallJson } from "@/lib/reviewGeneration/verify";

export interface SentenceToRepair {
  text: string;
  sourceIds: string[];
  /** 指摘コード(Linter・意味検証)。空なら直さずにそのまま返させる。 */
  problems: string[];
}

export async function repairDraft(
  callJson: CallJson,
  params: {
    materials: readonly Material[];
    sentences: readonly SentenceToRepair[];
    missingNegativeIds: readonly string[];
    businessType: string | null;
    timeoutMs: number;
    temperature?: number;
  },
): Promise<{ raw: RawDraft; model: string; usage: OpenAIUsage | null; latencyMs: number }> {
  const result = await callJson<RawDraft>({
    task: "review_repair",
    systemPrompt: REPAIR_SYSTEM_PROMPT,
    userPrompt: buildRepairUserPrompt(params.materials, params.sentences, params.missingNegativeIds, params.businessType),
    schema: draftSchema(params.materials.map((m) => m.id)),
    temperature: params.temperature,
    maxOutputTokens: 700,
    timeoutMs: params.timeoutMs,
  });
  return { raw: result.data, model: result.model, usage: result.usage, latencyMs: result.latencyMs };
}
