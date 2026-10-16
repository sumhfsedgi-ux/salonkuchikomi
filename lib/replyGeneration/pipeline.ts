import "server-only";
import { callOpenAIJson, OpenAICallError, resolveOpenAIModel, type OpenAITask } from "@/lib/ai/openai";
import { classifyReview, type ReplyMode, type ReplyModeTrigger, type StarRating } from "@/lib/replyGeneration/classify";
import {
  blockingIssues,
  lintReply,
  REPAIR_HINTS,
  REVIEW_WARNING_MESSAGES,
  toSentences,
  type ReplyLintIssue,
  type ReplyWarningCode,
} from "@/lib/replyGeneration/lint";
import {
  buildRepairUserPrompt,
  buildReplyUserPrompt,
  REPAIR_SCHEMA,
  REPLY_PROMPT_VERSION,
  REPLY_SCHEMA,
  REPLY_SYSTEM_PROMPT,
  type RepairOutput,
  type ReplyDraftOutput,
  type ReplyPromptInput,
} from "@/lib/replyGeneration/prompts";
import type { ReplySettings } from "@/lib/replyGeneration/settings";
import type { CallJson } from "@/lib/reviewGeneration/verify";
import { replyLengthProblems, replyQualityProblems } from "@/lib/replyGeneration/quality";
import { REPLY_MAX_BYTES, utf8Bytes } from "@/lib/replyGeneration/text";

// 口コミ返信の下書きを作る(docs/plans/google-reviews-inbox-plan.md §9)。
//   ① ★と本文からモードを決める(コード)
//   ② LLM 1回で下書きを作る
//   ③ 禁止表現と品質を検査し、重要な内容を残して1回だけ直させる。文の自動削除はしない
//   ④ ★1〜2なら連絡先の案内、設定があれば署名をコードで付け足す
// 口コミ本文・下書きはどこにも保存せず、ログにも出さない(エラーは種類だけを返す)。

export type ReplyGenerationErrorKind =
  | "config"
  | "timeout"
  | "rate_limited"
  | "api_error"
  | "invalid_response"
  | "unsafe_output";

export class ReplyGenerationError extends Error {
  constructor(
    message: string,
    readonly kind: ReplyGenerationErrorKind,
    readonly metadata?: ReplyMetadata,
  ) {
    super(message);
    this.name = "ReplyGenerationError";
  }
}

export interface ReplyMetadata {
  promptVersion: string;
  mode: ReplyMode;
  /** モードを決めた理由(★・本文の不満・トラブルの内容 など)。本文は含めない。 */
  trigger: ReplyModeTrigger;
  model: string | null;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  llmCalls: number;
  /** 最初の下書きで見つかった指摘のコード(重複なし)。 */
  lintCodes: string[];
  repairAction: "none" | "removed" | "repaired";
}

export interface ReplyWarning {
  code: ReplyWarningCode;
  message: string;
}

export interface ReplyResult {
  reply: string;
  mode: ReplyMode;
  warnings: ReplyWarning[];
  metadata: ReplyMetadata;
}

export interface ReplyInput {
  reviewText: string;
  rating: StarRating;
  settings: ReplySettings;
  salon: { name: string; businessType: string | null; description: string | null };
  /** 再生成のとき、前の AI の案。書き出しを変えるためだけに使う(保存しない)。 */
  previousReply?: string | null;
}

export interface ReplyPipelineDeps {
  callJson?: CallJson;
  resolveModel?: (task: OpenAITask) => string | null;
  random?: () => number;
  now?: () => number;
}

const TASK: OpenAITask = "reply_generation";
const DEFAULT_BUDGET_MS = 40_000;
const GENERATION_TIMEOUT_MS = 20_000;
const REPAIR_TIMEOUT_MS = 12_000;
const MIN_CALL_BUDGET_MS = 3_000;
const GENERATION_TEMPERATURE = 0.7;
const REPAIR_TEMPERATURE = 0.2;
const MAX_OUTPUT_TOKENS = 1_200;
// 推論系のモデルは既定以外の temperature を受け付けないので送らない。
const REASONING_MODEL = /^(o\d|gpt-5)/i;

function temperatureFor(model: string | null, value: number): number | undefined {
  return model && REASONING_MODEL.test(model) ? undefined : value;
}

/** 改行・空白を整え、絵文字などの飾りと、連続した感嘆符を取り除く。 */
export function cleanReply(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\p{Extended_Pictographic}|[♪☆✨]/gu, "")
    .replace(/[!！]{2,}/g, "！")
    .split("\n")
    .map((line) => line.trim())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && lines[index - 1].length > 0))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function firstSentence(text: string | null | undefined): string | null {
  if (!text) return null;
  return toSentences(text)[0]?.text ?? null;
}

/** 署名と、★1〜2のときの連絡先の案内を付け足す(LLM には書かせない)。 */
export function appendClosings(reply: string, mode: ReplyMode, settings: ReplySettings, rating?: StarRating): string {
  const parts = [reply];
  const contact = settings.contactNote.trim();
  if ((mode === "careful" || (rating !== undefined && rating <= 2)) && contact) parts.push(contact);
  const signature = settings.signature.trim();
  if (signature && !reply.trimEnd().endsWith(signature)) parts.push(signature);
  return parts.join("\n");
}

function uniqueCodes(issues: readonly ReplyLintIssue[]): string[] {
  return [...new Set(issues.map((issue) => issue.code))];
}

function warningsFor(mode: ReplyMode, finalIssues: readonly ReplyLintIssue[]): ReplyWarning[] {
  const codes = new Set<ReplyWarningCode>();
  if (mode === "careful") codes.add("careful_mode");
  for (const issue of finalIssues) {
    if (issue.code === "unsupported_number" || issue.code === "over_apology") codes.add(issue.code);
  }
  return [...codes].map((code) => ({ code, message: REVIEW_WARNING_MESSAGES[code] }));
}

function toErrorKind(err: unknown): ReplyGenerationErrorKind {
  if (err instanceof OpenAICallError) {
    if (err.kind === "config" || err.kind === "timeout" || err.kind === "rate_limited") return err.kind;
    if (err.kind === "invalid_response" || err.kind === "refusal") return "invalid_response";
    return "api_error";
  }
  return "api_error";
}

export async function generateReplyDraft(input: ReplyInput, deps: ReplyPipelineDeps = {}): Promise<ReplyResult> {
  const callJson: CallJson = deps.callJson ?? (callOpenAIJson as CallJson);
  const resolveModel = deps.resolveModel ?? resolveOpenAIModel;
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;

  const startedAt = now();
  const deadline = startedAt + DEFAULT_BUDGET_MS;
  const classification = classifyReview(input.reviewText, input.rating);
  const model = resolveModel(TASK);

  const metadata: ReplyMetadata = {
    promptVersion: REPLY_PROMPT_VERSION,
    mode: classification.mode,
    trigger: classification.trigger,
    model,
    latencyMs: 0,
    inputTokens: null,
    outputTokens: null,
    llmCalls: 0,
    lintCodes: [],
    repairAction: "none",
  };
  const addUsage = (usage: { inputTokens: number; outputTokens: number } | null) => {
    if (!usage) return;
    metadata.inputTokens = (metadata.inputTokens ?? 0) + usage.inputTokens;
    metadata.outputTokens = (metadata.outputTokens ?? 0) + usage.outputTokens;
  };
  const fail = (message: string, kind: ReplyGenerationErrorKind): never => {
    metadata.latencyMs = now() - startedAt;
    throw new ReplyGenerationError(message, kind, metadata);
  };

  const promptInput: ReplyPromptInput = {
    reviewText: input.reviewText,
    rating: input.rating,
    mode: classification.mode,
    settings: input.settings,
    salon: input.salon,
    previousOpening: firstSentence(input.previousReply),
    variation: random(),
  };
  const lintContext = { reviewText: input.reviewText, rating: input.rating, mode: classification.mode };

  // ② 作文
  let draft: string;
  let quotes: unknown = [];
  try {
    metadata.llmCalls++;
    const result = await callJson<ReplyDraftOutput>({
      task: TASK,
      systemPrompt: REPLY_SYSTEM_PROMPT,
      userPrompt: buildReplyUserPrompt(promptInput),
      schema: REPLY_SCHEMA,
      temperature: temperatureFor(model, GENERATION_TEMPERATURE),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      timeoutMs: Math.min(GENERATION_TIMEOUT_MS, deadline - now()),
    });
    metadata.model = result.model;
    addUsage(result.usage);
    draft = cleanReply(typeof result.data?.reply === "string" ? result.data.reply : "");
    quotes = result.data?.respond_to;
  } catch (err) {
    return fail("返信案を作れませんでした。", toErrorKind(err));
  }
  if (!draft) return fail("返信案が空でした。", "invalid_response");

  // ③ 検査と修正
  let issues = lintReply(draft, lintContext);
  metadata.lintCodes = uniqueCodes(issues);
  let blocking = blockingIssues(issues);
  let quality = replyQualityProblems(draft, promptInput, quotes);
  let lengthProblems = replyLengthProblems(draft, promptInput);
  if (quality.length) metadata.lintCodes.push("reply_quality");
  if (lengthProblems.length) metadata.lintCodes.push("reply_length");

  if (blocking.length > 0 || quality.length > 0 || lengthProblems.length > 0) {
    if (deadline - now() >= MIN_CALL_BUDGET_MS) {
      try {
        metadata.llmCalls++;
        const problems = [...new Set([...blocking.map((issue) => REPAIR_HINTS[issue.code]), ...quality, ...lengthProblems])];
        const repaired = await callJson<RepairOutput>({
          task: TASK,
          systemPrompt: REPLY_SYSTEM_PROMPT,
          userPrompt: buildRepairUserPrompt(promptInput, draft, problems),
          schema: REPAIR_SCHEMA,
          temperature: temperatureFor(model, REPAIR_TEMPERATURE),
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          timeoutMs: Math.min(REPAIR_TIMEOUT_MS, deadline - now()),
        });
        addUsage(repaired.usage);
        const candidate = cleanReply(typeof repaired.data?.reply === "string" ? repaired.data.reply : "");
        if (candidate) {
          draft = candidate;
          quotes = repaired.data?.respond_to;
          metadata.repairAction = "repaired";
        }
      } catch {
        // 修正に失敗したら元の案を再検査し、問題が残る場合は返さない。
      }
    }

    issues = lintReply(draft, lintContext);
    blocking = blockingIssues(issues);
    quality = replyQualityProblems(draft, promptInput, quotes);
    lengthProblems = replyLengthProblems(draft, promptInput);
    if (blocking.length > 0 || quality.length > 0) return fail("適切な返信案を作れませんでした。", "unsafe_output");
  }

  // ④ 連絡先の案内・署名
  const reply = appendClosings(draft, classification.mode, input.settings, input.rating);
  if (utf8Bytes(reply) > REPLY_MAX_BYTES) return fail("返信案が長すぎます。", "unsafe_output");
  metadata.latencyMs = now() - startedAt;
  return {
    reply,
    mode: classification.mode,
    warnings: [...warningsFor(classification.mode, issues), ...(lengthProblems.length ? [{ code: "length_target" as const, message: REVIEW_WARNING_MESSAGES.length_target }] : [])],
    metadata,
  };
}
