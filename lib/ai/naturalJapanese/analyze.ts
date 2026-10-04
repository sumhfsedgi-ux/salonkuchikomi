// 日本語の口コミ・返信の下書きを決定的に解析する小さな関数群
// (docs/plans/reviews-465-plan.md §7-3)。外部APIもDBも使わない純粋な関数だけを置く。

import {
  CURIOSITY_AFTER_MARKER,
  NEGATION_AFTER_MARKER,
  NEGATIVE_MARKERS,
  PERCEPTION_MARKERS,
} from "@/lib/ai/naturalJapanese/phrases";

/** 照合用に正規化する(NFKCで全角英数・記号を揃え、空白・改行を除く)。 */
export function normalize(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, "");
}

/** text に含まれる語を phrases の中から返す(部分一致)。 */
export function findPhrases(text: string, phrases: readonly string[]): string[] {
  const target = normalize(text);
  return phrases.filter((phrase) => target.includes(normalize(phrase)));
}

export function containsPhrase(text: string, phrase: string): boolean {
  return normalize(text).includes(normalize(phrase));
}

const SENTENCE_TERMINATORS = new Set(["。", "．", "！", "？", "!", "?"]);

/** 文に分ける。句点・感嘆符・疑問符・改行で区切り、区切りの記号は前の文に残す。 */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let current = "";
  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) sentences.push(trimmed);
    current = "";
  };
  for (const ch of text) {
    if (ch === "\n" || ch === "\r") {
      flush();
      continue;
    }
    current += ch;
    if (SENTENCE_TERMINATORS.has(ch)) flush();
  }
  flush();
  return sentences;
}

/** 文末の形(語尾の単調さの判定用)。末尾の記号を除いた最後の2文字。 */
export function sentenceEnding(sentence: string): string {
  const core = normalize(sentence).replace(/[。．、,！？!?…・〜~ー]+$/u, "");
  return core.slice(-2);
}

/** 否定的な内容の目印を探す。直後で打ち消されている目印(「勧誘もなく」など)は除く。 */
export function findNegativeMarkers(text: string): string[] {
  const target = normalize(text);
  const found: string[] = [];
  for (const marker of NEGATIVE_MARKERS) {
    const needle = normalize(marker);
    let from = 0;
    for (;;) {
      const index = target.indexOf(needle, from);
      if (index === -1) break;
      const after = target.slice(index + needle.length);
      const negated = NEGATION_AFTER_MARKER.test(after);
      const curiosity = marker.startsWith("気にな") && CURIOSITY_AFTER_MARKER.test(after);
      if (!negated && !curiosity) {
        found.push(marker);
        break;
      }
      from = index + needle.length;
    }
  }
  return found;
}

export function isNegative(text: string): boolean {
  return findNegativeMarkers(text).length > 0;
}

export function hasPerception(text: string): boolean {
  return findPhrases(text, PERCEPTION_MARKERS).length > 0;
}

// 「〜したい」「〜たくて」「〜ために」。来店理由・希望で、達成された結果ではない形。
const PURPOSE_PATTERN = /(たい|たくて)(?=$|[。、！!？?]|と思|です|から|ので|な|気持ち)|ために/u;

export function isPurposeLike(text: string): boolean {
  return PURPOSE_PATTERN.test(normalize(text));
}

const BIGRAM_IGNORED = /[。．、,！？!?「」『』（）()…・〜~ー\s]/gu;

function bigrams(text: string): string[] {
  const chars = [...text.normalize("NFKC").replace(BIGRAM_IGNORED, "")];
  const result: string[] = [];
  for (let i = 0; i < chars.length - 1; i++) result.push(chars[i] + chars[i + 1]);
  return result;
}

/** source の2文字の並びのうち、target にも出てくる割合(0〜1)。本人の言い回しがどれだけ残っているかの目安。 */
export function bigramOverlap(source: string, target: string): number {
  const sourceBigrams = bigrams(source);
  if (sourceBigrams.length === 0) return 1;
  const targetBigrams = new Set(bigrams(target));
  const hits = sourceBigrams.filter((b) => targetBigrams.has(b)).length;
  return hits / sourceBigrams.length;
}

const DECORATION_PATTERN = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}★☆✨♪♡♥]/gu;

/** 絵文字・★などの装飾を取り除く(口コミの下書きには入れない)。 */
export function stripDecorations(text: string): string {
  return text.replace(DECORATION_PATTERN, "");
}

/** 空白・改行を除いた文字数。 */
export function countChars(text: string): number {
  return [...normalize(text)].length;
}
