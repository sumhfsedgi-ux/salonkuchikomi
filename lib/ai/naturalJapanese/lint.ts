// 口コミの下書きを素材(お客様の回答)と突き合わせて検査する決定的な Linter
// (docs/plans/reviews-465-plan.md §7-1・§13)。
//
// 2026-10-04 の方針: 事実は作らない。ただし感情・温度感・主観的な反応は、回答と矛盾しない
// 範囲で補ってよい。そのため「回答より感情が強いか」は判定せず、次を判定する:
//   factual_invention               … 回答に無い具体的な事実(状況・数値・期間・金額・他店比較・来店回数 など)
//   unsupported_effect              … 回答に無い効果・改善、「感じた」の断定、来店理由を結果にする、医療的な表現
//   extreme_emotional_exaggeration  … 回答に対して極端すぎる感情(大感動・人生が変わった・絶対おすすめ など)
//   robotic_survey_summary          … アンケートを質問の順に要約しただけ
//   low_emotional_texture           … 事実の列挙だけで、体験者の主観がほとんど無い
//   uniform_sentence_structure      … 文型・語尾・文の長さが均一
// 軽い感情の補完(嬉しかった・よかった・印象に残った など)は指摘しない。
//
// 各文の sourceIds(どの素材をもとに書いたか)は LLM の自己申告でしかなく、意味が正しいことは
// 保証しない。そこで、語彙で判定できる範囲を次の3段階で返す:
//   block … そのままでは表示しない(文を削除するか、修正する)
//   risk  … 同期の意味検証(LLM)にかける。NG・タイムアウトなら block と同じ扱い
//   style … 品質の判定。表示は止めない(全体の質が低ければ、パイプラインが1回だけ書き直す)

import {
  bigramOverlap,
  containsPhrase,
  countChars,
  findPhrases,
  hasPerception,
  normalize,
  sentenceEnding,
} from "@/lib/ai/naturalJapanese/analyze";
import {
  ASPECT_PHRASES,
  CALLOUT_PHRASES,
  CHANGE_CLAIM_PHRASES,
  COMPARISON_PHRASES,
  EXTREME_EMOTION_PHRASES,
  FIRST_VISIT_PHRASES,
  FLIP_PHRASES,
  HONORIFIC_INFLATION_PHRASES,
  MEDICAL_PHRASES,
  OFF_TOPIC_PHRASES,
  OUTCOME_PHRASES,
  OVERALL_POSITIVE_PHRASES,
  SATISFACTION_PHRASES,
  SITUATION_PHRASES,
  SOFTENER_PHRASES,
  STRONG_EMOTION_PHRASES,
  SUBJECTIVE_MARKERS,
  TEMPLATE_PHRASES,
  VISIT_FACT_PHRASES,
} from "@/lib/ai/naturalJapanese/phrases";

export interface LintSource {
  id: string;
  text: string;
  /** 否定的な内容を含む(必ずどこかの文に反映し、反転・弱めをしてはいけない)。 */
  negative: boolean;
  /** 「〜ように感じた」などの知覚表現を含む(効果として断定してはいけない)。 */
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
  // 文として成り立っているか
  | "empty_draft"
  | "no_source"
  | "unknown_source"
  | "fragment"
  | "ungrammatical"
  // 事実・効果・感情の強さ
  | "factual_invention"
  | "unsupported_effect"
  | "extreme_emotional_exaggeration"
  | "promotional_callout"
  // 否定的な内容
  | "negative_not_reflected"
  | "polarity_flip"
  | "softened_negative"
  // 人間らしさ・品質
  | "robotic_survey_summary"
  | "low_emotional_texture"
  | "uniform_sentence_structure"
  | "main_not_used"
  | "own_words_paraphrased"
  | "template_phrase"
  | "honorific_inflation"
  | "length_out_of_range";

/** 指摘の細目(記録・修正の依頼に使う)。 */
export type LintDetail =
  | "situation"
  | "number"
  | "comparison"
  | "visit_count"
  | "off_topic"
  | "aspect"
  | "outcome"
  | "medical"
  | "medical_term"
  | "change_claim"
  | "perception_dropped"
  | "purpose_as_result"
  | "extreme"
  | "strong";

export interface LintIssue {
  code: LintCode;
  severity: LintSeverity;
  /** 文単位の指摘なら文の番号(0始まり)。全体への指摘なら null。 */
  sentenceIndex: number | null;
  /** 素材に関する指摘なら、その素材ID。 */
  sourceId?: string;
  detail?: LintDetail;
}

/** 意味検証にかけるかどうかの判断材料(指摘とは別に、文の性質として返す)。 */
export interface SentenceTraits {
  /** 否定的な素材を出典にしている。 */
  citesNegative: boolean;
  /** 効果・変化・医療の語を含む(素材にあっても、断定のしかたによっては捏造になる)。 */
  hasClaimVocabulary: boolean;
}

export interface LintResult {
  issues: LintIssue[];
  traits: SentenceTraits[];
}

// 本人の言い回しがこの割合より残っていなければ、言い換えすぎとみなす。
const OWN_WORDS_MIN_OVERLAP = 0.3;
// 同じ語尾がこの数だけ続いたら均一とみなす。
const MONOTONE_RUN = 3;
// 文の長さのばらつき(変動係数)がこれ未満なら均一とみなす(3文以上のとき)。
const MIN_LENGTH_VARIATION = 0.15;
// 選択肢の言葉とこの割合以上重なる文は、選択肢をそのまま写した文とみなす。
const COPIED_CHOICE_OVERLAP = 0.7;
// 丁寧語のインフレは、この数以上で指摘する(1回なら普通の口コミにもある)。
const HONORIFIC_MIN_COUNT = 2;
// 句読点を除いてこれより短い文は、文になっていない断片とみなす(「ニキビ。」など)。
const MIN_SENTENCE_CHARS = 5;
// 明らかな文法の崩れ(「見えたです」「でしたです」など。「良かったです」は正しいので除く)。
const UNGRAMMATICAL_PATTERN = /[^っ]たです|ですです|ますです/u;
const PUNCTUATION = /[。．、,！？!?「」『』（）()…・〜~ー\s]/gu;
// 数値・期間・金額(「3週間」「2回目」「5000円」など)。漢数字は慣用句(十分・一番 など)を避けて単位を絞る。
const NUMBER_PATTERN =
  /[0-9０-９]+(?:[.,][0-9０-９]+)?\s*(?:日|週間|週|か月|ヶ月|カ月|ヵ月|ケ月|年|回目|回|円|分|時間|秒|%|％|倍|本|枚|kg|cm)|[一二三四五六七八九十百千万]+(?:週間|か月|ヶ月|カ月|ヵ月|ケ月|年|円)/gu;

function issue(
  code: LintCode,
  severity: LintSeverity,
  sentenceIndex: number | null,
  extra: { sourceId?: string; detail?: LintDetail } = {},
): LintIssue {
  return { code, severity, sentenceIndex, ...extra };
}

/** phrases のうち sentence に出てきて、supportText に出てこない語。 */
function unsupportedPhrases(sentence: string, phrases: readonly string[], supportText: string): string[] {
  return findPhrases(sentence, phrases).filter((phrase) => !containsPhrase(supportText, phrase));
}

function unsupportedNumbers(sentence: string, supportText: string): string[] {
  const matches = normalize(sentence).match(NUMBER_PATTERN) ?? [];
  return matches.filter((n) => !containsPhrase(supportText, n));
}

function hasSubjectiveMarker(text: string): boolean {
  return findPhrases(text, SUBJECTIVE_MARKERS).length > 0;
}

function materialNumber(id: string): number {
  return Number.parseInt(id.replace(/^M/, ""), 10);
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
  const firstVisit = findPhrases(allSourceText, FIRST_VISIT_PHRASES).length > 0;
  const hasNegative = sources.some((s) => s.negative);

  if (sentences.length === 0) {
    issues.push(issue("empty_draft", "block", null));
    return { issues, traits };
  }

  sentences.forEach((sentence, index) => {
    const cited = sentence.sourceIds
      .map((id) => sourceById.get(id))
      .filter((s): s is LintSource => s !== undefined);
    const citedText = cited.map((s) => s.text).join("\n");
    const citesNegative = cited.some((s) => s.negative);
    const text = sentence.text;

    // ── 文として成り立っているか(block) ──
    if (sentence.sourceIds.length === 0) issues.push(issue("no_source", "block", index));
    if (cited.length < sentence.sourceIds.length) issues.push(issue("unknown_source", "block", index));
    if ([...text.replace(PUNCTUATION, "")].length < MIN_SENTENCE_CHARS) issues.push(issue("fragment", "block", index));
    if (UNGRAMMATICAL_PATTERN.test(text)) issues.push(issue("ungrammatical", "block", index));

    // ── 回答に無い具体的な事実(block。来店回数が分からないときだけ risk) ──
    if (unsupportedPhrases(text, SITUATION_PHRASES, allSourceText).length > 0) {
      issues.push(issue("factual_invention", "block", index, { detail: "situation" }));
    }
    if (unsupportedNumbers(text, allSourceText).length > 0) {
      issues.push(issue("factual_invention", "block", index, { detail: "number" }));
    }
    if (unsupportedPhrases(text, COMPARISON_PHRASES, allSourceText).length > 0) {
      issues.push(issue("factual_invention", "block", index, { detail: "comparison" }));
    }
    if (unsupportedPhrases(text, OFF_TOPIC_PHRASES, allSourceText).length > 0) {
      issues.push(issue("factual_invention", "block", index, { detail: "off_topic" }));
    }
    if (unsupportedPhrases(text, VISIT_FACT_PHRASES, allSourceText).length > 0) {
      // 初めての来店と答えているのに「何度も」「いつも」などは矛盾。回数が分からなければ意味検証に任せる。
      issues.push(issue("factual_invention", firstVisit ? "block" : "risk", index, { detail: "visit_count" }));
    }
    // 回答に無い観点(雰囲気・スタッフ・料金 など)や仕上がりの評価は、気持ちの補完に見えて事実の捏造に
    // なりやすい。言い換えとして正しいこともあるので、意味検証で回答と比べる。
    if (unsupportedPhrases(text, ASPECT_PHRASES, allSourceText).length > 0) {
      issues.push(issue("factual_invention", "risk", index, { detail: "aspect" }));
    }
    if (unsupportedPhrases(text, OUTCOME_PHRASES, allSourceText).length > 0) {
      issues.push(issue("factual_invention", "risk", index, { detail: "outcome" }));
    }
    if (unsupportedPhrases(text, CALLOUT_PHRASES, allSourceText).length > 0) {
      issues.push(issue("promotional_callout", "block", index));
    }

    // ── 回答に無い効果・改善 ──
    const medical = findPhrases(text, MEDICAL_PHRASES);
    if (medical.some((phrase) => !containsPhrase(allSourceText, phrase))) {
      issues.push(issue("unsupported_effect", "block", index, { detail: "medical" }));
    } else if (medical.length > 0) {
      issues.push(issue("unsupported_effect", "risk", index, { detail: "medical_term" }));
    }
    const claims = findPhrases(text, CHANGE_CLAIM_PHRASES);
    if (claims.some((phrase) => !containsPhrase(citedText, phrase))) {
      issues.push(issue("unsupported_effect", "risk", index, { detail: "change_claim" }));
    }
    if (claims.length > 0 && cited.some((s) => s.purposeLike)) {
      issues.push(issue("unsupported_effect", "risk", index, { detail: "purpose_as_result" }));
    }
    if (cited.some((s) => s.perception) && !hasPerception(text)) {
      issues.push(issue("unsupported_effect", "risk", index, { detail: "perception_dropped" }));
    }

    // ── 極端な感情(極端なら block、強めなら意味検証で回答と比べる) ──
    if (unsupportedPhrases(text, EXTREME_EMOTION_PHRASES, allSourceText).length > 0) {
      issues.push(issue("extreme_emotional_exaggeration", "block", index, { detail: "extreme" }));
    } else if (unsupportedPhrases(text, STRONG_EMOTION_PHRASES, allSourceText).length > 0) {
      issues.push(issue("extreme_emotional_exaggeration", "risk", index, { detail: "strong" }));
    }

    // ── 否定的な内容の反転・弱め(risk) ──
    for (const source of cited.filter((s) => s.negative)) {
      if (unsupportedPhrases(text, FLIP_PHRASES, source.text).length > 0) {
        issues.push(issue("polarity_flip", "risk", index, { sourceId: source.id }));
      }
      // 否定的な内容と同じ文で満足を言うのは「〜けど大満足」型の打ち消しになりやすい
      // (本人がその素材の中で両方書いている場合は除く)。
      const softeners = unsupportedPhrases(text, SOFTENER_PHRASES, source.text);
      const satisfaction = unsupportedPhrases(text, SATISFACTION_PHRASES, source.text);
      if (softeners.length > 0 || satisfaction.length > 0) {
        issues.push(issue("softened_negative", "risk", index, { sourceId: source.id }));
      }
    }

    // 否定的な内容があるのに、別の文で「全体的には良かった」と帳消しにしている疑い。
    if (hasNegative && !citesNegative && unsupportedPhrases(text, OVERALL_POSITIVE_PHRASES, allSourceText).length > 0) {
      issues.push(issue("softened_negative", "risk", index));
    }

    if (findPhrases(text, TEMPLATE_PHRASES).length > 0) issues.push(issue("template_phrase", "style", index));

    traits.push({ citesNegative, hasClaimVocabulary: claims.length > 0 || medical.length > 0 });
  });

  // ── 下書き全体 ──
  const citedIds = new Set(sentences.flatMap((s) => s.sourceIds));
  for (const source of sources) {
    if (source.negative && !citedIds.has(source.id)) {
      issues.push(issue("negative_not_reflected", "block", null, { sourceId: source.id }));
    }
  }

  const mainIds = options.mainSourceIds ?? [];
  if (mainIds.length > 0 && !mainIds.some((id) => citedIds.has(id))) {
    issues.push(issue("main_not_used", "style", null));
  }

  for (const source of sources) {
    if (!source.ownWords || !citedIds.has(source.id)) continue;
    const citingText = sentences
      .filter((s) => s.sourceIds.includes(source.id))
      .map((s) => s.text)
      .join("");
    if (bigramOverlap(source.text, citingText) < OWN_WORDS_MIN_OVERLAP) {
      issues.push(issue("own_words_paraphrased", "style", null, { sourceId: source.id }));
    }
  }

  // 体験者の主観が表れている文の割合。1文も無い、または3文以上で3分の1未満なら、事実の列挙だけ。
  const subjectiveCount = sentences.filter((s) => hasSubjectiveMarker(s.text)).length;
  const lowTexture =
    subjectiveCount === 0 || (sentences.length >= 3 && subjectiveCount / sentences.length < 1 / 3);
  if (lowTexture) issues.push(issue("low_emotional_texture", "style", null));

  // 質問の順に、1文に1つずつ、選択肢をほぼそのまま写して並べただけ。
  if (sentences.length >= 3) {
    const oneEach = sentences.every((s) => s.sourceIds.length === 1);
    const ids = sentences.map((s) => materialNumber(s.sourceIds[0] ?? "M0"));
    const inSurveyOrder = ids.every((id, i) => i === 0 || id > ids[i - 1]);
    const copied = sentences.filter((s) => {
      const source = sourceById.get(s.sourceIds[0] ?? "");
      return source !== undefined && !source.ownWords && bigramOverlap(source.text, s.text) >= COPIED_CHOICE_OVERLAP;
    }).length;
    if (oneEach && inSurveyOrder && (copied / sentences.length >= 0.5 || lowTexture)) {
      issues.push(issue("robotic_survey_summary", "style", null));
    }
  }

  // 語尾が3回続けて同じ、または文の長さがそろいすぎている。
  let run = 1;
  let monotone = false;
  for (let i = 1; i < sentences.length; i++) {
    run = sentenceEnding(sentences[i].text) === sentenceEnding(sentences[i - 1].text) ? run + 1 : 1;
    if (run >= MONOTONE_RUN) monotone = true;
  }
  let uniformLength = false;
  if (sentences.length >= 3) {
    const lengths = sentences.map((s) => countChars(s.text));
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const sd = Math.sqrt(lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length);
    uniformLength = mean > 0 && sd / mean < MIN_LENGTH_VARIATION;
  }
  if (monotone || uniformLength) issues.push(issue("uniform_sentence_structure", "style", null));

  const draftText = sentences.map((s) => s.text).join("");
  if (findPhrases(draftText, HONORIFIC_INFLATION_PHRASES).length >= HONORIFIC_MIN_COUNT) {
    issues.push(issue("honorific_inflation", "style", null));
  }

  if (options.targetChars) {
    const chars = countChars(draftText);
    if (chars < options.targetChars.min || chars > options.targetChars.max) {
      issues.push(issue("length_out_of_range", "style", null));
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

/** 下書き全体の人間らしさに関する指摘(書き直しの判断に使う)。 */
export const TEXTURE_CODES: ReadonlySet<LintCode> = new Set<LintCode>([
  "robotic_survey_summary",
  "low_emotional_texture",
]);

/** 指摘の名前(細目があれば「code:detail」)。修正の依頼と記録に使う。文や素材の内容は含めない。 */
export function issueKey(issue: LintIssue): string {
  return issue.detail ? `${issue.code}:${issue.detail}` : issue.code;
}

/** 記録用の指摘コード一覧(重複なし。細目があれば「code:detail」)。 */
export function lintCodes(result: LintResult): string[] {
  return [...new Set(result.issues.map(issueKey))];
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}
