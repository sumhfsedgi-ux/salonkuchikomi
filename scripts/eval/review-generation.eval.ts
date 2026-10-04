// 口コミ生成のオフライン評価(docs/plans/reviews-465-plan.md §13-3 #7)。
//   npm run eval:review                … 件数と API 呼び出し回数の見込みだけを表示する(呼び出さない)
//   EVAL_RUN=1 npm run eval:review     … 実行する(.env.local の OPENAI_API_KEY を使う)
//   EVAL_SKIP_V1=1 / EVAL_SKIP_VERIFIERS=1 … v1 / 意味検証モデルの比較を省く(2回目以降の評価用)
// 架空の回答(scripts/eval/reviewCases.ts)だけを使う。結果は EVAL_OUT_DIR(既定 .eval-output/、
// git の管理外)に保存する。呼び出しが EVAL_MAX_CALLS を超えそうになったら中止する。
//
// 比べるもの:
//  1. v1 と v2 の下書き(36件): 失敗率・待ち時間・文字数・Linter の指摘・否定的な素材の反映・
//     監査モデル(既定 gpt-4.1)による意味の判定(事実・効果の捏造、極端な感情、否定の反転・弱め)と、
//     読み手としての採点(気持ち・温度感、自然さ、アンケートの要約に見えるか)
//  2. 意味検証モデルの候補: 正解付きの20文で、NG を見つけられた割合・誤って NG にした割合・待ち時間

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "vitest";
import { callOpenAIJson, type CallOpenAIJsonOptions } from "@/lib/ai/openai";
import { sentenceEnding, splitSentences } from "@/lib/ai/naturalJapanese/analyze";
import { generateReviewV1 } from "@/lib/reviewGeneration/legacyV1";
import { buildMaterials, type Material, type MaterialInput } from "@/lib/reviewGeneration/materials";
import { lintPlainDraft, runReviewPipeline, ReviewGenerationError } from "@/lib/reviewGeneration/pipeline";
import { verifySentences, type CallJson } from "@/lib/reviewGeneration/verify";
import type { V1Answer } from "@/lib/reviewGeneration/validateAnswers";
import { OTHER_OPTION_TEXT } from "@/lib/constants";
import { REVIEW_CASES, VERIFICATION_CASES, type ReviewCase } from "./reviewCases";

const RUN = process.env.EVAL_RUN === "1";
const MAX_CALLS = Number.parseInt(process.env.EVAL_MAX_CALLS ?? "", 10) || 400;
const CONCURRENCY = Number.parseInt(process.env.EVAL_CONCURRENCY ?? "", 10) || 3;
const AUDIT_MODEL = process.env.EVAL_AUDIT_MODEL?.trim() || "gpt-4.1";
const VERIFIER_MODELS = (process.env.EVAL_VERIFIER_MODELS ?? "gpt-4o-mini,gpt-4.1-mini,gpt-4.1")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const OUT_DIR = process.env.EVAL_OUT_DIR?.trim() || ".eval-output";
// 2回目以降の評価で、v1 や意味検証モデルの比較を省くとき(前回の結果を使う)。
const SKIP_V1 = process.env.EVAL_SKIP_V1 === "1";
const SKIP_VERIFIERS = process.env.EVAL_SKIP_VERIFIERS === "1";

class CallBudget {
  used = 0;
  take(count = 1) {
    if (this.used + count > MAX_CALLS) {
      throw new Error(`API 呼び出しが上限(${MAX_CALLS}回)を超えるため中止しました`);
    }
    this.used += count;
  }
}

const budget = new CallBudget();

/** 呼び出し回数を数え、意味検証のときだけ model を差し替える呼び出し。 */
function countingCall(verificationModel?: string): CallJson {
  return <T>(options: CallOpenAIJsonOptions) => {
    budget.take();
    const model = options.task === "review_verification" && verificationModel ? verificationModel : options.model;
    return callOpenAIJson<T>({ ...options, model });
  };
}

function toV1Answers(inputs: readonly MaterialInput[]): V1Answer[] {
  return inputs.map((input) => {
    if (input.questionType === "text") return { question: input.questionText, answer: input.freeText ?? "" };
    const values = input.selected.map((v) =>
      v === OTHER_OPTION_TEXT && input.otherDetail ? `${OTHER_OPTION_TEXT}（${input.otherDetail}）` : v,
    );
    return { question: input.questionText, answer: input.questionType === "multiple" ? values : values[0] };
  });
}

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

interface AuditResult {
  sentences: number;
  unsupported: number;
  issues: string[];
}

/** 監査モデルで下書きの各文を、すべての素材と見比べて判定する(v1・v2 で同じ条件)。 */
async function audit(materials: Material[], draft: string): Promise<AuditResult | null> {
  const sentences = splitSentences(draft);
  if (sentences.length === 0) return { sentences: 0, unsupported: 0, issues: [] };
  const ids = materials.map((m) => m.id);
  try {
    const outcome = await verifySentences(countingCall(AUDIT_MODEL), {
      materials,
      sentences: sentences.map((text, index) => ({ index, text, sourceIds: ids })),
      timeoutMs: 30_000,
      temperature: 0,
    });
    const verdicts = [...outcome.verdicts.values()];
    return {
      sentences: sentences.length,
      unsupported: verdicts.filter((v) => !v.supported).length,
      issues: verdicts.flatMap((v) => v.issues),
    };
  } catch {
    return null;
  }
}

interface QualityScore {
  warmth: number;
  naturalness: number;
  surveySummary: boolean;
}

const QUALITY_SCHEMA = {
  name: "review_quality",
  schema: {
    type: "object",
    properties: {
      warmth: { type: "integer" },
      naturalness: { type: "integer" },
      survey_summary: { type: "boolean" },
    },
    required: ["warmth", "naturalness", "survey_summary"],
    additionalProperties: false,
  },
};

const QUALITY_SYSTEM_PROMPT = `あなたは口コミの読み手として採点します。お客様のアンケート回答(素材)と、そこから作った口コミの下書きを読み、次を採点してください。事実の正しさはここでは採点しません。
・warmth(1〜5): 書いた本人の気持ちや受け取り方、温度感が伝わるか(1 = 事実の列挙だけ、5 = 本人が体験を思い返して気持ちを込めて書いたように感じる)
・naturalness(1〜5): 実際のお客様が書いた口コミとして自然か(1 = AI やアンケートの要約に見える、5 = 本人が書いたとしか思えない)
・survey_summary: アンケートの回答を順番に要約・列挙しただけに見えるなら true`;

/** 読み手としての採点(評価だけで使う。本番では使わない)。 */
async function judgeQuality(materials: Material[], draft: string): Promise<QualityScore | null> {
  if (!draft.trim()) return null;
  try {
    const result = await countingCall()<{ warmth: number; naturalness: number; survey_summary: boolean }>({
      task: "review_verification",
      model: AUDIT_MODEL,
      systemPrompt: QUALITY_SYSTEM_PROMPT,
      userPrompt: `【素材】\n${materials.map((m) => `${m.id} ${m.text}`).join("\n")}\n\n【下書き】\n${draft}`,
      schema: QUALITY_SCHEMA,
      temperature: 0,
      maxOutputTokens: 60,
      timeoutMs: 30_000,
    });
    const clamp = (n: number) => Math.min(5, Math.max(1, Math.round(n)));
    return {
      warmth: clamp(result.data.warmth),
      naturalness: clamp(result.data.naturalness),
      surveySummary: result.data.survey_summary === true,
    };
  } catch {
    return null;
  }
}

interface DraftResult {
  ok: boolean;
  draft?: string;
  latencyMs: number;
  errorKind?: string;
  lint: string[];
  audit: AuditResult | null;
  quality: QualityScore | null;
  // v2 だけ
  verifyMode?: string;
  repairAction?: string;
  llmCalls?: number;
  tokens?: number;
  internalLint?: string[];
  verifyFlags?: string[];
}

async function runV1(testCase: ReviewCase, materials: Material[]): Promise<DraftResult> {
  budget.take();
  const startedAt = Date.now();
  const result = await generateReviewV1({ answers: toV1Answers(testCase.answers), businessType: testCase.businessType });
  if (result.ok && result.attempts > 1) budget.take(result.attempts - 1);
  if (!result.ok) return { ok: false, latencyMs: Date.now() - startedAt, errorKind: result.kind, lint: [], audit: null, quality: null };
  return {
    ok: true,
    draft: result.review,
    latencyMs: result.latencyMs,
    lint: lintPlainDraft(result.review, materials),
    audit: await audit(materials, result.review),
    quality: await judgeQuality(materials, result.review),
  };
}

async function runV2(testCase: ReviewCase, materials: Material[]): Promise<DraftResult> {
  const startedAt = Date.now();
  try {
    const result = await runReviewPipeline(
      { materials, businessType: testCase.businessType },
      { callJson: countingCall() },
    );
    return {
      ok: true,
      draft: result.draft,
      latencyMs: result.metadata.latencyMs,
      lint: lintPlainDraft(result.draft, materials),
      audit: await audit(materials, result.draft),
      quality: await judgeQuality(materials, result.draft),
      verifyMode: result.metadata.verifyMode,
      repairAction: result.metadata.repairAction,
      llmCalls: result.metadata.llmCalls,
      tokens: result.metadata.inputTokens + result.metadata.outputTokens,
      internalLint: result.metadata.lintCodes,
      verifyFlags: result.metadata.verifyFlags,
    };
  } catch (err) {
    const errorKind =
      err instanceof ReviewGenerationError ? `${err.kind}${err.causeKind ? `:${err.causeKind}` : ""}` : "unexpected";
    return { ok: false, latencyMs: Date.now() - startedAt, errorKind, lint: [], audit: null, quality: null };
  }
}

// 表示しない扱いになる指摘(v1 と v2 で比べられるもの)。
const BLOCKING_PLAIN_CODES = new Set([
  "factual_invention:situation",
  "factual_invention:number",
  "factual_invention:comparison",
  "factual_invention:visit_count",
  "factual_invention:off_topic",
  "promotional_callout",
  "unsupported_effect:medical",
  "extreme_emotional_exaggeration:extreme",
  "negative_not_reflected",
]);

function summarizeQuality(scores: QualityScore[]) {
  if (scores.length === 0) return null;
  const avg = (f: (q: QualityScore) => number) =>
    Math.round((scores.reduce((sum, q) => sum + f(q), 0) / scores.length) * 100) / 100;
  return {
    judged: scores.length,
    warmthAvg: avg((q) => q.warmth),
    naturalnessAvg: avg((q) => q.naturalness),
    surveySummary: scores.filter((q) => q.surveySummary).length,
  };
}

function summarizeDrafts(results: DraftResult[], cases: readonly ReviewCase[]) {
  const ok = results.filter((r) => r.ok);
  const negativeIndexes = cases.map((c, i) => (c.negative ? i : -1)).filter((i) => i >= 0);
  const negativeReflected = negativeIndexes.filter(
    (i) => results[i].ok && !results[i].lint.includes("negative_not_reflected"),
  ).length;
  const audits = ok.map((r) => r.audit).filter((a): a is AuditResult => a !== null);
  const sentenceCount = audits.reduce((sum, a) => sum + a.sentences, 0);
  const unsupported = audits.reduce((sum, a) => sum + a.unsupported, 0);
  const endings = ok.flatMap((r) => splitSentences(r.draft ?? "").map(sentenceEnding));
  const chars = ok.map((r) => [...(r.draft ?? "").replace(/\s/g, "")].length);
  return {
    cases: results.length,
    failures: results.length - ok.length,
    failureKinds: countBy(results.filter((r) => !r.ok).map((r) => r.errorKind ?? "unknown")),
    latencyP50: percentile(ok.map((r) => r.latencyMs), 50),
    latencyP95: percentile(ok.map((r) => r.latencyMs), 95),
    charsAvg: chars.length ? Math.round(chars.reduce((a, b) => a + b, 0) / chars.length) : null,
    charsMin: chars.length ? Math.min(...chars) : null,
    charsMax: chars.length ? Math.max(...chars) : null,
    lintCounts: countBy(ok.flatMap((r) => r.lint)),
    draftsWithBlockingLint: ok.filter((r) => r.lint.some((c) => BLOCKING_PLAIN_CODES.has(c))).length,
    textureLint: {
      lowEmotionalTexture: ok.filter((r) => r.lint.includes("low_emotional_texture")).length,
      uniformSentenceStructure: ok.filter((r) => r.lint.includes("uniform_sentence_structure")).length,
    },
    quality: summarizeQuality(ok.map((r) => r.quality).filter((q): q is QualityScore => q !== null)),
    negativeCases: negativeIndexes.length,
    negativeReflected,
    auditSentences: sentenceCount,
    auditUnsupported: unsupported,
    auditDraftsWithIssue: audits.filter((a) => a.unsupported > 0).length,
    auditIssueCounts: countBy(audits.flatMap((a) => a.issues)),
    topEndings: Object.fromEntries(Object.entries(countBy(endings)).slice(0, 6)),
  };
}

async function compareVerifiers() {
  const rows = [];
  for (const model of VERIFIER_MODELS) {
    const outcomes = [];
    for (const testCase of VERIFICATION_CASES) {
      const materials = buildMaterials(testCase.answers);
      const startedAt = Date.now();
      try {
        const result = await verifySentences(countingCall(model), {
          materials,
          sentences: [{ index: 0, text: testCase.sentence, sourceIds: materials.map((m) => m.id) }],
          timeoutMs: 20_000,
          temperature: 0,
        });
        const verdict = result.verdicts.get(0);
        outcomes.push({
          id: testCase.id,
          expected: testCase.expectedSupported,
          predicted: verdict?.supported ?? false,
          issues: verdict?.issues ?? [],
          latencyMs: Date.now() - startedAt,
          tokens: (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0),
          error: false,
        });
      } catch {
        outcomes.push({ id: testCase.id, expected: testCase.expectedSupported, predicted: false, issues: [], latencyMs: Date.now() - startedAt, tokens: 0, error: true });
      }
    }
    const shouldReject = outcomes.filter((o) => !o.expected);
    const shouldAccept = outcomes.filter((o) => o.expected);
    rows.push({
      model,
      accuracy: outcomes.filter((o) => o.predicted === o.expected).length / outcomes.length,
      caughtNg: `${shouldReject.filter((o) => !o.predicted).length}/${shouldReject.length}`,
      falseNg: `${shouldAccept.filter((o) => !o.predicted).length}/${shouldAccept.length}`,
      errors: outcomes.filter((o) => o.error).length,
      latencyP50: percentile(outcomes.map((o) => o.latencyMs), 50),
      latencyP95: percentile(outcomes.map((o) => o.latencyMs), 95),
      tokensAvg: Math.round(outcomes.reduce((sum, o) => sum + o.tokens, 0) / outcomes.length),
      misses: outcomes.filter((o) => o.predicted !== o.expected).map((o) => o.id),
    });
  }
  return rows;
}

function estimateCalls() {
  const cases = REVIEW_CASES.length;
  const verifier = SKIP_VERIFIERS ? 0 : VERIFICATION_CASES.length * VERIFIER_MODELS.length;
  const v1 = SKIP_V1 ? 0 : 1;
  // v1: 1(作り直しで最大2)。v2: 作文1〜2・同期検証0〜2・修正0〜1。監査: 下書き1件につき1。
  return {
    cases,
    negativeCases: REVIEW_CASES.filter((c) => c.negative).length,
    verificationCases: VERIFICATION_CASES.length,
    verifierModels: VERIFIER_MODELS,
    auditModel: AUDIT_MODEL,
    skipV1: SKIP_V1,
    skipVerifiers: SKIP_VERIFIERS,
    // 監査と読み手としての採点は、下書き1件につき1回ずつ。
    expectedCalls: cases * v1 + Math.round(cases * 1.9) + cases * (1 + v1) * 2 + verifier,
    worstCaseCalls: cases * 2 * v1 + cases * 6 + cases * (1 + v1) * 2 + verifier,
    maxCalls: MAX_CALLS,
  };
}

describe("口コミ生成のオフライン評価", () => {
  it("v1 と v2、意味検証モデルを比べる", async () => {
    const estimate = estimateCalls();
    console.log("評価の見込み", estimate);
    if (!RUN) {
      console.log("EVAL_RUN=1 を付けると実行します(API を呼び出します)。");
      return;
    }
    if (estimate.worstCaseCalls > MAX_CALLS) {
      console.log(`最悪の場合 ${estimate.worstCaseCalls} 回になりますが、${MAX_CALLS} 回に達したら中止します。`);
    }

    const startedAt = Date.now();
    const perCase = await mapWithConcurrency(REVIEW_CASES, CONCURRENCY, async (testCase) => {
      const materials = buildMaterials(testCase.answers);
      const v1 = SKIP_V1 ? null : await runV1(testCase, materials);
      const v2 = await runV2(testCase, materials);
      return { testCase, v1, v2 };
    });
    const verifiers = SKIP_VERIFIERS ? [] : await compareVerifiers();

    const report = {
      generatedAt: new Date().toISOString(),
      elapsedSec: Math.round((Date.now() - startedAt) / 1000),
      apiCalls: budget.used,
      generationModel: process.env.OPENAI_MODEL,
      verificationModelInV2: process.env.OPENAI_MODEL_REVIEW_VERIFICATION || process.env.OPENAI_MODEL,
      auditModel: AUDIT_MODEL,
      v1: SKIP_V1 ? null : summarizeDrafts(perCase.map((r) => r.v1 as DraftResult), REVIEW_CASES),
      v2: {
        ...summarizeDrafts(perCase.map((r) => r.v2), REVIEW_CASES),
        syncVerifyRate: perCase.filter((r) => r.v2.verifyMode === "sync").length / perCase.length,
        repairActions: countBy(perCase.filter((r) => r.v2.ok).map((r) => r.v2.repairAction ?? "none")),
        llmCallsAvg: perCase.reduce((sum, r) => sum + (r.v2.llmCalls ?? 0), 0) / perCase.length,
        tokensAvg: Math.round(perCase.reduce((sum, r) => sum + (r.v2.tokens ?? 0), 0) / perCase.length),
        internalLintCounts: countBy(perCase.flatMap((r) => r.v2.internalLint ?? [])),
        syncVerifyFlags: countBy(perCase.flatMap((r) => r.v2.verifyFlags ?? [])),
      },
      verifiers,
      samples: perCase.map(({ testCase, v1, v2 }) => ({
        id: testCase.id,
        note: testCase.note,
        negative: testCase.negative,
        v1: v1 ? (v1.ok ? v1.draft : `(失敗: ${v1.errorKind})`) : null,
        v1Audit: v1?.audit?.issues ?? null,
        v2: v2.ok ? v2.draft : `(失敗: ${v2.errorKind})`,
        v2Audit: v2.audit?.issues ?? null,
        v1Quality: v1?.quality ?? null,
        v2Quality: v2.quality,
        v2RepairAction: v2.repairAction,
      })),
    };

    await mkdir(OUT_DIR, { recursive: true });
    const stamp = report.generatedAt.replace(/[:.]/g, "-");
    const file = path.join(OUT_DIR, `review-eval-${stamp}.json`);
    await writeFile(file, JSON.stringify(report, null, 2), "utf8");
    console.log(JSON.stringify({ ...report, samples: `${report.samples.length}件(${file})` }, null, 2));
  });
});
