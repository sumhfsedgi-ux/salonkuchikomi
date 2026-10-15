import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StarRating } from "@/lib/replyGeneration/classify";
import { generateReplyDraft, ReplyGenerationError, type ReplyMetadata, type ReplyResult } from "@/lib/replyGeneration/pipeline";
import { checkReplyRateLimit } from "@/lib/replyGeneration/rateLimit";
import { loadReplySettings } from "@/lib/replyGeneration/settingsRepo";
import { maskContactDetails, REPLY_MAX_BYTES, REVIEW_TEXT_MAX_CHARS, utf8Bytes } from "@/lib/replyGeneration/text";
import { MOCK_REPLY_PREFIX, mockReplyDeps } from "@/lib/replyGeneration/mockGenerator";
import { recordGenerationEvent, type GenerationEvent } from "@/lib/reviewGeneration/events";

// 届いた口コミの AI返信の案を作る共通の処理(計画 第2版 §3-2・§3-6)。
//   ① 利用回数の上限(店舗ごと)を確かめる。確かめられなければ作らない(入力は画面に残る)
//   ② 店舗の返信の設定を読む
//   ③ 口コミ本文の URL・メールアドレス・電話番号を伏せ字にしてから、返信の作成エンジン(lib/replyGeneration/pipeline.ts)に渡す。
//      投稿者名は受け取らない(呼び出し側は本文と★だけを渡す)
//   ④ 使用量を記録する(本文・返信は記録しない)
// 文章を作るのは、本番では OpenAI。架空の Google を使う検証(mock)では、OpenAI を呼ばずに決まった架空の文章にする。
// 口コミ本文・返信の案は、どこにも保存せず、ログにも出さない(種類だけ)。

export interface ReplyWarningView {
  code: string;
  message: string;
}

export type ReplyServiceResult =
  | { ok: true; reply: string; warnings: ReplyWarningView[]; careful: boolean }
  | { ok: false; error: string; retryable: boolean };

export interface ReplyServiceInput {
  salon: { id: string; name: string; businessType: string | null; description: string | null };
  reviewText: string;
  rating: StarRating;
  /** 再生成のとき、直前の AI の案(書き出しを変えるためだけに使う)。 */
  previousReply: string | null;
  regenerate: boolean;
}

export interface ReplyServiceDeps {
  /** service role の DB(利用回数の上限・設定・使用量の記録)。使えなければ null(作らない)。 */
  admin: SupabaseClient | null;
  /** 文章を作る部分を架空にするか(架空の Google を使う検証だけ)。 */
  mock: boolean;
  /** 応答のあとに実行する(next/server の after)。 */
  schedule: (task: () => Promise<void> | void) => void;
}

export const REPLY_ERRORS = {
  tooLong: `口コミが長すぎます(${REVIEW_TEXT_MAX_CHARS}文字まで)。`,
  rateShort: "短い時間に続けて作成されたため、少し時間をおいてからもう一度お試しください。",
  rateDaily: "本日の返信案の作成回数の上限に達しました。明日もう一度お試しください。",
  rateUnavailable:
    "利用回数の上限を確認できないため、返信案の作成を一時停止しています。入力した内容はそのまま残っています。少し時間をおいて、もう一度お試しください。",
  config: "現在、返信案を作れない状態です。しばらくしてからもう一度お試しください。",
  timeout: "時間がかかったため、返信案を作れませんでした。もう一度お試しください。",
  unsafe: "適切な返信案を作れませんでした。もう一度お試しいただくか、返信を直接入力してください。",
  generic: "返信案を作れませんでした。もう一度お試しください。",
} as const;

function eventFields(metadata: ReplyMetadata | undefined): Partial<GenerationEvent> {
  if (!metadata) return {};
  return {
    promptVersion: metadata.promptVersion,
    model: metadata.model,
    latencyMs: metadata.latencyMs,
    inputTokens: metadata.inputTokens,
    outputTokens: metadata.outputTokens,
    llmCalls: metadata.llmCalls,
    lintFlags: [`mode:${metadata.mode}`, `trigger:${metadata.trigger}`, ...metadata.lintCodes],
    repairAction: metadata.repairAction,
  };
}

function errorFor(err: unknown): { error: string; retryable: boolean; kind: string } {
  if (err instanceof ReplyGenerationError) {
    switch (err.kind) {
      case "config":
        return { error: REPLY_ERRORS.config, retryable: false, kind: err.kind };
      case "timeout":
        return { error: REPLY_ERRORS.timeout, retryable: true, kind: err.kind };
      case "unsafe_output":
        return { error: REPLY_ERRORS.unsafe, retryable: true, kind: err.kind };
      default:
        return { error: REPLY_ERRORS.generic, retryable: true, kind: err.kind };
    }
  }
  return { error: REPLY_ERRORS.generic, retryable: true, kind: "unknown" };
}

function toResult(reply: string, result: ReplyResult): ReplyServiceResult {
  return { ok: true, reply, warnings: result.warnings.map(({ code, message }) => ({ code, message })), careful: result.mode === "careful" };
}

export async function generateReplyForSalon(input: ReplyServiceInput, deps: ReplyServiceDeps): Promise<ReplyServiceResult> {
  const reviewText = maskContactDetails(input.reviewText.trim());
  if ([...reviewText].length > REVIEW_TEXT_MAX_CHARS) return { ok: false, error: REPLY_ERRORS.tooLong, retryable: false };
  // 前の案は書き出しを変えるためにしか使わないので、長すぎるものは捨てる。
  const previousReply = input.regenerate && input.previousReply && utf8Bytes(input.previousReply) <= REPLY_MAX_BYTES * 2 ? input.previousReply : null;

  const { admin } = deps;
  if (!admin) return { ok: false, error: REPLY_ERRORS.rateUnavailable, retryable: true };
  const decision = await checkReplyRateLimit(admin, input.salon.id);
  if (!decision.allowed) {
    if (decision.scope === "unavailable") return { ok: false, error: REPLY_ERRORS.rateUnavailable, retryable: true };
    return { ok: false, error: decision.scope === "daily" ? REPLY_ERRORS.rateDaily : REPLY_ERRORS.rateShort, retryable: false };
  }

  const settings = (await loadReplySettings(admin, input.salon.id)).settings;
  const generationId = randomUUID();
  const kind = input.regenerate ? "regenerated" : "generated";
  try {
    const result = await generateReplyDraft(
      {
        reviewText,
        rating: input.rating,
        settings,
        salon: { name: input.salon.name, businessType: input.salon.businessType, description: input.salon.description },
        previousReply,
      },
      deps.mock ? mockReplyDeps(reviewText, input.rating) : undefined,
    );
    deps.schedule(() => recordGenerationEvent(admin, { generationId, salonId: input.salon.id, feature: "reply_generation", kind, ...eventFields(result.metadata) }));
    return toResult((deps.mock ? MOCK_REPLY_PREFIX : "") + result.reply, result);
  } catch (err) {
    const mapped = errorFor(err);
    // 本文は出さない。種類だけを残す。
    console.warn("reply generation failed", { kind: mapped.kind });
    deps.schedule(() =>
      recordGenerationEvent(admin, {
        generationId,
        salonId: input.salon.id,
        feature: "reply_generation",
        kind: "failed",
        ...eventFields(err instanceof ReplyGenerationError ? err.metadata : undefined),
        errorKind: mapped.kind,
      }),
    );
    return { ok: false, error: mapped.error, retryable: mapped.retryable };
  }
}
