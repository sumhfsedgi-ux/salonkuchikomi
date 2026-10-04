// 口コミ生成のオフライン評価(docs/plans/reviews-465-plan.md §13-3 #7)。
//   npm run eval:review                … 件数と API 呼び出し回数の見込みだけを表示する(呼び出さない)
//   EVAL_RUN=1 npm run eval:review     … 実行する(.env.local の OPENAI_API_KEY を使う)
//   EVAL_SKIP_V1=1 / EVAL_SKIP_VERIFIERS=1 … v1 / 意味検証モデルの比較を省く(2回目以降の評価用)
//   EVAL_RUN=1 EVAL_REAUDIT=<結果のJSON> … 保存済みの下書きを作り直さず、監査と採点だけをやり直す
// 架空の回答(scripts/eval/reviewCases.ts)だけを使う。結果は EVAL_OUT_DIR(既定 .eval-output/、
// git の管理外)に保存する。呼び出しが EVAL_MAX_CALLS を超えそうになったら中止する。
//
// 比べるもの:
//  1. v1 と v2 の下書き(36件): 失敗率・待ち時間・文字数・Linter の指摘・否定的な素材の反映・
//     監査モデル(既定 gpt-4.1)による意味の判定(事実・効果の捏造、極端な感情、否定の反転・弱め)と、
//     読み手としての採点(自然さ、アンケートの要約に見えるか、引っかかる文、不要な感情語、本人らしさ。
//     scripts/eval/judges.ts)、感嘆符の数の分布
//  v2 と v3 を同じ回答で比べ、20件まとめて見るときは scripts/eval/review-corpus.eval.ts を使う。
//  2. 意味検証モデルの候補: 正解付きの20文で、NG を見つけられた割合・誤って NG にした割合・待ち時間

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "vitest";
import { countExclamations, sentenceEnding, splitSentences } from "@/lib/ai/naturalJapanese/analyze";
import { generateReviewV1 } from "@/lib/reviewGeneration/legacyV1";
import { buildMaterials, type Material, type MaterialInput } from "@/lib/reviewGeneration/materials";
import { lintPlainDraft, runReviewPipeline, ReviewGenerationError } from "@/lib/reviewGeneration/pipeline";
import { verifySentences } from "@/lib/reviewGeneration/verify";
import type { V1Answer } from "@/lib/reviewGeneration/validateAnswers";
import { OTHER_OPTION_TEXT } from "@/lib/constants";
import {
  audit as auditDraft,
  CallBudget,
  countBy,
  countingCall,
  judgeQuality as judgeDraftQuality,
  mapWithConcurrency,
  percentile,
  summarizeQuality,
  type AuditResult,
  type QualityScore,
} from "./judges";
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
const REAUDIT_FILE = process.env.EVAL_REAUDIT?.trim();
const budget = new CallBudget(MAX_CALLS);
const call = (verificationModel?: string) => countingCall(budget, verificationModel);
const audit = (materials: Material[], draft: string) => auditDraft(budget, AUDIT_MODEL, materials, draft);
const judgeQuality = (materials: Material[], draft: string) => judgeDraftQuality(budget, AUDIT_MODEL, materials, draft);

function toV1Answers(inputs: readonly MaterialInput[]): V1Answer[] {
  return inputs.map((input) => {
    if (input.questionType === "text") return { question: input.questionText, answer: input.freeText ?? "" };
    const values = input.selected.map((v) =>
      v === OTHER_OPTION_TEXT && input.otherDetail ? `${OTHER_OPTION_TEXT}（${input.otherDetail}）` : v,
    );
    return { question: input.questionText, answer: input.questionType === "multiple" ? values : values[0] };
  });
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
      { materials, businessType: testCase.businessType, storeDescription: testCase.salonDescription },
      { callJson: call() },
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
      abstractAiSummary: ok.filter((r) => r.lint.some((c) => c.startsWith("abstract_ai_summary"))).length,
      polishedPhrase: ok.filter((r) => r.lint.includes("template_phrase:polished")).length,
      exclamationOveruse: ok.filter((r) => r.lint.includes("exclamation_overuse")).length,
    },
    // 感嘆符の数ごとの下書きの数(なし・1つ・2つ・3つ以上)。
    exclamations: countBy(ok.map((r) => String(Math.min(3, countExclamations(r.draft ?? ""))))),
    quality: summarizeQuality(ok.map((r) => r.quality).filter((q): q is QualityScore => q !== null)),
    negativeCases: negativeIndexes.length,
    negativeReflected,
    // 監査・採点ができなかった下書きの数(0 でなければ、その分だけ比較の母数が減っている)。
    auditMissing: ok.length - audits.length,
    qualityMissing: ok.filter((r) => r.quality === null).length,
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
        const result = await verifySentences(call(model), {
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

interface SavedSample {
  id: string;
  v1: string | null;
  v2: string;
}

/** 保存済みの下書きを、作り直さずに監査・採点し直す(待ち時間や内部の指摘は元の結果を見る)。 */
async function reauditSavedDrafts(file: string) {
  const saved = JSON.parse(await readFile(file, "utf8")) as { samples: SavedSample[]; [key: string]: unknown };
  const judge = async (testCase: ReviewCase, draft: string | null | undefined): Promise<DraftResult | null> => {
    if (draft == null) return null;
    if (draft.startsWith("(失敗")) return { ok: false, latencyMs: 0, errorKind: draft, lint: [], audit: null, quality: null };
    const materials = buildMaterials(testCase.answers);
    return {
      ok: true,
      draft,
      latencyMs: 0,
      lint: lintPlainDraft(draft, materials),
      audit: await audit(materials, draft),
      quality: await judgeQuality(materials, draft),
    };
  };
  const cases = REVIEW_CASES.filter((c) => saved.samples.some((s) => s.id === c.id));
  const perCase = await mapWithConcurrency(cases, CONCURRENCY, async (testCase) => {
    const sample = saved.samples.find((s) => s.id === testCase.id) as SavedSample;
    const v1 = SKIP_V1 ? null : await judge(testCase, sample.v1);
    return { testCase, sample, v1, v2: await judge(testCase, sample.v2) };
  });
  const withoutLatency = (results: (DraftResult | null)[]) => {
    if (results.some((r) => r === null)) return null;
    const { latencyP50, latencyP95, ...rest } = summarizeDrafts(results as DraftResult[], cases);
    void latencyP50;
    void latencyP95;
    return rest;
  };
  return {
    reauditedAt: new Date().toISOString(),
    source: file,
    auditModel: AUDIT_MODEL,
    apiCalls: budget.used,
    generationModel: saved.generationModel,
    v1: withoutLatency(perCase.map((r) => r.v1)),
    v2: withoutLatency(perCase.map((r) => r.v2)),
    samples: perCase.map(({ testCase, sample, v1, v2 }) => ({
      id: testCase.id,
      negative: testCase.negative,
      v1: sample.v1,
      v1Lint: v1?.lint ?? null,
      v1Audit: v1?.audit?.issues ?? null,
      v1Quality: v1?.quality ?? null,
      v2: sample.v2,
      v2Lint: v2?.lint ?? null,
      v2Audit: v2?.audit?.issues ?? null,
      v2Quality: v2?.quality ?? null,
    })),
  };
}

describe("口コミ生成のオフライン評価", () => {
  it("v1 と v2、意味検証モデルを比べる", async () => {
    if (REAUDIT_FILE) {
      console.log("保存済みの下書きを監査・採点し直します", { file: REAUDIT_FILE, auditModel: AUDIT_MODEL });
      if (!RUN) {
        console.log("EVAL_RUN=1 を付けると実行します(下書き1件につき監査と採点の2回、API を呼び出します)。");
        return;
      }
      const report = await reauditSavedDrafts(REAUDIT_FILE);
      await mkdir(OUT_DIR, { recursive: true });
      const out = path.join(OUT_DIR, `review-reaudit-${report.reauditedAt.replace(/[:.]/g, "-")}.json`);
      await writeFile(out, JSON.stringify(report, null, 2), "utf8");
      console.log(JSON.stringify({ ...report, samples: `${report.samples.length}件(${out})` }, null, 2));
      return;
    }
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
      generationModel: process.env.OPENAI_MODEL_REVIEW_GENERATION || process.env.OPENAI_MODEL,
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
