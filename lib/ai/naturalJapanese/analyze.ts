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

// 漢字とかなの表記ゆれ(「分かりにくい」と「わかりにくい」、「良かった」と「よかった」など)。
const SPELLING_VARIANTS: readonly (readonly [RegExp, string])[] = [
  [/分か/gu, "わか"],
  [/出来/gu, "でき"],
  [/下さ/gu, "くださ"],
  [/頂/gu, "いただ"],
  [/良(?=[いかくけさ])/gu, "よ"],
  [/無(?=[いかくけさ])/gu, "な"],
  [/易(?=[いかくけ])/gu, "やす"],
  [/難(?=[いかくけ])/gu, "にく"],
];

/** 表記ゆれをかなに揃える(照合の前に、比べる両方へかける)。 */
export function foldSpelling(text: string): string {
  return SPELLING_VARIANTS.reduce((folded, [pattern, kana]) => folded.replace(pattern, kana), normalize(text));
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

// 整いすぎた言い回しのうち、意味を変えずに機械的に直せるもの(「嬉しく思いました」→「嬉しかったです」、
// 「安心することができました」→「安心できました」など)。
const POLISHED_REWRITES: readonly (readonly [RegExp, string])[] = [
  [/(嬉|うれ)しく思いました/gu, "$1しかったです"],
  [/(嬉|うれ)しく思います/gu, "$1しいです"],
  [/([\p{Script=Han}\p{Script=Katakana}ー]{2,})することができ/gu, "$1でき"],
  [/感じることができ(?=ま|て)/gu, "感じ"],
  [/過ごすことができ/gu, "過ごせ"],
  [/受けることができ/gu, "受けられ"],
];

/**
 * 整いすぎた言い回しを、直接的な言い方に直す。お客様が自分で書いた言い回し(protectedText に
 * 含まれるもの)はそのまま残す。
 */
export function simplifyPolishedPhrases(text: string, protectedText = ""): string {
  return POLISHED_REWRITES.reduce(
    (current, [pattern, replacement]) =>
      current.replace(pattern, (match: string, ...groups: unknown[]) =>
        protectedText && containsPhrase(protectedText, match)
          ? match
          : replacement.replace(/\$1/g, typeof groups[0] === "string" ? groups[0] : ""),
      ),
    text,
  );
}

const EXCLAMATION = /[！!]/gu;
const FINAL_EXCLAMATION = /[！!]+$/u;

/** 感嘆符の数。 */
export function countExclamations(text: string): number {
  return text.match(EXCLAMATION)?.length ?? 0;
}

/**
 * 感嘆符を max 個までに減らす。続けて付いたもの(「！！」)は1つにし、それでも多ければ、
 * 前の文の文末から句点に戻す(後ろの文の感嘆符を残す)。文中の感嘆符は変えない。
 */
export function limitExclamations(sentences: readonly string[], max: number): string[] {
  const result = sentences.map((s) => s.replace(/([！!])[！!]+/gu, "$1"));
  let surplus = result.reduce((sum, s) => sum + countExclamations(s), 0) - max;
  for (let i = 0; i < result.length && surplus > 0; i++) {
    if (FINAL_EXCLAMATION.test(result[i])) {
      result[i] = result[i].replace(FINAL_EXCLAMATION, "。");
      surplus--;
    }
  }
  return result;
}

/** 空白・改行を除いた文字数。 */
export function countChars(text: string): number {
  return [...normalize(text)].length;
}
