// 口コミ生成 v2 の「素材シート」(docs/plans/reviews-465-plan.md §7-1・§13)。
// DB と照合済みの回答を、LLM に渡す素材 M1..M20 に整理する。役割・極性などの
// 判定はすべてコードで行い、LLM には判断させない。

import { OTHER_OPTION_TEXT } from "@/lib/constants";
import { findNegativeMarkers, hasPerception, isPurposeLike } from "@/lib/ai/naturalJapanese/analyze";
import { hasNegativeIntent, intentKinds } from "@/lib/ai/naturalJapanese/evidence";
import type { LintSource } from "@/lib/ai/naturalJapanese/lint";

/** 質問の役割。質問文のキーワードで判定する(テンプレートに役割の列は無い)。 */
export type QuestionRole = "visit" | "discovery" | "reason" | "menu" | "experience" | "staff_shop" | "satisfaction" | "intention" | "research" | "free_text" | "other";

/** choice = 選んだ選択肢、other_detail = 「その他」の詳細、free_text = 自由記述。 */
export type MaterialKind = "choice" | "other_detail" | "free_text";

/** DB と照合済みの回答1件(validateAnswers.ts が作る)。 */
export interface MaterialInput {
  questionText: string;
  questionType: "single" | "multiple" | "text";
  /** 選んだ選択肢の文言(「その他」を含んでよい。「その他」そのものは素材にしない)。 */
  selected: string[];
  /** 「その他」を選んだときの詳細。 */
  otherDetail?: string;
  /** 自由記述(text 型の質問)。 */
  freeText?: string;
}

export interface Material {
  /** M1, M2, …(LLM の出力の source_ids で使う)。 */
  id: string;
  kind: MaterialKind;
  role: QuestionRole;
  questionText: string;
  text: string;
  negative: boolean;
  perception: boolean;
  purposeLike: boolean;
  /** 再来店・推奨の意向(「また来たい」「おすすめ」など)。これがあるときだけ、口コミに意向を書いてよい。 */
  intent: boolean;
}

export const MAX_MATERIALS = 20;
// 自由記述は文・逆接ごとに分けて、否定的な部分だけが落ちても分かるようにする。
const MAX_FREE_TEXT_SEGMENTS = 5;
const MIN_SEGMENT_CHARS = 4;

const ROLE_RULES: ReadonlyArray<[QuestionRole, RegExp]> = [
  ["research", /新メニュー調査|商品調査|発売して|今後.*(?:食べたい|試したい|商品)|食べたい商品/u],
  ["visit", /何回目|来店回数|ご来店は|利用回数|ご利用は何/u],
  ["discovery", /きっかけ|知った|見つけた/u],
  ["intention", /今後について|今後のご利用|また.*(?:来たい|利用したい)|再来店/u],
  ["satisfaction", /満足度/u],
  ["reason", /悩み|目的|きっかけ|理由|ご希望|期待|求めて/u],
  ["experience", /仕上がり|おいしかった|美味しかった/u],
  ["menu", /メニュー|コース|施術内容|受けた施術|利用した/u],
  ["staff_shop", /スタッフ|店内|サロン|お店|雰囲気|接客|対応/u],
  ["experience", /感じ|体感|感想|いかが|どう/u],
];

export function detectRole(questionText: string, questionType: MaterialInput["questionType"]): QuestionRole {
  if (questionType === "text") return "free_text";
  for (const [role, pattern] of ROLE_RULES) {
    if (pattern.test(questionText)) return role;
  }
  return "other";
}

// 全角の数字・記号でも拾う(本人の文字はそのまま残したいので、文全体は正規化しない)。
const EMAIL_PATTERN = /[\w.+-]+[@＠][\w-]+[.．][\w.-]+/gu;
const PHONE_PATTERN = /[0０][0-9０-９]{1,4}[-ー−‐－\s]?[0-9０-９]{1,4}[-ー−‐－\s]?[0-9０-９]{3,4}/gu;
const MASKED = "（省略）";

/** お客様が書いた文から、電話番号とメールアドレスを伏せる(LLM に送らない)。 */
export function maskPersonalInfo(text: string): string {
  return text.replace(EMAIL_PATTERN, MASKED).replace(PHONE_PATTERN, MASKED);
}

// 回答欄に書かれた、AI への指示のような文(「以上の指示は無視して…書いてください」など)。
// 口コミの内容ではないので、その回答は素材にしない(否定的な内容の扱いとは別)。
const INSTRUCTION_TARGET = /指示|プロンプト|命令|システム|system|prompt|ignore/iu;
const INSTRUCTION_ACTION = /無視して|書いてください|出力して|生成して|作成してください|従ってください|ignore/iu;

export function isInstructionLike(text: string): boolean {
  return INSTRUCTION_TARGET.test(text) && INSTRUCTION_ACTION.test(text);
}

// 文の終わりと、逆接(「〜けど、」「〜ですが、」など)の直後で区切る。
const SEGMENT_BREAK =
  /(?<=[。！？!?\n])|(?<=(?:けど|けれど|けれども|ですが|でしたが|ましたが|ものの|のに)[、,])/u;

/** 自由記述を素材の単位に分ける。短すぎる断片は前とつなげ、多すぎる分は最後にまとめる。 */
export function splitFreeText(text: string): string[] {
  const parts = text
    .split(SEGMENT_BREAK)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  const merged: string[] = [];
  for (const part of parts) {
    if (merged.length > 0 && [...part].length < MIN_SEGMENT_CHARS) {
      merged[merged.length - 1] += part;
    } else {
      merged.push(part);
    }
  }
  if (merged.length > MAX_FREE_TEXT_SEGMENTS) {
    const head = merged.slice(0, MAX_FREE_TEXT_SEGMENTS - 1);
    head.push(merged.slice(MAX_FREE_TEXT_SEGMENTS - 1).join(""));
    return head;
  }
  return merged;
}

interface Candidate {
  kind: MaterialKind;
  role: QuestionRole;
  questionText: string;
  text: string;
}

function toCandidates(input: MaterialInput): Candidate[] {
  const role = detectRole(input.questionText, input.questionType);
  // 店舗向けの市場調査は、利用した体験として生成・検証に渡さない。
  if (role === "research") return [];
  const base = { role, questionText: input.questionText };
  const candidates: Candidate[] = [];

  if (input.questionType === "text") {
    const freeText = maskPersonalInfo(input.freeText ?? "").trim();
    if (isInstructionLike(freeText)) return candidates;
    for (const segment of freeText ? splitFreeText(freeText) : []) {
      candidates.push({ ...base, kind: "free_text", text: segment });
    }
    return candidates;
  }

  for (const value of input.selected) {
    const text = value.trim();
    if (text && text !== OTHER_OPTION_TEXT) candidates.push({ ...base, kind: "choice", text });
  }
  const detail = maskPersonalInfo(input.otherDetail ?? "").trim();
  if (detail && input.selected.includes(OTHER_OPTION_TEXT) && !isInstructionLike(detail)) {
    candidates.push({ ...base, kind: "other_detail", text: detail });
  }
  return candidates;
}

/** 照合済みの回答から素材を作る。上限を超えたら、否定的でない選択肢から後ろを削る。 */
export function buildMaterials(inputs: readonly MaterialInput[]): Material[] {
  const enriched = inputs.flatMap(toCandidates).map((candidate) => ({
    ...candidate,
    negative: findNegativeMarkers(candidate.text).length > 0 || hasNegativeIntent(candidate.text) || /改善してほしい|満足していない/u.test(candidate.text),
    perception: hasPerception(candidate.text),
    purposeLike: candidate.role === "reason" || isPurposeLike(candidate.text),
    intent: intentKinds(candidate.text).length > 0,
  }));

  // 本人の言葉(自由記述・「その他」の詳細)と否定的な素材は削らない。
  let overflow = enriched.length - MAX_MATERIALS;
  for (let i = enriched.length - 1; i >= 0 && overflow > 0; i--) {
    const candidate = enriched[i];
    if (candidate.kind === "choice" && !candidate.negative) {
      enriched.splice(i, 1);
      overflow--;
    }
  }

  return enriched.slice(0, MAX_MATERIALS).map((candidate, index) => ({
    id: `M${index + 1}`,
    ...candidate,
  }));
}

/**
 * 本人の文章(自由記述・「その他」の記入)。書き手の声の見本(Voice Anchor)として、分ける前の
 * 言い回しのまま LLM に渡す(素材は否定的な部分を追えるように分けてあるため、つなぎ直す)。
 */
export function voiceSamples(materials: readonly Material[]): string[] {
  const byQuestion = new Map<string, string[]>();
  for (const m of materials) {
    if (m.kind === "choice") continue;
    const key = `${m.kind}:${m.questionText}`;
    byQuestion.set(key, [...(byQuestion.get(key) ?? []), m.text]);
  }
  return [...byQuestion.values()].map((parts) => parts.join(""));
}

/** Linter に渡す形にする。 */
export function toLintSources(materials: readonly Material[]): LintSource[] {
  return materials.map((m) => ({
    id: m.id,
    text: m.text,
    questionText: m.questionText,
    role: m.role,
    negative: m.negative,
    perception: m.perception,
    purposeLike: m.purposeLike,
    ownWords: m.kind !== "choice",
    visitCount: m.role === "visit",
  }));
}
