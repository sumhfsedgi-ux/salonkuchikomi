// 口コミの下書き1件を、素材(お客様の回答)と突き合わせて検査する決定的な Linter
// (Single Review Lint。docs/plans/reviews-465-plan.md §14-6)。
//
// review-v3.0 で、重大なものだけに絞った。指摘コードと分類の対応:
//   FACTUAL_INVENTION   … factual_invention(状況・数値・比較・業種外・来店回数・観点・結果・出来事・回答に無い意向)
//   UNSUPPORTED_EFFECT  … unsupported_effect(医療・効果の断定・「感じた」の断定・来店理由を結果にする)
//   NEGATIVE_REVERSAL   … negative_not_reflected / polarity_flip / softened_negative
//   EXTREME / PROMOTION … extreme_emotional_exaggeration / promotional_callout
//   BROKEN_CAUSALITY    … weak_connection(「Aしてもらえて、Bが気になっていたけどCでした」型のあいまいなつなぎ)
//   ABSTRACT_SUMMARY    … abstract_ai_summary(〜な体験でした・〜と思える〜でした・最後の「全体的に」。明らかなものだけ)
//   STRUCTURE           … robotic_survey_summary / uniform_sentence_structure / repeated_content
//   技術的不備          … empty_draft / no_source / unknown_source / fragment / ungrammatical
// 単語リストによる禁止、感情が無いことの指摘、特定の語の回数、文字数は見ない(書き方のばらつきは
// 20件単位の Corpus Lint で見る)。own_words_paraphrased は、本人の言葉(Voice Anchor)が残っているかの記録用。
//
// 各文の sourceIds(どの素材をもとに書いたか)は LLM の自己申告でしかなく、意味が正しいことは
// 保証しない。そこで、語彙で判定できる範囲を次の3段階で返す:
//   block … そのままでは表示しない(文を削除するか、修正する)
//   risk  … 同期の意味検証(LLM)にかける。NG・タイムアウトなら block と同じ扱い
//   style … 構造の問題。表示は止めない(パイプラインが Style Seed を変えて1回だけ作り直す)

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
  ABSTRACT_NOUN_PATTERN,
  ASPECT_PHRASES,
  CALLOUT_PHRASES,
  CHANGE_CLAIM_PHRASES,
  COMPARISON_PHRASES,
  EXTREME_EMOTION_PHRASES,
  FIRST_VISIT_PHRASES,
  FLIP_PHRASES,
  INTENT_PHRASES,
  INVENTED_DETAIL_PHRASES,
  MEDICAL_PHRASES,
  OFF_TOPIC_PHRASES,
  OUTCOME_PHRASES,
  OVERALL_POSITIVE_PHRASES,
  REPEAT_VISIT_PATTERN,
  SATISFACTION_PHRASES,
  SITUATION_PHRASES,
  SOFTENER_PHRASES,
  STRONG_EMOTION_PHRASES,
  SUBJECTIVE_MARKERS,
  SUMMARY_MARKERS,
  THINKABLE_NOUN_PATTERN,
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
  /** 来店回数(「初めてでしたが」のような前置きなので、つなぎの判定で内容の数に数えない)。 */
  visitCount?: boolean;
}

export interface LintSentence {
  text: string;
  sourceIds: string[];
}

export type LintSeverity = "block" | "risk" | "style";

export type LintCode =
  // 技術的不備
  | "empty_draft"
  | "no_source"
  | "unknown_source"
  | "fragment"
  | "ungrammatical"
  // 事実・効果・感情の強さ・宣伝
  | "factual_invention"
  | "unsupported_effect"
  | "extreme_emotional_exaggeration"
  | "promotional_callout"
  // 否定的な内容
  | "negative_not_reflected"
  | "polarity_flip"
  | "softened_negative"
  // つなぎ・抽象総括・構造
  | "weak_connection"
  | "abstract_ai_summary"
  | "robotic_survey_summary"
  | "uniform_sentence_structure"
  | "repeated_content"
  // 記録用(本人の言葉が残っているか)
  | "own_words_paraphrased";

/** 指摘の細目(記録・修正の依頼に使う)。 */
export type LintDetail =
  | "situation"
  | "number"
  | "comparison"
  | "visit_count"
  | "off_topic"
  | "aspect"
  | "outcome"
  | "detail"
  | "intent"
  | "medical"
  | "medical_term"
  | "change_claim"
  | "perception_dropped"
  | "purpose_as_result"
  | "extreme"
  | "strong"
  | "abstract_noun"
  | "thinkable_noun"
  | "closing_summary";

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

// 本人の言い回しがこの割合より残っていなければ、言い換えすぎとして記録する。
const OWN_WORDS_MIN_OVERLAP = 0.3;
// 回答の言葉がこの割合以上入っている文が2つあれば、同じ内容の繰り返しとみなす。
const REPEAT_MIN_OVERLAP = 0.5;
// この数以上の文がすべて同じ語尾なら均一とみなす。
const MONOTONE_MIN_SENTENCES = 3;
// 選択肢の言葉とこの割合以上重なる文は、選択肢をそのまま写した文とみなす。
const COPIED_CHOICE_OVERLAP = 0.7;
// 句読点を除いてこれより短い文は、文になっていない断片とみなす(「ニキビ。」など)。
// ただし気持ちを言い切った短い文(「嬉しい！」など)は、口コミとして自然なので断片にしない。
const MIN_SENTENCE_CHARS = 5;
// 「〜て、」「〜で、」でつないだあとに逆接を重ねる(「提案してもらえて、毛穴が気になっていたけど安心できました」)。
const WEAK_LINK_PATTERN = /[てで]、[^。]*?(?:けど|けれど|のに|ですが|ましたが|でしたが)/u;
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

/** 回答に無い、抽象的なまとめの言い回し(回答の言葉そのものなら除く)。 */
function unsupportedMatch(text: string, pattern: RegExp, supportText: string): boolean {
  const match = normalize(text).match(pattern);
  return match !== null && !containsPhrase(supportText, match[0]);
}

function materialNumber(id: string): number {
  return Number.parseInt(id.replace(/^M/, ""), 10);
}

export function lintDraft(sentences: readonly LintSentence[], sources: readonly LintSource[]): LintResult {
  const issues: LintIssue[] = [];
  const traits: SentenceTraits[] = [];
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const allSourceText = sources.map((s) => s.text).join("\n");
  const firstVisit = findPhrases(allSourceText, FIRST_VISIT_PHRASES).length > 0;
  const repeatVisit = REPEAT_VISIT_PATTERN.test(normalize(allSourceText));
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

    // ── 技術的不備(block) ──
    if (sentence.sourceIds.length === 0) issues.push(issue("no_source", "block", index));
    if (cited.length < sentence.sourceIds.length) issues.push(issue("unknown_source", "block", index));
    if ([...text.replace(PUNCTUATION, "")].length < MIN_SENTENCE_CHARS && findPhrases(text, SUBJECTIVE_MARKERS).length === 0) {
      issues.push(issue("fragment", "block", index));
    }
    if (UNGRAMMATICAL_PATTERN.test(text)) issues.push(issue("ungrammatical", "block", index));

    // ── 回答に無い具体的な事実(block。言い換えとして正しいこともあるものは risk) ──
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
    // 逆に、回答に無い「初めて」も来店回数の捏造。2回目以降と答えていれば矛盾(block)。
    if (!firstVisit && findPhrases(text, FIRST_VISIT_PHRASES).length > 0) {
      issues.push(issue("factual_invention", repeatVisit ? "block" : "risk", index, { detail: "visit_count" }));
    }
    // 「また来たい」「おすすめ」などの意向は、回答に意向があるときだけ書いてよい。
    if (unsupportedPhrases(text, INTENT_PHRASES, allSourceText).length > 0) {
      issues.push(issue("factual_invention", "block", index, { detail: "intent" }));
    }
    // 回答に無い観点(雰囲気・スタッフ・料金 など)、仕上がりの評価、出来事・行動・生活での変化・お店の
    // 事情の推測。言い換えとして正しいこともあるので、意味検証で回答と比べる。
    if (unsupportedPhrases(text, ASPECT_PHRASES, allSourceText).length > 0) {
      issues.push(issue("factual_invention", "risk", index, { detail: "aspect" }));
    }
    if (unsupportedPhrases(text, OUTCOME_PHRASES, allSourceText).length > 0) {
      issues.push(issue("factual_invention", "risk", index, { detail: "outcome" }));
    }
    if (unsupportedPhrases(text, INVENTED_DETAIL_PHRASES, allSourceText).length > 0) {
      issues.push(issue("factual_invention", "risk", index, { detail: "detail" }));
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

    // ── 関係のあいまいなつなぎ(来店回数の前置きは内容の数に数えない) ──
    const topics = cited.filter((s) => !s.visitCount).length;
    if (topics >= 2 && WEAK_LINK_PATTERN.test(normalize(text))) {
      issues.push(issue("weak_connection", "style", index));
    }

    // ── 明らかな抽象総括 ──
    if (unsupportedMatch(text, ABSTRACT_NOUN_PATTERN, allSourceText)) {
      issues.push(issue("abstract_ai_summary", "style", index, { detail: "abstract_noun" }));
    }
    if (unsupportedMatch(text, THINKABLE_NOUN_PATTERN, allSourceText)) {
      issues.push(issue("abstract_ai_summary", "style", index, { detail: "thinkable_noun" }));
    }
    // 最後の文だけ「全体的に〜」「総じて〜」と全体をまとめ直す。
    const isClosing = sentences.length >= 2 && index === sentences.length - 1;
    if (isClosing && unsupportedPhrases(text, SUMMARY_MARKERS, allSourceText).length > 0) {
      issues.push(issue("abstract_ai_summary", "style", index, { detail: "closing_summary" }));
    }

    traits.push({ citesNegative, hasClaimVocabulary: claims.length > 0 || medical.length > 0 });
  });

  // ── 下書き全体 ──
  const citedIds = new Set(sentences.flatMap((s) => s.sourceIds));
  for (const source of sources) {
    if (source.negative && !citedIds.has(source.id)) {
      issues.push(issue("negative_not_reflected", "block", null, { sourceId: source.id }));
    }
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

  // 同じ回答の言葉を、別の文でもう一度書いている(2回目以降の文を指摘する)。出典にしただけで
  // 回答の言葉を使っていない文は数えない。
  for (const source of sources) {
    if (countChars(source.text) < 2) continue;
    const repeating = sentences
      .map((s, index) => ({ s, index }))
      .filter(({ s }) => s.sourceIds.includes(source.id) && bigramOverlap(source.text, s.text) >= REPEAT_MIN_OVERLAP);
    for (const { index } of repeating.slice(1)) {
      issues.push(issue("repeated_content", "style", index, { sourceId: source.id }));
    }
  }

  // 質問の順に、1文に1つずつ、選択肢をほぼそのまま写して並べただけ(アンケートの要約)。
  if (sentences.length >= 3) {
    const oneEach = sentences.every((s) => s.sourceIds.length === 1);
    const ids = sentences.map((s) => materialNumber(s.sourceIds[0] ?? "M0"));
    const inSurveyOrder = ids.every((id, i) => i === 0 || id > ids[i - 1]);
    const copied = sentences.filter((s) => {
      const source = sourceById.get(s.sourceIds[0] ?? "");
      return source !== undefined && !source.ownWords && bigramOverlap(source.text, s.text) >= COPIED_CHOICE_OVERLAP;
    }).length;
    if (oneEach && inSurveyOrder && copied / sentences.length >= 0.5) {
      issues.push(issue("robotic_survey_summary", "style", null));
    }
  }

  // 3文以上が、すべて同じ語尾(3字)で終わる(「〜でした。〜でした。〜でした。」)。
  // 作り直しにつながるので、語尾の一部が同じ程度(「です」が続く など)では指摘しない。
  if (sentences.length >= MONOTONE_MIN_SENTENCES) {
    const endings = new Set(sentences.map((s) => sentenceEnding(s.text, 3)));
    if (endings.size === 1) issues.push(issue("uniform_sentence_structure", "style", null));
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

/**
 * 構造の問題(BROKEN_CAUSALITY・ABSTRACT_SUMMARY・STRUCTURE)。部分修正ではなく、パイプラインが
 * Style Seed を変えて全文を1回だけ作り直す。
 */
export const STRUCTURE_CODES: ReadonlySet<LintCode> = new Set<LintCode>([
  "weak_connection",
  "abstract_ai_summary",
  "robotic_survey_summary",
  "uniform_sentence_structure",
  "repeated_content",
]);

/** 構造の問題の数。 */
export function structureIssueCount(result: LintResult): number {
  return result.issues.filter((i) => STRUCTURE_CODES.has(i.code)).length;
}

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
