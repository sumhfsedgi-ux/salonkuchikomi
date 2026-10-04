// オフライン評価の共通部品(呼び出し回数の上限、監査、読み手としての採点、20件まとめての判定)。
// 評価だけで使う。本番の生成では使わない。架空の回答(reviewCases.ts)だけを渡す。

import { callOpenAIJson, type CallOpenAIJsonOptions } from "@/lib/ai/openai";
import { splitSentences } from "@/lib/ai/naturalJapanese/analyze";
import type { Material } from "@/lib/reviewGeneration/materials";
import { describeMaterial } from "@/lib/reviewGeneration/prompts";
import { verifySentences, type CallJson } from "@/lib/reviewGeneration/verify";

// 監査・採点の呼び出しが失敗したとき(429 など)に、間を空けてやり直す回数と間隔。
const JUDGE_RETRIES = 2;
const JUDGE_RETRY_DELAY_MS = 5_000;

export class CallBudget {
  used = 0;
  constructor(readonly max: number) {}
  take(count = 1) {
    if (this.used + count > this.max) {
      throw new Error(`API 呼び出しが上限(${this.max}回)を超えるため中止しました`);
    }
    this.used += count;
  }
}

/** 呼び出し回数を数え、意味検証のときだけ model を差し替える呼び出し。 */
export function countingCall(budget: CallBudget, verificationModel?: string): CallJson {
  return <T>(options: CallOpenAIJsonOptions) => {
    budget.take();
    const model = options.task === "review_verification" && verificationModel ? verificationModel : options.model;
    return callOpenAIJson<T>({ ...options, model });
  };
}

export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

/** 監査・採点を、失敗したら間を空けてやり直す(失敗した分を抜いて集計すると、比較が偏るため)。 */
export async function withJudgeRetry<T>(fn: () => Promise<T>): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch {
      if (attempt >= JUDGE_RETRIES) return null;
      await new Promise((resolve) => setTimeout(resolve, JUDGE_RETRY_DELAY_MS * (attempt + 1)));
    }
  }
}

export interface AuditResult {
  sentences: number;
  unsupported: number;
  issues: string[];
}

/** 監査モデルで下書きの各文を、すべての素材と見比べて判定する(どの版でも同じ条件)。 */
export async function audit(budget: CallBudget, auditModel: string, materials: Material[], draft: string): Promise<AuditResult | null> {
  const sentences = splitSentences(draft);
  if (sentences.length === 0) return { sentences: 0, unsupported: 0, issues: [] };
  const ids = materials.map((m) => m.id);
  return withJudgeRetry(async () => {
    const outcome = await verifySentences(countingCall(budget, auditModel), {
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
  });
}

export interface QualityScore {
  naturalness: number;
  surveySummary: boolean;
  awkwardConnection: boolean;
  unnecessaryEmotion: boolean;
  voiceKept: boolean;
}

const QUALITY_SCHEMA = {
  name: "review_quality",
  schema: {
    type: "object",
    properties: {
      naturalness: { type: "integer" },
      survey_summary: { type: "boolean" },
      awkward_connection: { type: "boolean" },
      unnecessary_emotion: { type: "boolean" },
      voice_kept: { type: "boolean" },
    },
    required: ["naturalness", "survey_summary", "awkward_connection", "unnecessary_emotion", "voice_kept"],
    additionalProperties: false,
  },
};

const QUALITY_SYSTEM_PROMPT = `あなたは口コミの読み手として採点します。お客様のアンケート回答(素材)と、そこから作った口コミの下書きを読み、次を採点してください。事実の正しさはここでは採点しません。
・naturalness(1〜5): 一般のお客様がスマホで書いたGoogle口コミとして、1件単体で自然か(1 = AI やアンケートの要約に見える、5 = 本人が書いたとしか思えない)。短い・結論が無い・感情の言葉が無い・ただの事実の文が混ざる・口語的、は減点しない。整いすぎた作文、最後だけきれいに総括する文、回答を詰め込んだ文、字数を埋めるための水増しは減点する。
・survey_summary: アンケートの回答を順番に要約・列挙しただけに見えるなら true
・awkward_connection: 読んでいて引っかかる文があるなら true(別々の回答を無理に1文につなげている、前後の関係があいまい、気持ちが何に対するものか分かりにくい、同じ内容を2回書いている など)
・unnecessary_emotion: 事実ごとに「嬉しかった」「よかった」「安心した」などの気持ちを付けている、など不要な感情の言葉があるなら true
・voice_kept: [本人の言葉] の素材があるとき、その人の語彙・くだけ具合・「！」「笑」などの言い回しが下書きに残っているなら true(綺麗に言い換えられていれば false)。[本人の言葉] の素材が無いときは true`;

/** 読み手としての採点(評価だけで使う。本番では使わない)。 */
export async function judgeQuality(
  budget: CallBudget,
  auditModel: string,
  materials: Material[],
  draft: string,
): Promise<QualityScore | null> {
  if (!draft.trim()) return null;
  return withJudgeRetry(async () => {
    const result = await countingCall(budget)<{
      naturalness: number;
      survey_summary: boolean;
      awkward_connection: boolean;
      unnecessary_emotion: boolean;
      voice_kept: boolean;
    }>({
      task: "review_verification",
      model: auditModel,
      systemPrompt: QUALITY_SYSTEM_PROMPT,
      userPrompt: `【素材】\n${materials.map(describeMaterial).join("\n")}\n\n【下書き】\n${draft}`,
      schema: QUALITY_SCHEMA,
      temperature: 0,
      maxOutputTokens: 120,
      timeoutMs: 30_000,
    });
    return {
      naturalness: Math.min(5, Math.max(1, Math.round(result.data.naturalness))),
      surveySummary: result.data.survey_summary === true,
      awkwardConnection: result.data.awkward_connection === true,
      unnecessaryEmotion: result.data.unnecessary_emotion === true,
      voiceKept: result.data.voice_kept === true,
    };
  });
}

export function summarizeQuality(scores: readonly QualityScore[]) {
  if (scores.length === 0) return null;
  return {
    judged: scores.length,
    naturalnessAvg: Math.round((scores.reduce((sum, q) => sum + q.naturalness, 0) / scores.length) * 100) / 100,
    surveySummary: scores.filter((q) => q.surveySummary).length,
    awkwardConnection: scores.filter((q) => q.awkwardConnection).length,
    unnecessaryEmotion: scores.filter((q) => q.unnecessaryEmotion).length,
    voiceNotKept: scores.filter((q) => !q.voiceKept).length,
  };
}

export interface CorpusJudgement {
  /** 1 = 明らかに同じ書き手・同じ型の繰り返し、5 = 別々の人が書いたように見える。 */
  differentWriters: number;
  repeatedPatterns: string[];
}

const CORPUS_SCHEMA = {
  name: "review_corpus",
  schema: {
    type: "object",
    properties: {
      different_writers: { type: "integer" },
      repeated_patterns: { type: "array", items: { type: "string" } },
    },
    required: ["different_writers", "repeated_patterns"],
    additionalProperties: false,
  },
};

const CORPUS_SYSTEM_PROMPT = `あなたは口コミを読み比べる担当です。別々のお客様が書いたはずの、Google口コミの下書きがまとめて並んでいます(店舗・業種はばらばらです)。
並べて読んだときに、同じ人(または同じテンプレート)が書いたように見えるかを判定してください。
・different_writers(1〜5): 1 = 明らかに同じ書き手・同じ型の繰り返しに見える、5 = 別々の人が書いたように見える
・repeated_patterns: 目立つ繰り返し(同じ締め、同じ書き出し、同じ言い回し、同じ文の組み立て、毎回付く感情の言葉 など)を、短い言葉で最大5つ。無ければ空`;

/** 下書きをまとめて読ませ、同じ人が書いたように見えるかを判定する(1回の呼び出し)。 */
export async function judgeCorpus(budget: CallBudget, auditModel: string, drafts: readonly string[]): Promise<CorpusJudgement | null> {
  if (drafts.length === 0) return null;
  return withJudgeRetry(async () => {
    const result = await countingCall(budget)<{ different_writers: number; repeated_patterns: string[] }>({
      task: "review_verification",
      model: auditModel,
      systemPrompt: CORPUS_SYSTEM_PROMPT,
      userPrompt: drafts.map((d, i) => `(${i + 1}) ${d.replace(/\n/g, " ")}`).join("\n"),
      schema: CORPUS_SCHEMA,
      temperature: 0,
      maxOutputTokens: 300,
      timeoutMs: 60_000,
    });
    return {
      differentWriters: Math.min(5, Math.max(1, Math.round(result.data.different_writers))),
      repeatedPatterns: result.data.repeated_patterns.slice(0, 5),
    };
  });
}
