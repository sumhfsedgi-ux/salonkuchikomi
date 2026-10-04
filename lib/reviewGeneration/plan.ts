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

/** 文の数と文字数の目安(LLM への指示と、Linter の style 判定に使う)。 */
export const LENGTH_TARGETS: Record<DraftLength, { sentences: string; chars: { min: number; max: number } }> = {
  short: { sentences: "2〜3文", chars: { min: 30, max: 100 } },
  medium: { sentences: "3〜4文", chars: { min: 80, max: 160 } },
  long: { sentences: "4〜5文", chars: { min: 130, max: 220 } },
};

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

function chooseLength(usedCount: number, usedChars: number, random: Random): DraftLength {
  let options: DraftLength[];
  if (usedCount <= 2) options = ["short"];
  else if (usedCount === 3) options = ["short", "medium"];
  else if (usedCount === 4) options = ["medium"];
  else options = ["medium", "long"];
  if (usedChars > 120 && !options.includes("long")) options = [...options, "long"];
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
  // 回答が多いのに1〜2個しか使わないと、答えた内容が口コミにほとんど残らない。
  // 素材が4つ以上あるときは、補助を少なくとも1つ足す(0〜2個 → 1〜3個)。
  const minExtra = materials.length >= 4 ? 1 : 0;
  const extraCount = Math.min(pool.length, minExtra + Math.floor(random() * 3));
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
  const supportIds = new Set(support.map((m) => m.id));

  const used = materials.filter((m) => mainIds.has(m.id) || supportIds.has(m.id));
  const usedChars = used.reduce((sum, m) => sum + [...m.text].length, 0);

  return {
    mainIds: main.map((m) => m.id),
    supportIds: materials.filter((m) => supportIds.has(m.id)).map((m) => m.id),
    unusedIds: materials.filter((m) => !mainIds.has(m.id) && !supportIds.has(m.id)).map((m) => m.id),
    length: chooseLength(used.length, usedChars, random),
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
