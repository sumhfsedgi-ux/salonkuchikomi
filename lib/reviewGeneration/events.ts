import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PipelineMetadata } from "@/lib/reviewGeneration/pipeline";

// 口コミ生成のイベント記録(0012 の ai_generation_events)。記録するのはメタデータだけで、
// 回答・生成した口コミの本文は渡せない型にしている。記録に失敗しても、お客様への応答には
// 影響させない(投げずにログへ種類だけを残す)。

export type GenerationEventKind = "generated" | "regenerated" | "failed" | "shadow_verified" | "cta_clicked";

export interface GenerationEvent {
  generationId: string;
  salonId: string;
  kind: GenerationEventKind;
  pipeline?: "v1" | "v2";
  promptVersion?: string | null;
  model?: string | null;
  verificationModel?: string | null;
  latencyMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  llmCalls?: number | null;
  lintFlags?: string[];
  verifyMode?: "none" | "sync" | "shadow";
  verifyFlags?: string[];
  repairAction?: PipelineMetadata["repairAction"] | null;
  errorKind?: string | null;
}

/** v1 の口コミ生成の版(v2 の PROMPT_VERSION と区別する)。 */
export const V1_PROMPT_VERSION = "review-v1";

function truncate(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function toRow(event: GenerationEvent) {
  return {
    generation_id: event.generationId,
    salon_id: event.salonId,
    feature: "review_generation",
    kind: event.kind,
    pipeline: event.pipeline ?? null,
    prompt_version: truncate(event.promptVersion, 40),
    model: truncate(event.model, 100),
    verification_model: truncate(event.verificationModel, 100),
    latency_ms: event.latencyMs ?? null,
    input_tokens: event.inputTokens ?? null,
    output_tokens: event.outputTokens ?? null,
    llm_calls: event.llmCalls ?? null,
    lint_flags: event.lintFlags ?? [],
    verify_mode: event.verifyMode ?? null,
    verify_flags: event.verifyFlags ?? [],
    repair_action: event.repairAction ?? null,
    error_kind: truncate(event.errorKind, 40),
  };
}

/** 記録する。同じ generation_id・kind の2回目以降は無視する。 */
export async function recordGenerationEvent(admin: SupabaseClient, event: GenerationEvent): Promise<void> {
  try {
    const { error } = await admin
      .from("ai_generation_events")
      .upsert(toRow(event), { onConflict: "generation_id,kind", ignoreDuplicates: true });
    if (error) console.warn("ai_generation_events insert failed", { kind: event.kind, code: error.code });
  } catch {
    console.warn("ai_generation_events insert failed", { kind: event.kind });
  }
}

/** v2 のパイプラインのメタデータから、イベントの項目を作る。 */
export function eventFieldsFromMetadata(metadata: PipelineMetadata): Partial<GenerationEvent> {
  return {
    pipeline: "v2",
    promptVersion: metadata.promptVersion,
    model: metadata.generationModel,
    verificationModel: metadata.verificationModel,
    latencyMs: metadata.latencyMs,
    inputTokens: metadata.inputTokens,
    outputTokens: metadata.outputTokens,
    llmCalls: metadata.llmCalls,
    lintFlags: metadata.lintCodes,
    verifyMode: metadata.verifyMode,
    verifyFlags: metadata.verifyFlags,
    repairAction: metadata.repairAction,
  };
}

/** generation_id がこの店舗の生成として記録されているか(CTA クリックの記録の前に確かめる)。 */
export async function generationExists(admin: SupabaseClient, generationId: string, salonId: string): Promise<boolean> {
  const { data, error } = await admin
    .from("ai_generation_events")
    .select("id")
    .eq("generation_id", generationId)
    .eq("salon_id", salonId)
    .in("kind", ["generated", "regenerated"])
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn("ai_generation_events lookup failed", { code: error.code });
    return false;
  }
  return data !== null;
}
