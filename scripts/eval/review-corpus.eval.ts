// 口コミ生成 review-v3 の評価(docs/plans/reviews-465-plan.md §14-7)。
//   npx vitest run --config vitest.eval.config.mts scripts/eval/review-corpus.eval.ts   … 件数と API 呼び出し回数の見込みだけ
//   EVAL_RUN=1 EVAL_STAGE=1 EVAL_BASELINE=<v2 の下書きの JSON> …                         … 実行する
// Stage 1: 架空の回答20件(＋本人の声のケース4件)。Stage 2(EVAL_STAGE=2): すべての架空ケース。
// v2 の下書きは作り直さず、保存したもの(EVAL_BASELINE)を v3 と同じ条件で採点する。
// 架空の回答(scripts/eval/reviewCases.ts)だけを使う。結果は EVAL_OUT_DIR(既定 .eval-output/、git の管理外)。
//
// 見るもの: 1件単体で自然か、回答の要約に見えないか、不要な感情語、同じ締めの繰り返し、
// 20件並べて同じ人に見えないか(Corpus Lint と監査モデルの判定)、本人らしさ、否定的な内容、事実が増えていないか。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "vitest";
import { corpusLint } from "@/lib/ai/naturalJapanese/corpus";
import { buildMaterials, type Material } from "@/lib/reviewGeneration/materials";
import { lintPlainDraft, ReviewGenerationError, runReviewPipeline } from "@/lib/reviewGeneration/pipeline";
import { PROMPT_VERSION } from "@/lib/reviewGeneration/prompts";
import {
  audit,
  CallBudget,
  countBy,
  countingCall,
  judgeCorpus,
  judgeQuality,
  mapWithConcurrency,
  percentile,
  summarizeQuality,
  type AuditResult,
  type QualityScore,
} from "./judges";
import { REVIEW_CASES, type ReviewCase } from "./reviewCases";

const RUN = process.env.EVAL_RUN === "1";
const STAGE = process.env.EVAL_STAGE === "2" ? "2" : "1";
const MAX_CALLS = Number.parseInt(process.env.EVAL_MAX_CALLS ?? "", 10) || 200;
const CONCURRENCY = Number.parseInt(process.env.EVAL_CONCURRENCY ?? "", 10) || 3;
const AUDIT_MODEL = process.env.EVAL_AUDIT_MODEL?.trim() || "gpt-4.1";
const OUT_DIR = process.env.EVAL_OUT_DIR?.trim() || ".eval-output";
const BASELINE_FILE = process.env.EVAL_BASELINE?.trim();

/** Stage 1 の20件(業種・否定的な回答・自由記述が偏らないように選んだもの)。 */
const STAGE1_IDS = [
  "hp-sparse", "hp-reason-effect", "hp-neg-free", "hp-rich", "hp-pores-proposal", "hp-mixed-free",
  "hair-finish", "hair-neg-free", "hair-rich-positive", "es-perception", "es-reason", "es-neg-sales",
  "es-rich", "nail-positive", "nail-neg-free", "nail-other-detail", "ma-reason", "ma-neg-pain",
  "el-positive-rich", "el-mixed",
];
/** 本人の声(Voice Anchor)のケース。v2 の下書きは無いので、v3 だけを見る。 */
const VOICE_IDS = ["hp-voice-casual", "nail-voice-excited", "ma-voice-plain", "hair-voice-neg"];

const budget = new CallBudget(MAX_CALLS);

function targetCases(): ReviewCase[] {
  if (STAGE === "2") return REVIEW_CASES;
  return REVIEW_CASES.filter((c) => STAGE1_IDS.includes(c.id) || VOICE_IDS.includes(c.id));
}

/** 保存済みの v2 の下書き。drafts の配列({id, draft})と、評価結果の samples({id, v2})のどちらでも読む。 */
async function loadBaseline(file: string | undefined): Promise<Map<string, string>> {
  if (!file) return new Map();
  const data = JSON.parse(await readFile(file, "utf8")) as {
    out?: Array<{ id: string; draft: string }>;
    samples?: Array<{ id: string; v2: string }>;
  };
  const rows = data.out?.map((r) => [r.id, r.draft] as const) ?? data.samples?.map((r) => [r.id, r.v2] as const) ?? [];
  return new Map(rows.filter(([, draft]) => typeof draft === "string" && !draft.startsWith("(失敗")));
}

interface Judged {
  id: string;
  draft: string;
  lint: string[];
  audit: AuditResult | null;
  quality: QualityScore | null;
}

async function judgeDraft(testCase: ReviewCase, materials: Material[], draft: string): Promise<Judged> {
  return {
    id: testCase.id,
    draft,
    lint: lintPlainDraft(draft, materials),
    audit: await audit(budget, AUDIT_MODEL, materials, draft),
    quality: await judgeQuality(budget, AUDIT_MODEL, materials, draft),
  };
}

function summarize(results: readonly Judged[], cases: readonly ReviewCase[]) {
  const audits = results.map((r) => r.audit).filter((a): a is AuditResult => a !== null);
  const chars = results.map((r) => [...r.draft.replace(/\s/g, "")].length);
  const negativeIds = new Set(cases.filter((c) => c.negative).map((c) => c.id));
  const negatives = results.filter((r) => negativeIds.has(r.id));
  return {
    drafts: results.length,
    charsAvg: chars.length ? Math.round(chars.reduce((a, b) => a + b, 0) / chars.length) : null,
    quality: summarizeQuality(results.map((r) => r.quality).filter((q): q is QualityScore => q !== null)),
    auditMissing: results.length - audits.length,
    auditDraftsWithIssue: audits.filter((a) => a.unsupported > 0).length,
    auditIssueCounts: countBy(audits.flatMap((a) => a.issues)),
    // 語の一致での目安(活用の違いは漏れと数えることがある)。
    negativeReflected: `${negatives.filter((r) => !r.lint.includes("negative_not_reflected")).length}/${negatives.length}`,
    lintCounts: countBy(results.flatMap((r) => r.lint)),
  };
}

function sourceTextOf(testCase: ReviewCase): string {
  return buildMaterials(testCase.answers).map((m) => m.text).join("\n");
}

async function corpusOf(results: readonly Judged[], caseById: Map<string, ReviewCase>) {
  const drafts = results.map((r) => ({ text: r.draft, sourceText: sourceTextOf(caseById.get(r.id) as ReviewCase) }));
  return { lint: corpusLint(drafts), judgement: await judgeCorpus(budget, AUDIT_MODEL, results.map((r) => r.draft)) };
}

describe("口コミ生成 review-v3 の評価", () => {
  it("v2 と v3 を同じ架空の回答で比べる", async () => {
    const cases = targetCases();
    const baseline = await loadBaseline(BASELINE_FILE);
    const baselineCases = cases.filter((c) => baseline.has(c.id));
    // 作文: 1件につき平均2回弱(構造の作り直し・意味検証・修正で最大4回)。採点: 下書き1件につき監査と採点の2回。
    const estimate = {
      stage: STAGE,
      cases: cases.length,
      baselineDrafts: baselineCases.length,
      expectedCalls: Math.round(cases.length * 1.9) + (cases.length + baselineCases.length) * 2 + 3,
      worstCaseCalls: cases.length * 4 + (cases.length + baselineCases.length) * 2 + 3,
      maxCalls: MAX_CALLS,
      auditModel: AUDIT_MODEL,
    };
    console.log("評価の見込み", estimate);
    if (!RUN) {
      console.log("EVAL_RUN=1 を付けると実行します(API を呼び出します)。");
      return;
    }

    const caseById = new Map(cases.map((c) => [c.id, c]));
    const v3 = await mapWithConcurrency(cases, CONCURRENCY, async (testCase) => {
      const materials = buildMaterials(testCase.answers);
      const startedAt = Date.now();
      try {
        const result = await runReviewPipeline(
          { materials, businessType: testCase.businessType },
          { callJson: countingCall(budget) },
        );
        return {
          ok: true as const,
          judged: await judgeDraft(testCase, materials, result.draft),
          latencyMs: result.metadata.latencyMs,
          seed: result.metadata.styleSeed,
          repairAction: result.metadata.repairAction,
          flags: result.metadata.verifyFlags,
          llmCalls: result.metadata.llmCalls,
        };
      } catch (err) {
        const errorKind = err instanceof ReviewGenerationError ? err.kind : "unexpected";
        return { ok: false as const, id: testCase.id, errorKind, latencyMs: Date.now() - startedAt };
      }
    });
    const v2 = await mapWithConcurrency(baselineCases, CONCURRENCY, (testCase) =>
      judgeDraft(testCase, buildMaterials(testCase.answers), baseline.get(testCase.id) as string),
    );

    const v3Ok = v3.filter((r) => r.ok);
    const v3Judged = v3Ok.map((r) => r.judged);
    // 同じ回答で比べる: v2 の下書きがあり、v3 も作れたケースだけ。
    const comparedIds = new Set(v2.map((r) => r.id).filter((id) => v3Judged.some((r) => r.id === id)));
    const v3Compared = v3Judged.filter((r) => comparedIds.has(r.id));
    const v2Compared = v2.filter((r) => comparedIds.has(r.id));

    const report = {
      generatedAt: new Date().toISOString(),
      stage: STAGE,
      promptVersion: PROMPT_VERSION,
      auditModel: AUDIT_MODEL,
      baselineFile: BASELINE_FILE ?? null,
      apiCalls: budget.used,
      comparedCases: comparedIds.size,
      v3: {
        failures: v3.length - v3Ok.length,
        failureKinds: countBy(v3.filter((r) => !r.ok).map((r) => (r.ok ? "" : r.errorKind))),
        latencyP50: percentile(v3Ok.map((r) => r.latencyMs), 50),
        latencyP95: percentile(v3Ok.map((r) => r.latencyMs), 95),
        llmCallsAvg: v3Ok.length ? Math.round((v3Ok.reduce((s, r) => s + r.llmCalls, 0) / v3Ok.length) * 100) / 100 : null,
        repairActions: countBy(v3Ok.map((r) => r.repairAction)),
        flags: countBy(v3Ok.flatMap((r) => r.flags)),
        compared: summarize(v3Compared, cases),
        all: summarize(v3Judged, cases),
        corpus: await corpusOf(v3Compared, caseById),
      },
      v2: v2Compared.length ? { compared: summarize(v2Compared, cases), corpus: await corpusOf(v2Compared, caseById) } : null,
      samples: cases.map((testCase) => {
        const mine = v3.find((r) => (r.ok ? r.judged.id : r.id) === testCase.id);
        const before = v2.find((r) => r.id === testCase.id);
        return {
          id: testCase.id,
          businessType: testCase.businessType,
          note: testCase.note,
          negative: testCase.negative,
          v2: before?.draft ?? null,
          v2Quality: before?.quality ?? null,
          v2Audit: before?.audit?.issues ?? null,
          v3: mine?.ok ? mine.judged.draft : `(失敗: ${mine && !mine.ok ? mine.errorKind : "unknown"})`,
          v3Seed: mine?.ok ? mine.seed : null,
          v3Flags: mine?.ok ? mine.flags : null,
          v3Quality: mine?.ok ? mine.judged.quality : null,
          v3Audit: mine?.ok ? (mine.judged.audit?.issues ?? null) : null,
        };
      }),
    };

    await mkdir(OUT_DIR, { recursive: true });
    const out = path.join(OUT_DIR, `review-corpus-stage${STAGE}-${report.generatedAt.replace(/[:.]/g, "-")}.json`);
    await writeFile(out, JSON.stringify(report, null, 2), "utf8");
    console.log(`保存しました: ${out}(API 呼び出し ${budget.used}回)`);
  }, 60 * 60 * 1000);
});
