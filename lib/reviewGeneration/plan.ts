// 口コミ生成 v2 の「構成プラン」(docs/plans/reviews-465-plan.md §7-1・§13)。
// 主役・補助・使わない素材、長さ、書き出しと締めの型をコードで決める。
// 回答の内容に合わない構成を強制しないよう、選べる型は使う素材から決まる。
//
// 必須ルール: 否定的な素材と本人の言葉(自由記述・「その他」の詳細)は、
// 必ず主役か補助に入れる(「使わない素材」にはしない)。

import { z } from "zod";
import { findPhrases } from "@/lib/ai/naturalJapanese/analyze";
import { RECOMMEND_PHRASES, REVISIT_PHRASES } from "@/lib/ai/naturalJapanese/phrases";
import { MAX_MATERIALS, type Material, type QuestionRole } from "@/lib/reviewGeneration/materials";

export const DRAFT_LENGTHS = ["short", "medium", "long"] as const;
export const OPENING_STYLES = ["main", "own_words", "reason", "staff_shop", "visit", "small_detail"] as const;
export const CLOSING_STYLES = ["impression", "plain", "intent"] as const;
/** 感嘆符(！)の使い方。生成ごとに揺らがせる(使わない／最後の文だけ／文中に1〜2個)。 */
export const EXCLAMATION_STYLES = ["none", "last", "inline"] as const;

export type DraftLength = (typeof DRAFT_LENGTHS)[number];
export type OpeningStyle = (typeof OPENING_STYLES)[number];
export type ClosingStyle = (typeof CLOSING_STYLES)[number];
export type ExclamationStyle = (typeof EXCLAMATION_STYLES)[number];

export interface CompositionPlan {
  mainIds: string[];
  supportIds: string[];
  unusedIds: string[];
  length: DraftLength;
  opening: OpeningStyle;
  closing: ClosingStyle;
  exclamation: ExclamationStyle;
}

/**
 * 文字数の目安(soft target。LLM への指示に使う)。全体で 80〜250字くらい。
 * 2026-10-04: 厳密な制約にすると、回答を短い文に圧縮して要点を並べただけの口コミになるため、
 * 目安にした。自然に終わるなら短くてよく、内容が豊富なら超えてよい。水増しも詰め込みもしない。
 */
export const LENGTH_TARGETS: Record<DraftLength, { chars: { min: number; max: number } }> = {
  short: { chars: { min: 80, max: 130 } },
  medium: { chars: { min: 120, max: 190 } },
  long: { chars: { min: 170, max: 250 } },
};

/** これを大きく外れたときだけ、Linter が長さを指摘する(style。表示は止めない)。 */
export const SOFT_LENGTH_RANGE = { min: 40, max: 300 };

/** NG の文を削ったあとの下書きがこれより短ければ、口コミとして成り立たないので直す。 */
export const MIN_DRAFT_CHARS = 30;

// 使う内容(来店回数を除く)の合計がこれより短ければ、補助を1つ足す。
const THIN_CONTENT_CHARS = 20;

const MATERIAL_ID = z.string().regex(/^M\d{1,2}$/);

/** 再生成のときにクライアントから受け取る前回のプラン(素材の本文は含まない)。 */
export const previousPlanSchema = z.object({
  mainIds: z.array(MATERIAL_ID).max(MAX_MATERIALS),
  supportIds: z.array(MATERIAL_ID).max(MAX_MATERIALS),
  length: z.enum(DRAFT_LENGTHS),
  opening: z.enum(OPENING_STYLES),
  closing: z.enum(CLOSING_STYLES),
});

export type PreviousPlan = z.infer<typeof previousPlanSchema>;

// 主役にしやすい順(小さいほど優先)。本人の言葉が最優先。
const ROLE_PRIORITY: Record<QuestionRole, number> = {
  free_text: 0,
  experience: 1,
  staff_shop: 2,
  reason: 3,
  menu: 4,
  other: 5,
  visit: 6,
};

type Random = () => number;

function isOwnWords(material: Material): boolean {
  return material.kind !== "choice";
}

function pickOne<T>(items: readonly T[], random: Random): T {
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))];
}

function shuffled<T>(items: readonly T[], random: Random): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function chooseMain(materials: readonly Material[], random: Random): Material[] {
  const ownWords = materials.filter(isOwnWords);
  if (ownWords.length > 0) return ownWords.slice(0, 2);

  const best = Math.min(...materials.map((m) => ROLE_PRIORITY[m.role]));
  const top = shuffled(
    materials.filter((m) => ROLE_PRIORITY[m.role] === best),
    random,
  );
  const others = shuffled(
    materials.filter((m) => ROLE_PRIORITY[m.role] !== best && m.role !== "visit"),
    random,
  );
  const count = random() < 0.6 ? 1 : 2;
  return [...top, ...others].slice(0, count);
}

// 長さの目安は、書ける体験の量で決める(来店回数は前置きなので数えない)。体験が少ないのに長めを
// 選ぶと水増しになるので、短めにする。本人の言葉が長いときは長めも選べる。
function chooseLength(used: readonly Material[], random: Random): DraftLength {
  const content = used.filter((m) => m.role !== "visit");
  const contentChars = content.reduce((sum, m) => sum + [...m.text].length, 0);
  let options: DraftLength[];
  if (content.length <= 1) options = ["short"];
  else if (content.length === 2) options = ["short", "medium"];
  else options = ["medium", "long"];
  if (contentChars > 120 && !options.includes("long")) options = [...options, "long"];
  return pickOne(options, random);
}

function allowedOpenings(used: readonly Material[], supportCount: number): OpeningStyle[] {
  const openings: OpeningStyle[] = ["main"];
  if (used.some(isOwnWords)) openings.push("own_words");
  if (used.some((m) => m.role === "reason")) openings.push("reason");
  if (used.some((m) => m.role === "staff_shop")) openings.push("staff_shop");
  if (used.some((m) => m.role === "visit")) openings.push("visit");
  if (supportCount > 0) openings.push("small_detail");
  return openings;
}

function allowedClosings(used: readonly Material[]): ClosingStyle[] {
  const hasIntent = used.some(
    (m) => findPhrases(m.text, [...REVISIT_PHRASES, ...RECOMMEND_PHRASES]).length > 0,
  );
  // 否定的な内容があるときに「全体の感想」や前向きな気持ちで締めると、否定を帳消しにして見える。
  // そのときは特別な締めを足さない(本人が今後の意向を書いていれば、その意向では締めてよい)。
  if (used.some((m) => m.negative)) return hasIntent ? ["plain", "intent"] : ["plain"];
  return ["impression", "plain", "intent"];
}

function allowedExclamations(used: readonly Material[]): ExclamationStyle[] {
  // 否定的な内容があるときは、最後の文が否定的な内容になりやすいので「最後の文だけ」は選ばない
  // (否定的な内容の文に感嘆符を付けると、温度感が回答とずれる)。
  if (used.some((m) => m.negative)) return ["none", "inline"];
  return ["none", "last", "inline"];
}

function candidatePlan(materials: readonly Material[], random: Random): CompositionPlan {
  const main = chooseMain(materials, random);
  const mainIds = new Set(main.map((m) => m.id));

  // 否定的な素材と本人の言葉は、必ず使う。
  const required = materials.filter((m) => !mainIds.has(m.id) && (m.negative || isOwnWords(m)));
  const requiredIds = new Set(required.map((m) => m.id));
  const pool = shuffled(
    materials.filter((m) => !mainIds.has(m.id) && !requiredIds.has(m.id)),
    random,
  );
  // 回答をすべて口コミに入れる必要はない(2026-10-04)。主役の1〜2個の体験を中心にし、
  // ほかの補助は0〜1個だけ足す(否定的な素材と本人の言葉は、上の required で必ず使う)。
  const extraCount = Math.min(pool.length, Math.floor(random() * 2));
  const support = [...required, ...pool.slice(0, extraCount)];
  // 否定的な素材だけの口コミにしない。お客様が肯定的にも答えていれば、そのうち1つは必ず使う
  // (否定だけが残ると、回答全体より厳しい口コミになるため)。来店回数は肯定的な内容に数えない。
  const isPositive = (m: Material) => !m.negative && m.role !== "visit";
  if (!main.some(isPositive) && !support.some(isPositive)) {
    const positive = pool
      .filter((m) => isPositive(m) && !support.includes(m))
      .sort((a, b) => ROLE_PRIORITY[a.role] - ROLE_PRIORITY[b.role])[0];
    if (positive) support.push(positive);
  }
  // 書ける内容が少なすぎると、一言で終わる口コミになる(「友達にもすすめたいです！」だけ など)。
  // 使う内容(来店回数を除く)が短ければ、肯定的な補助を1つ足す。
  const contentChars = (list: readonly Material[]) =>
    list.filter((m) => m.role !== "visit").reduce((sum, m) => sum + [...m.text].length, 0);
  if (contentChars([...main, ...support]) < THIN_CONTENT_CHARS) {
    const extra = pool
      .filter((m) => isPositive(m) && !support.includes(m))
      .sort((a, b) => ROLE_PRIORITY[a.role] - ROLE_PRIORITY[b.role])[0];
    if (extra) support.push(extra);
  }
  const supportIds = new Set(support.map((m) => m.id));

  const used = materials.filter((m) => mainIds.has(m.id) || supportIds.has(m.id));

  return {
    mainIds: main.map((m) => m.id),
    supportIds: materials.filter((m) => supportIds.has(m.id)).map((m) => m.id),
    unusedIds: materials.filter((m) => !mainIds.has(m.id) && !supportIds.has(m.id)).map((m) => m.id),
    length: chooseLength(used, random),
    opening: pickOne(allowedOpenings(used, support.length), random),
    closing: pickOne(allowedClosings(used), random),
    exclamation: pickOne(allowedExclamations(used), random),
  };
}

/** 構成が同じかどうかを比べるための文字列。 */
export function planSignature(plan: Pick<CompositionPlan, "mainIds" | "supportIds" | "length" | "opening" | "closing">): string {
  return [
    [...plan.mainIds].sort().join(","),
    [...plan.supportIds].sort().join(","),
    plan.length,
    plan.opening,
    plan.closing,
  ].join("|");
}

const REGENERATE_ATTEMPTS = 12;

/**
 * 構成プランを決める。previous があれば(再生成)、前回と違う構成になるよう選び直す。
 * 素材が少なくて違う構成が作れないときは、書き出しだけでも変える。
 */
export function buildCompositionPlan(
  materials: readonly Material[],
  options: { random?: Random; previous?: PreviousPlan } = {},
): CompositionPlan {
  if (materials.length === 0) throw new Error("素材がありません");
  const random = options.random ?? Math.random;
  const previous = options.previous;
  if (!previous) return candidatePlan(materials, random);

  const previousSignature = planSignature(previous);
  let plan = candidatePlan(materials, random);
  for (let i = 1; i < REGENERATE_ATTEMPTS && planSignature(plan) === previousSignature; i++) {
    plan = candidatePlan(materials, random);
  }
  if (planSignature(plan) === previousSignature) {
    const used = materials.filter((m) => plan.mainIds.includes(m.id) || plan.supportIds.includes(m.id));
    const otherOpenings = allowedOpenings(used, plan.supportIds.length).filter((o) => o !== previous.opening);
    if (otherOpenings.length > 0) plan = { ...plan, opening: pickOne(otherOpenings, random) };
  }
  return plan;
}
