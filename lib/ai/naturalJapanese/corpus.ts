// 口コミの下書きを20件くらいまとめて見る Corpus Lint(docs/plans/reviews-465-plan.md §14-6)。
// 1件ずつは自然でも、並べると同じ人が書いたように見える型(同じ締め・同じ感情語・同じ文末 など)を数える。
// 診断用のツールで、合否には使わない(warning だけ)。数値を下げるために文章を不自然にばらつかせない。

import { countChars, countExclamations, findPhrases, normalize, sentenceEnding, splitSentences } from "@/lib/ai/naturalJapanese/analyze";
import { INTENT_PHRASES } from "@/lib/ai/naturalJapanese/phrases";

export interface CorpusDraft {
  text: string;
  /** その下書きの素材(回答)の文。回答の文言どおりの言い回しは「同一フレーズ」に数えない。 */
  sourceText?: string;
}

export interface PatternCount {
  pattern: string;
  drafts: number;
  share: number;
}

export interface CorpusReport {
  drafts: number;
  /** 文の数ごとの件数(1 / 2 / 3 / 4+)。 */
  sentenceCounts: Record<string, number>;
  chars: { mean: number; sd: number; min: number; max: number };
  /** 感嘆符の数ごとの件数(0 / 1 / 2 / 3+)。 */
  exclamations: Record<string, number>;
  /** 感情の言葉ごとの、含む下書きの数。 */
  emotionWords: PatternCount[];
  /** 1件あたりの感情の言葉の数ごとの件数(0 / 1 / 2 / 3+)。 */
  emotionPerDraft: Record<string, number>;
  /** 最後の文の型ごとの件数(意向 / 気持ち / 事実)。 */
  closingTypes: Record<string, number>;
  /** 書き出し(先頭4字)の型。 */
  openings: PatternCount[];
  /** 終わり方(最後の5字)の型。 */
  endings: PatternCount[];
  /** 文末(各文の最後の3字)の分布。 */
  sentenceEndings: Array<{ pattern: string; count: number; share: number }>;
  /** 3件以上に出てくる5字の並び(回答の文言どおりのものは除く)。 */
  sharedPhrases: PatternCount[];
  warnings: string[];
}

/** 感情の言葉(数えるためだけに使う。生成で禁止はしない)。 */
const EMOTION_WORDS: ReadonlyArray<{ label: string; patterns: string[] }> = [
  { label: "嬉しい", patterns: ["嬉し", "うれし"] },
  { label: "よかった", patterns: ["よかった", "良かった"] },
  { label: "安心", patterns: ["安心"] },
  { label: "満足", patterns: ["満足"] },
  { label: "ありがたい", patterns: ["ありがた"] },
  { label: "助かった", patterns: ["助かっ", "助かり"] },
  { label: "ほっとした", patterns: ["ほっと", "ホッと"] },
  { label: "気分が上がる", patterns: ["気分が上が"] },
  { label: "楽しい", patterns: ["楽しかっ", "楽しみ", "楽しい"] },
  { label: "気持ちいい", patterns: ["気持ちよ", "気持ち良"] },
  { label: "気に入った", patterns: ["気に入"] },
  { label: "残念", patterns: ["残念"] },
  { label: "すごく", patterns: ["すごく", "とても"] },
];

// 警告の目安(Phase 1 では warning だけ)。
const THRESHOLDS = {
  closingType: 0.5,
  intentClosing: 0.3,
  ending: 0.3,
  emotionWord: 0.4,
  sentenceCountMode: 0.5,
  exclamationValue: 0.6,
  opening: 0.3,
  sentenceEnding: 0.5,
  sharedPhrase: 0.25,
} as const;

const NGRAM = 5;
const MIN_SHARED_DRAFTS = 3;
const PUNCTUATION = /[。．、,！？!?「」『』（）()…・〜~ー\s]/gu;

function bucket(value: number, max: number): string {
  return value >= max ? `${max}+` : String(value);
}

function increment(counts: Record<string, number>, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function emotionLabels(text: string): string[] {
  return EMOTION_WORDS.filter((w) => findPhrases(text, w.patterns).length > 0).map((w) => w.label);
}

function closingType(lastSentence: string): "意向" | "気持ち" | "事実" {
  if (findPhrases(lastSentence, INTENT_PHRASES).length > 0) return "意向";
  if (emotionLabels(lastSentence).some((label) => label !== "すごく")) return "気持ち";
  return "事実";
}

function topPatterns(values: readonly string[], total: number, limit = 5): PatternCount[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([pattern, drafts]) => ({ pattern, drafts, share: round(drafts / total) }));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function ngrams(text: string): Set<string> {
  const chars = [...normalize(text).replace(PUNCTUATION, "")];
  const result = new Set<string>();
  for (let i = 0; i + NGRAM <= chars.length; i++) result.add(chars.slice(i, i + NGRAM).join(""));
  return result;
}

export function corpusLint(drafts: readonly CorpusDraft[]): CorpusReport {
  const total = drafts.length;
  const sentencesOf = drafts.map((d) => splitSentences(d.text));
  const sentenceCounts: Record<string, number> = {};
  const exclamations: Record<string, number> = {};
  const emotionPerDraft: Record<string, number> = {};
  const closingTypes: Record<string, number> = {};
  const emotionDrafts = new Map<string, number>();

  sentencesOf.forEach((sentences, i) => {
    increment(sentenceCounts, bucket(sentences.length, 4));
    increment(exclamations, bucket(countExclamations(drafts[i].text), 3));
    const labels = emotionLabels(drafts[i].text);
    increment(emotionPerDraft, bucket(labels.filter((l) => l !== "すごく").length, 3));
    for (const label of labels) emotionDrafts.set(label, (emotionDrafts.get(label) ?? 0) + 1);
    if (sentences.length > 0) increment(closingTypes, closingType(sentences[sentences.length - 1]));
  });

  const lengths = drafts.map((d) => countChars(d.text));
  const mean = total > 0 ? lengths.reduce((a, b) => a + b, 0) / total : 0;
  const sd = total > 0 ? Math.sqrt(lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / total) : 0;

  const emotionWords = [...emotionDrafts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([pattern, count]) => ({ pattern, drafts: count, share: round(count / total) }));
  const openings = topPatterns(
    drafts.map((d) => [...normalize(d.text).replace(PUNCTUATION, "")].slice(0, 4).join("")),
    total,
  );
  const endings = topPatterns(
    drafts.map((d) => [...normalize(d.text).replace(PUNCTUATION, "")].slice(-5).join("")),
    total,
  );
  const allSentences = sentencesOf.flat();
  const sentenceEndings = topPatterns(
    allSentences.map((s) => sentenceEnding(s, 3)),
    Math.max(1, allSentences.length),
  ).map(({ pattern, drafts: count, share }) => ({ pattern, count, share }));

  // 回答の文言どおりの並びは、同じ回答から作れば当然重なるので除く。
  const phraseDrafts = new Map<string, number>();
  for (const draft of drafts) {
    const source = draft.sourceText ? normalize(draft.sourceText).replace(PUNCTUATION, "") : "";
    for (const gram of ngrams(draft.text)) {
      if (source.includes(gram)) continue;
      phraseDrafts.set(gram, (phraseDrafts.get(gram) ?? 0) + 1);
    }
  }
  const sharedPhrases = [...phraseDrafts.entries()]
    .filter(([, count]) => count >= MIN_SHARED_DRAFTS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([pattern, count]) => ({ pattern, drafts: count, share: round(count / total) }));

  const warnings: string[] = [];
  const share = (count: number | undefined) => (total > 0 ? (count ?? 0) / total : 0);
  for (const [type, count] of Object.entries(closingTypes)) {
    const limit = type === "意向" ? THRESHOLDS.intentClosing : THRESHOLDS.closingType;
    if (share(count) > limit) warnings.push(`締めの型「${type}」が ${count}/${total} 件`);
  }
  for (const e of endings) if (e.share > THRESHOLDS.ending) warnings.push(`同じ終わり方「…${e.pattern}」が ${e.drafts}/${total} 件`);
  for (const e of emotionWords) {
    if (e.share > THRESHOLDS.emotionWord) warnings.push(`感情の言葉「${e.pattern}」が ${e.drafts}/${total} 件`);
  }
  for (const [count, n] of Object.entries(sentenceCounts)) {
    if (share(n) > THRESHOLDS.sentenceCountMode) warnings.push(`文の数が ${count} の下書きが ${n}/${total} 件`);
  }
  for (const [count, n] of Object.entries(exclamations)) {
    if (share(n) > THRESHOLDS.exclamationValue) warnings.push(`感嘆符が ${count} 個の下書きが ${n}/${total} 件`);
  }
  for (const o of openings) if (o.share > THRESHOLDS.opening) warnings.push(`同じ書き出し「${o.pattern}…」が ${o.drafts}/${total} 件`);
  for (const e of sentenceEndings) {
    if (e.share > THRESHOLDS.sentenceEnding) warnings.push(`文末「…${e.pattern}」が全文の ${Math.round(e.share * 100)}%(参考)`);
  }
  for (const p of sharedPhrases) {
    if (p.share > THRESHOLDS.sharedPhrase) warnings.push(`同じ言い回し「${p.pattern}」が ${p.drafts}/${total} 件`);
  }

  return {
    drafts: total,
    sentenceCounts,
    chars: { mean: Math.round(mean), sd: Math.round(sd), min: Math.min(...lengths), max: Math.max(...lengths) },
    exclamations,
    emotionWords,
    emotionPerDraft,
    closingTypes,
    openings,
    endings,
    sentenceEndings,
    sharedPhrases,
    warnings,
  };
}
