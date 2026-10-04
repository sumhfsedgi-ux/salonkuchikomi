// 口コミの下書きを素材(お客様の回答)と突き合わせて検査する決定的な Linter
// (docs/plans/reviews-465-plan.md §7-1・§13)。
//
// 各文の sourceIds(どの素材をもとに書いたか)は LLM の自己申告でしかなく、意味が
// 正しいことは保証しない。そこで、語彙で判定できる範囲を次の3段階で返す:
//   block … そのままでは表示しない(文を削除するか、修正する)
//   risk  … 同期の意味検証(LLM)にかける。NG・タイムアウトなら block と同じ扱い
//   style … 品質の計測用。表示は止めない
// 語彙の外にある言い換えは見逃すので、risk の判定は広めにしている。

import {
  containsPhrase,
  findPhrases,
  hasPerception,
  bigramOverlap,
  sentenceEnding,
  countChars,
} from "@/lib/ai/naturalJapanese/analyze";
import {
  CHANGE_CLAIM_PHRASES,
  FLIP_PHRASES,
  HONORIFIC_INFLATION_PHRASES,
  MEDICAL_PHRASES,
  OFF_TOPIC_PHRASES,
  RECOMMEND_PHRASES,
  REVISIT_PHRASES,
  SATISFACTION_PHRASES,
  SITUATION_PHRASES,
  SOFTENER_PHRASES,
  STRONG_INTENSIFIERS,
  TEMPLATE_PHRASES,
} from "@/lib/ai/naturalJapanese/phrases";

export interface LintSource {
  id: string;
  text: string;
  /** 否定的な内容を含む(必ずどこかの文に反映し、反転・弱めをしてはいけない)。 */
  negative: boolean;
  /** 「〜ように感じた」などの知覚表現を含む(文にも残っているべき)。 */
  perception: boolean;
  /** 来店理由・希望(結果として書いてはいけない)。 */
  purposeLike: boolean;
  /** 自由記述・「その他」の詳細(本人の言葉なので言い回しを残す)。 */
  ownWords: boolean;
}

export interface LintSentence {
  text: string;
  sourceIds: string[];
}

export interface LintOptions {
  /** 構成プランで主役にした素材。どれも使われていなければ style の指摘にする。 */
  mainSourceIds?: readonly string[];
  /** 全体の文字数の目安。外れたら style の指摘にする。 */
  targetChars?: { min: number; max: number };
}

export type LintSeverity = "block" | "risk" | "style";

export type LintCode =
  // block
  | "empty_draft"
  | "no_source"
  | "unknown_source"
  | "unsupported_satisfaction"
  | "unsupported_revisit"
  | "unsupported_recommend"
  | "fabricated_situation"
  | "medical_claim"
  | "off_topic"
  | "negative_not_reflected"
  // risk
  | "change_claim"
  | "purpose_as_result"
  | "medical_term"
  | "perception_dropped"
  | "polarity_flip"
  | "softened_negative"
  | "strong_intensifier"
  // style
  | "main_not_used"
  | "own_words_paraphrased"
  | "template_phrase"
  | "honorific_inflation"
  | "monotone_endings"
  | "length_out_of_range";

const SEVERITY: Record<LintCode, LintSeverity> = {
  empty_draft: "block",
  no_source: "block",
  unknown_source: "block",
  unsupported_satisfaction: "block",
  unsupported_revisit: "block",
  unsupported_recommend: "block",
  fabricated_situation: "block",
  medical_claim: "block",
  off_topic: "block",
  negative_not_reflected: "block",
  change_claim: "risk",
  purpose_as_result: "risk",
  medical_term: "risk",
  perception_dropped: "risk",
  polarity_flip: "risk",
  softened_negative: "risk",
  strong_intensifier: "risk",
  main_not_used: "style",
  own_words_paraphrased: "style",
  template_phrase: "style",
  honorific_inflation: "style",
  monotone_endings: "style",
  length_out_of_range: "style",
};

export interface LintIssue {
  code: LintCode;
  severity: LintSeverity;
  /** 文単位の指摘なら文の番号(0始まり)。全体への指摘なら null。 */
  sentenceIndex: number | null;
  /** 素材に関する指摘なら、その素材ID。 */
  sourceId?: string;
}

/** 意味検証にかけるかどうかの判断材料(指摘とは別に、文の性質として返す)。 */
export interface SentenceTraits {
  /** 否定的な素材を出典にしている。 */
  citesNegative: boolean;
  /** 効果・変化・医療の語を含む(素材にあっても、強め方によっては誇張になる)。 */
  hasClaimVocabulary: boolean;
}

export interface LintResult {
  issues: LintIssue[];
  traits: SentenceTraits[];
}

// 本人の言い回しがこの割合より残っていなければ、言い換えすぎとみなす。
const OWN_WORDS_MIN_OVERLAP = 0.3;
// 同じ語尾がこの数だけ続いたら単調とみなす。
const MONOTONE_RUN = 3;
// 丁寧語のインフレは、この数以上で指摘する(1回なら普通の口コミにもある)。
const HONORIFIC_MIN_COUNT = 2;

function issue(code: LintCode, sentenceIndex: number | null, sourceId?: string): LintIssue {
  return sourceId === undefined
    ? { code, severity: SEVERITY[code], sentenceIndex }
    : { code, severity: SEVERITY[code], sentenceIndex, sourceId };
}

/** phrases のうち sentence に出てきて、どの素材にも出てこない語。 */
function unsupportedPhrases(sentence: string, phrases: readonly string[], supportText: string): string[] {
  return findPhrases(sentence, phrases).filter((phrase) => !containsPhrase(supportText, phrase));
}

export function lintDraft(
  sentences: readonly LintSentence[],
  sources: readonly LintSource[],
  options: LintOptions = {},
): LintResult {
  const issues: LintIssue[] = [];
  const traits: SentenceTraits[] = [];
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const allSourceText = sources.map((s) => s.text).join("\n");

  if (sentences.length === 0) {
    issues.push(issue("empty_draft", null));
    return { issues, traits };
  }

  sentences.forEach((sentence, index) => {
    const cited = sentence.sourceIds
      .map((id) => sourceById.get(id))
      .filter((s): s is LintSource => s !== undefined);
    const citedText = cited.map((s) => s.text).join("\n");
    const citesNegative = cited.some((s) => s.negative);
    const text = sentence.text;

    if (sentence.sourceIds.length === 0) issues.push(issue("no_source", index));
    if (cited.length < sentence.sourceIds.length) issues.push(issue("unknown_source", index));

    // ── 回答に根拠が無いのに足された内容(block) ──
    if (unsupportedPhrases(text, SATISFACTION_PHRASES, allSourceText).length > 0) {
      issues.push(issue("unsupported_satisfaction", index));
    }
    if (unsupportedPhrases(text, REVISIT_PHRASES, allSourceText).length > 0) {
      issues.push(issue("unsupported_revisit", index));
    }
    if (unsupportedPhrases(text, RECOMMEND_PHRASES, allSourceText).length > 0) {
      issues.push(issue("unsupported_recommend", index));
    }
    if (unsupportedPhrases(text, SITUATION_PHRASES, allSourceText).length > 0) {
      issues.push(issue("fabricated_situation", index));
    }
    if (unsupportedPhrases(text, OFF_TOPIC_PHRASES, allSourceText).length > 0) {
      issues.push(issue("off_topic", index));
    }

    const medical = findPhrases(text, MEDICAL_PHRASES);
    if (medical.some((phrase) => !containsPhrase(allSourceText, phrase))) {
      issues.push(issue("medical_claim", index));
    } else if (medical.length > 0) {
      issues.push(issue("medical_term", index));
    }

    // ── 意味が強くなっている・変わっている疑い(risk) ──
    const claims = findPhrases(text, CHANGE_CLAIM_PHRASES);
    if (claims.some((phrase) => !containsPhrase(citedText, phrase))) {
      issues.push(issue("change_claim", index));
    }
    if (claims.length > 0 && cited.some((s) => s.purposeLike)) {
      issues.push(issue("purpose_as_result", index));
    }
    if (cited.some((s) => s.perception) && !hasPerception(text)) {
      issues.push(issue("perception_dropped", index));
    }
    if (unsupportedPhrases(text, STRONG_INTENSIFIERS, allSourceText).length > 0) {
      issues.push(issue("strong_intensifier", index));
    }

    for (const source of cited.filter((s) => s.negative)) {
      if (unsupportedPhrases(text, FLIP_PHRASES, source.text).length > 0) {
        issues.push(issue("polarity_flip", index, source.id));
      }
      // 否定的な内容と同じ文で満足を言うのは「〜けど大満足」型の打ち消しになりやすい
      // (本人がその素材の中で両方書いている場合は除く)。
      const softeners = unsupportedPhrases(text, SOFTENER_PHRASES, source.text);
      const satisfaction = unsupportedPhrases(text, SATISFACTION_PHRASES, source.text);
      if (softeners.length > 0 || satisfaction.length > 0) {
        issues.push(issue("softened_negative", index, source.id));
      }
    }

    // ── 品質(style) ──
    if (findPhrases(text, TEMPLATE_PHRASES).length > 0) issues.push(issue("template_phrase", index));

    traits.push({
      citesNegative,
      hasClaimVocabulary: claims.length > 0 || medical.length > 0,
    });
  });

  // ── 下書き全体 ──
  const citedIds = new Set(sentences.flatMap((s) => s.sourceIds));
  for (const source of sources) {
    if (source.negative && !citedIds.has(source.id)) {
      issues.push(issue("negative_not_reflected", null, source.id));
    }
  }

  const mainIds = options.mainSourceIds ?? [];
  if (mainIds.length > 0 && !mainIds.some((id) => citedIds.has(id))) {
    issues.push(issue("main_not_used", null));
  }

  for (const source of sources) {
    if (!source.ownWords || !citedIds.has(source.id)) continue;
    const citingText = sentences
      .filter((s) => s.sourceIds.includes(source.id))
      .map((s) => s.text)
      .join("");
    if (bigramOverlap(source.text, citingText) < OWN_WORDS_MIN_OVERLAP) {
      issues.push(issue("own_words_paraphrased", null, source.id));
    }
  }

  const draftText = sentences.map((s) => s.text).join("");
  const honorificCount = findPhrases(draftText, HONORIFIC_INFLATION_PHRASES).length;
  if (honorificCount >= HONORIFIC_MIN_COUNT) issues.push(issue("honorific_inflation", null));

  let run = 1;
  for (let i = 1; i < sentences.length; i++) {
    run = sentenceEnding(sentences[i].text) === sentenceEnding(sentences[i - 1].text) ? run + 1 : 1;
    if (run >= MONOTONE_RUN) {
      issues.push(issue("monotone_endings", null));
      break;
    }
  }

  if (options.targetChars) {
    const chars = countChars(draftText);
    if (chars < options.targetChars.min || chars > options.targetChars.max) {
      issues.push(issue("length_out_of_range", null));
    }
  }

  return { issues, traits };
}

/** そのままでは表示しない文(block の指摘がある文)。 */
export function blockedSentenceIndexes(result: LintResult): number[] {
  return uniqueSorted(
    result.issues
      .filter((i) => i.severity === "block" && i.sentenceIndex !== null)
      .map((i) => i.sentenceIndex as number),
  );
}

/** risk の指摘がある文。 */
export function riskySentenceIndexes(result: LintResult): number[] {
  return uniqueSorted(
    result.issues
      .filter((i) => i.severity === "risk" && i.sentenceIndex !== null)
      .map((i) => i.sentenceIndex as number),
  );
}

/** 全体に対する block の指摘(否定的な素材が反映されていない、下書きが空など)。 */
export function documentBlockIssues(result: LintResult): LintIssue[] {
  return result.issues.filter((i) => i.severity === "block" && i.sentenceIndex === null);
}

/** 記録用の指摘コード一覧(重複なし)。文や素材の内容は含めない。 */
export function lintCodes(result: LintResult): LintCode[] {
  return [...new Set(result.issues.map((i) => i.code))];
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}
