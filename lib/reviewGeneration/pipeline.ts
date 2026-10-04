// 口コミ生成 v2 のパイプライン(docs/plans/reviews-465-plan.md §7-1・§13-2)。
//   構成プラン(コード) → 作文(LLM 1回) → Linter(コード)
//   → 危険な文だけ同期で意味検証(LLM。NG・タイムアウトはその文を削除 = fail-closed)
//   → 削除で足りなければ1回だけ部分修正 → それでも否定的な素材が消えるなら本人の原文を残す
// 回答・素材・下書きの本文はログに出さない。返すメタデータにも本文は含めない。

import {
  callOpenAIJson,
  OpenAICallError,
  resolveOpenAIModel,
  type OpenAITask,
  type OpenAIUsage,
} from "@/lib/ai/openai";
import { normalize, stripDecorations } from "@/lib/ai/naturalJapanese/analyze";
import {
  blockedSentenceIndexes,
  documentBlockIssues,
  lintCodes,
  lintDraft,
  riskySentenceIndexes,
  type LintResult,
  type LintSentence,
} from "@/lib/ai/naturalJapanese/lint";
import { toLintSources, type Material } from "@/lib/reviewGeneration/materials";
import {
  buildCompositionPlan,
  LENGTH_TARGETS,
  type CompositionPlan,
  type PreviousPlan,
} from "@/lib/reviewGeneration/plan";
import {
  buildGenerationUserPrompt,
  draftSchema,
  GENERATION_SYSTEM_PROMPT,
  PROMPT_VERSION,
  type RawDraft,
} from "@/lib/reviewGeneration/prompts";
import { repairDraft } from "@/lib/reviewGeneration/repair";
import { verifySentences, type CallJson, type VerificationVerdict } from "@/lib/reviewGeneration/verify";

export interface DraftSentence {
  text: string;
  sourceIds: string[];
  breakAfter: boolean;
}

/** 下書きに対して行った対応(強いもの優先で1つ記録する)。 */
export type RepairAction = "none" | "removed" | "regenerated" | "repaired" | "own_words_fallback";
export type VerifyMode = "none" | "sync";

/** 生成イベントに記録するメタデータ(本文は含めない)。 */
export interface PipelineMetadata {
  promptVersion: string;
  generationModel: string | null;
  verificationModel: string | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  llmCalls: number;
  lintCodes: string[];
  verifyMode: VerifyMode;
  verifyFlags: string[];
  repairAction: RepairAction;
}

export interface PipelineResult {
  draft: string;
  plan: CompositionPlan;
  sentences: DraftSentence[];
  metadata: PipelineMetadata;
}

export type ReviewGenerationErrorKind = "no_materials" | "config" | "generation_failed" | "unusable_draft";

export class ReviewGenerationError extends Error {
  constructor(
    message: string,
    readonly kind: ReviewGenerationErrorKind,
    readonly metadata?: PipelineMetadata,
    /** OpenAI 呼び出しの失敗理由(timeout など)。 */
    readonly causeKind?: string,
  ) {
    super(message);
    this.name = "ReviewGenerationError";
  }
}

export interface PipelineDeps {
  callJson?: CallJson;
  resolveModel?: (task: OpenAITask) => string | null;
  random?: () => number;
  now?: () => number;
}

export interface PipelineInput {
  materials: Material[];
  businessType: string | null;
  previousPlan?: PreviousPlan;
}

// お客様がスマホで待つ時間の上限。各呼び出しはこの残り時間の範囲で行う。
const DEFAULT_BUDGET_MS = 40_000;
const GENERATION_TIMEOUT_MS = 15_000;
const VERIFICATION_TIMEOUT_MS = 6_000;
const REPAIR_TIMEOUT_MS = 10_000;
// 残り時間がこれ未満なら、その呼び出しは行わない(意味検証なら NG 扱い)。
const MIN_CALL_BUDGET_MS = 2_500;

const GENERATION_TEMPERATURE = 0.9;
const VERIFICATION_TEMPERATURE = 0;
const REPAIR_TEMPERATURE = 0.3;
// 推論系のモデルは既定以外の temperature を受け付けないので送らない。
const REASONING_MODEL = /^(o\d|gpt-5)/i;

const REPAIR_ACTION_RANK: Record<RepairAction, number> = {
  none: 0,
  removed: 1,
  regenerated: 2,
  repaired: 3,
  own_words_fallback: 4,
};

function temperatureFor(model: string | null, value: number): number | undefined {
  return model && !REASONING_MODEL.test(model) ? value : undefined;
}

const SENTENCE_END = /[。．！？!?」』）)]$/u;

function ensureSentenceEnd(text: string): string {
  return SENTENCE_END.test(text) ? text : `${text}。`;
}

/** LLM の出力を整える(装飾・文中の改行を除き、文末の句点を補う)。 */
export function cleanSentences(raw: RawDraft | null | undefined): DraftSentence[] {
  return (raw?.sentences ?? [])
    .map((s) => {
      const text = stripDecorations(String(s.text ?? ""))
        .replace(/[\r\n]+/g, "")
        .trim();
      return {
        text: text ? ensureSentenceEnd(text) : "",
        sourceIds: [...new Set(Array.isArray(s.source_ids) ? s.source_ids : [])],
        breakAfter: s.break_after === true,
      };
    })
    .filter((s) => s.text.length > 0);
}

/** 文をつなげて下書きにする。改行は最初の1回だけ使う。 */
export function assembleDraft(sentences: readonly DraftSentence[]): string {
  let usedBreak = false;
  return sentences
    .map((s, i) => {
      const isLast = i === sentences.length - 1;
      if (!isLast && s.breakAfter && !usedBreak) {
        usedBreak = true;
        return `${s.text}\n`;
      }
      return s.text;
    })
    .join("");
}

/** 意味検証にかける文: risk の指摘がある文、否定的な素材を出典にする文、効果・医療の語を含む文。 */
function verificationTargets(result: LintResult): number[] {
  const targets = new Set(riskySentenceIndexes(result));
  result.traits.forEach((t, i) => {
    if (t.citesNegative || t.hasClaimVocabulary) targets.add(i);
  });
  return [...targets].sort((a, b) => a - b);
}

function issueCodesBySentence(result: LintResult, severities: ReadonlyArray<"block" | "risk">): Map<number, string[]> {
  const map = new Map<number, string[]>();
  for (const i of result.issues) {
    if (i.sentenceIndex === null || !severities.includes(i.severity as "block" | "risk")) continue;
    map.set(i.sentenceIndex, [...(map.get(i.sentenceIndex) ?? []), i.code]);
  }
  return map;
}

class MetadataRecorder {
  private inputTokens = 0;
  private outputTokens = 0;
  private llmCalls = 0;
  private generationModel: string | null = null;
  private verificationModel: string | null = null;
  private verifyFlags = new Set<string>();
  private repairAction: RepairAction = "none";
  verifyMode: VerifyMode = "none";

  constructor(
    private readonly startedAt: number,
    private readonly now: () => number,
  ) {}

  record(kind: "generation" | "verification" | "repair", call: { model: string; usage: OpenAIUsage | null }) {
    this.llmCalls++;
    this.inputTokens += call.usage?.inputTokens ?? 0;
    this.outputTokens += call.usage?.outputTokens ?? 0;
    if (kind === "generation" && !this.generationModel) this.generationModel = call.model;
    if (kind === "verification" && !this.verificationModel) this.verificationModel = call.model;
  }

  countFailedCall() {
    this.llmCalls++;
  }

  flag(...flags: string[]) {
    for (const f of flags) this.verifyFlags.add(f);
  }

  action(next: RepairAction) {
    if (REPAIR_ACTION_RANK[next] > REPAIR_ACTION_RANK[this.repairAction]) this.repairAction = next;
  }

  snapshot(finalLintCodes: string[]): PipelineMetadata {
    return {
      promptVersion: PROMPT_VERSION,
      generationModel: this.generationModel,
      verificationModel: this.verificationModel,
      latencyMs: this.now() - this.startedAt,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      llmCalls: this.llmCalls,
      lintCodes: finalLintCodes,
      verifyMode: this.verifyMode,
      verifyFlags: [...this.verifyFlags],
      repairAction: this.repairAction,
    };
  }
}

export async function runReviewPipeline(input: PipelineInput, deps: PipelineDeps = {}, budgetMs = DEFAULT_BUDGET_MS): Promise<PipelineResult> {
  const callJson = deps.callJson ?? callOpenAIJson;
  const resolveModel = deps.resolveModel ?? resolveOpenAIModel;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const remaining = () => startedAt + budgetMs - now();
  const meta = new MetadataRecorder(startedAt, now);

  const { materials, businessType } = input;
  if (materials.length === 0) throw new ReviewGenerationError("素材がありません", "no_materials");

  const plan = buildCompositionPlan(materials, { random: deps.random, previous: input.previousPlan });
  const sources = toLintSources(materials);
  const materialById = new Map(materials.map((m) => [m.id, m]));
  const lint = (sentences: readonly LintSentence[]) =>
    lintDraft(sentences, sources, { mainSourceIds: plan.mainIds, targetChars: LENGTH_TARGETS[plan.length].chars });

  // ── 1. 作文(使える文が1つも無ければ1回だけ作り直す) ──
  async function generateOnce(): Promise<DraftSentence[]> {
    const result = await callJson<RawDraft>({
      task: "review_generation",
      systemPrompt: GENERATION_SYSTEM_PROMPT,
      userPrompt: buildGenerationUserPrompt(materials, plan, businessType),
      schema: draftSchema(materials.map((m) => m.id)),
      temperature: temperatureFor(resolveModel("review_generation"), GENERATION_TEMPERATURE),
      maxOutputTokens: 700,
      timeoutMs: Math.min(GENERATION_TIMEOUT_MS, remaining()),
    });
    meta.record("generation", result);
    return cleanSentences(result.data);
  }

  let sentences: DraftSentence[] | null = null;
  let failureKind: string | undefined;
  for (let attempt = 1; attempt <= 2 && !sentences; attempt++) {
    if (attempt > 1 && remaining() < MIN_CALL_BUDGET_MS * 2) break;
    try {
      const candidate = await generateOnce();
      if (candidate.length > blockedSentenceIndexes(lint(candidate)).length) {
        sentences = candidate;
        if (attempt > 1) meta.action("regenerated");
      } else {
        failureKind = "unusable";
      }
    } catch (err) {
      meta.countFailedCall();
      if (err instanceof OpenAICallError) {
        if (err.kind === "config") {
          throw new ReviewGenerationError("OpenAI の設定がありません", "config", meta.snapshot([]), err.kind);
        }
        failureKind = err.kind;
        // タイムアウト・レート制限は、作り直しても待ち時間が延びるだけなので諦める。
        if (err.kind === "timeout" || err.kind === "rate_limited") break;
      } else {
        throw err;
      }
    }
  }
  if (!sentences) {
    throw new ReviewGenerationError("口コミの作成に失敗しました", "generation_failed", meta.snapshot([]), failureKind);
  }

  // ── 2. 意味検証(同期) ──
  async function verify(targets: readonly number[], draft: readonly DraftSentence[]) {
    meta.verifyMode = "sync";
    if (remaining() < MIN_CALL_BUDGET_MS) {
      meta.flag("verification_deadline");
      return null;
    }
    try {
      const outcome = await verifySentences(callJson, {
        materials,
        sentences: targets.map((index) => ({ index, text: draft[index].text, sourceIds: draft[index].sourceIds })),
        timeoutMs: Math.min(VERIFICATION_TIMEOUT_MS, remaining()),
        temperature: temperatureFor(resolveModel("review_verification"), VERIFICATION_TEMPERATURE),
      });
      meta.record("verification", outcome);
      for (const verdict of outcome.verdicts.values()) meta.flag(...verdict.issues);
      return outcome.verdicts;
    } catch {
      meta.countFailedCall();
      meta.flag("verification_unavailable");
      return null;
    }
  }

  /** block の文と、意味検証で NG(または確認できなかった)文を、指摘コードつきで返す。 */
  async function reject(draft: readonly DraftSentence[], skipVerifyFor: ReadonlySet<string> = new Set()) {
    const result = lint(draft);
    const rejected = issueCodesBySentence(result, ["block"]);
    const riskCodes = issueCodesBySentence(result, ["risk"]);
    const targets = verificationTargets(result).filter(
      (i) => !rejected.has(i) && !skipVerifyFor.has(normalize(draft[i].text)),
    );
    if (targets.length > 0) {
      const verdicts: Map<number, VerificationVerdict> | null = await verify(targets, draft);
      for (const index of targets) {
        const verdict = verdicts?.get(index);
        if (verdict?.supported) continue;
        const codes = verdict && verdict.issues.length > 0 ? verdict.issues : (riskCodes.get(index) ?? []);
        rejected.set(index, codes.length > 0 ? codes : ["verification_unavailable"]);
      }
    }
    return rejected;
  }

  const rejected = await reject(sentences);
  let kept = sentences.filter((_, i) => !rejected.has(i));
  if (rejected.size > 0) meta.action("removed");

  // ── 3. 削除で足りなければ1回だけ部分修正 ──
  // 否定的な素材が反映されていない・下書きが空、または NG の削除で主役が消えたときに直す。
  const mainNotUsed = (draft: readonly DraftSentence[]) =>
    lint(draft).issues.some((i) => i.code === "main_not_used");
  const mainLostByRemoval = rejected.size > 0 && !mainNotUsed(sentences) && mainNotUsed(kept);
  const needsRepair = documentBlockIssues(lint(kept)).length > 0 || mainLostByRemoval;

  if (needsRepair && remaining() >= MIN_CALL_BUDGET_MS) {
    const missingNegativeIds = documentBlockIssues(lint(kept))
      .filter((i) => i.code === "negative_not_reflected" && i.sourceId)
      .map((i) => i.sourceId as string);
    try {
      const repaired = await repairDraft(callJson, {
        materials,
        sentences: sentences.map((s, i) => ({ text: s.text, sourceIds: s.sourceIds, problems: rejected.get(i) ?? [] })),
        missingNegativeIds,
        businessType,
        timeoutMs: Math.min(REPAIR_TIMEOUT_MS, remaining()),
        temperature: temperatureFor(resolveModel("review_repair"), REPAIR_TEMPERATURE),
      });
      meta.record("repair", repaired);
      const repairedSentences = cleanSentences(repaired.raw);
      // 合格済みで変わっていない文は、もう一度検証しない。
      const accepted = new Set(kept.map((s) => normalize(s.text)));
      const repairedRejected = await reject(repairedSentences, accepted);
      const candidate = repairedSentences.filter((_, i) => !repairedRejected.has(i));
      if (candidate.length > 0) {
        kept = candidate;
        meta.action("repaired");
      }
    } catch {
      meta.countFailedCall();
      meta.flag("repair_failed");
    }
  }

  // ── 4. それでも反映されていない否定的な素材は、本人の原文をそのまま残す ──
  for (const issue of documentBlockIssues(lint(kept))) {
    if (issue.code !== "negative_not_reflected" || !issue.sourceId) continue;
    const material = materialById.get(issue.sourceId);
    if (!material) continue;
    kept.push({ text: ensureSentenceEnd(material.text.trim()), sourceIds: [material.id], breakAfter: false });
    meta.action("own_words_fallback");
  }

  if (kept.length === 0) {
    throw new ReviewGenerationError("使える下書きができませんでした", "unusable_draft", meta.snapshot(lintCodes(lint(kept))));
  }

  return {
    draft: assembleDraft(kept),
    plan,
    sentences: kept,
    metadata: meta.snapshot(lintCodes(lint(kept))),
  };
}

export interface ShadowVerificationResult {
  verifyFlags: string[];
  unsupportedCount: number;
  model: string;
  usage: OpenAIUsage | null;
  latencyMs: number;
}

/**
 * 影の意味検証(同期検証をしなかった下書きの計測用)。結果は下書きを変えない。
 * 失敗したら null(計測が欠けるだけで、お客様には影響しない)。
 */
export async function runShadowVerification(
  materials: readonly Material[],
  sentences: readonly DraftSentence[],
  deps: Pick<PipelineDeps, "callJson" | "resolveModel"> = {},
): Promise<ShadowVerificationResult | null> {
  if (sentences.length === 0) return null;
  const callJson = deps.callJson ?? callOpenAIJson;
  const resolveModel = deps.resolveModel ?? resolveOpenAIModel;
  try {
    const outcome = await verifySentences(callJson, {
      materials,
      sentences: sentences.map((s, index) => ({ index, text: s.text, sourceIds: s.sourceIds })),
      timeoutMs: VERIFICATION_TIMEOUT_MS * 2,
      temperature: temperatureFor(resolveModel("review_verification"), VERIFICATION_TEMPERATURE),
    });
    const verdicts = [...outcome.verdicts.values()];
    return {
      verifyFlags: [...new Set(verdicts.flatMap((v) => v.issues))],
      unsupportedCount: verdicts.filter((v) => !v.supported).length,
      model: outcome.model,
      usage: outcome.usage,
      latencyMs: outcome.latencyMs,
    };
  } catch {
    return null;
  }
}
