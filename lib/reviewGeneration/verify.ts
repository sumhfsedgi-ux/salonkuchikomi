// 口コミ下書きの意味検証(docs/plans/reviews-465-plan.md §7-1 方式C)。
// 文章を作るためではなく、各文が素材から言えるか(意味が強くなっていないか・
// 否定が反転していないか・回答に無い満足表現が無いか)を判定するためだけに使う。
// 結果が返ってこなかった文は「確認できなかった」として NG にする(fail-closed)。

import type { CallOpenAIJsonOptions, OpenAIJsonResult, OpenAIUsage } from "@/lib/ai/openai";
import type { Material } from "@/lib/reviewGeneration/materials";
import {
  buildVerificationUserPrompt,
  VERIFICATION_ISSUES,
  VERIFICATION_SCHEMA,
  VERIFICATION_SYSTEM_PROMPT,
  type RawVerification,
  type VerificationIssue,
} from "@/lib/reviewGeneration/prompts";

export type CallJson = <T>(options: CallOpenAIJsonOptions) => Promise<OpenAIJsonResult<T>>;

export interface SentenceToVerify {
  index: number;
  text: string;
  sourceIds: string[];
}

export interface VerificationVerdict {
  supported: boolean;
  issues: VerificationIssue[];
}

export interface VerificationOutcome {
  verdicts: Map<number, VerificationVerdict>;
  model: string;
  usage: OpenAIUsage | null;
  latencyMs: number;
}

const KNOWN_ISSUES = new Set<string>(VERIFICATION_ISSUES);

export async function verifySentences(
  callJson: CallJson,
  params: {
    materials: readonly Material[];
    sentences: readonly SentenceToVerify[];
    timeoutMs: number;
    temperature?: number;
  },
): Promise<VerificationOutcome> {
  const result = await callJson<RawVerification>({
    task: "review_verification",
    systemPrompt: VERIFICATION_SYSTEM_PROMPT,
    userPrompt: buildVerificationUserPrompt(params.materials, params.sentences),
    schema: VERIFICATION_SCHEMA,
    temperature: params.temperature,
    maxOutputTokens: 150 + 60 * params.sentences.length,
    timeoutMs: params.timeoutMs,
  });

  const requested = new Set(params.sentences.map((s) => s.index));
  const verdicts = new Map<number, VerificationVerdict>();
  for (const row of result.data.results ?? []) {
    if (!requested.has(row.sentence) || verdicts.has(row.sentence)) continue;
    const issues = (row.issues ?? []).filter((i): i is VerificationIssue => KNOWN_ISSUES.has(i));
    // supported と issues が食い違っていたら、安全側(NG)に倒す。
    verdicts.set(row.sentence, { supported: row.supported === true && issues.length === 0, issues });
  }
  for (const sentence of params.sentences) {
    if (!verdicts.has(sentence.index)) verdicts.set(sentence.index, { supported: false, issues: [] });
  }
  return { verdicts, model: result.model, usage: result.usage, latencyMs: result.latencyMs };
}
