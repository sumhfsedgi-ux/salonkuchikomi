// 口コミ生成の Appeal Planning(docs/plans/reviews-465-plan.md §14-10)。
// 「この口コミから、そのお店のどの良さが一番伝わるべきか」を、生成の前にコードで決める。
// 新しい事実は作らない。お客様が実際に評価している回答(Customer Evidence)の中から、
// お店の魅力として伝わりやすいものを主役に1〜2個選び、ほかは補助にする。
//
// 店舗情報(オーナーが登録した説明)はお客様の証拠とは分ける。回答と店舗の特徴が一致するときに、
// その回答を主役として優先するためにだけ使い、LLM には渡さない(店舗情報だけを体験として書かせないため)。
//
// Appeal Planning は「何を一番伝えるか」、Style Seed は「どう書くか」。この2つを混ぜない。

import { findPhrases } from "@/lib/ai/naturalJapanese/analyze";
import type { Material } from "@/lib/reviewGeneration/materials";

export const APPEAL_CATEGORIES = [
  "finish",
  "counseling",
  "service",
  "explanation",
  "atmosphere",
  "cleanliness",
  "access",
  "satisfaction",
  "feeling",
] as const;

export type AppealCategory = (typeof APPEAL_CATEGORIES)[number];

export const APPEAL_LABELS: Record<AppealCategory, string> = {
  finish: "仕上がり",
  counseling: "カウンセリング",
  service: "接客",
  explanation: "説明",
  atmosphere: "雰囲気",
  cleanliness: "清潔感",
  access: "通いやすさ",
  satisfaction: "満足度",
  feeling: "施術後の本人の感覚",
};

// 回答と店舗の説明の両方に当てる語(部分一致)。上にあるものほど、1つの回答に複数当たったときに優先する。
const APPEAL_PATTERNS: ReadonlyArray<readonly [AppealCategory, readonly string[]]> = [
  ["counseling", ["カウンセリング", "相談", "提案", "希望を", "要望", "悩みを聞", "話を聞", "聞いてくれ", "聞いてもら"]],
  ["finish", ["仕上が", "仕上げ", "イメージ通り", "理想通り", "思い通り", "色味", "デザイン", "持ちが", "持ちも", "持ちの", "かわい", "可愛", "きれい", "綺麗", "扱いやす", "まとまり", "似合"]],
  ["explanation", ["説明", "分かりやす", "わかりやす", "教えて"]],
  ["service", ["接客", "対応", "話しやす", "優し", "親身", "気遣い", "気配り", "力加減", "丁寧"]],
  ["cleanliness", ["清潔"]],
  ["atmosphere", ["雰囲気", "落ち着", "リラックス", "居心地", "静か", "癒"]],
  ["access", ["予約が取りやす", "予約しやす", "通いやす", "駅", "駐車", "アクセス"]],
  ["satisfaction", ["満足", "最高", "良かった", "よかった"]],
  ["feeling", ["しっとり", "なめらか", "つるっ", "軽く", "柔らか", "すっきり", "スッキリ", "明るく", "気持ちよ", "気持ち良", "ほぐ", "楽に", "ラクに"]],
];

// 主役の点数。本人の言葉を最優先し、店舗の特徴と一致する回答を前に出す。良さの種類は、お店の魅力として
// 伝わりやすいもの(仕上がり・カウンセリング)を重くし、雰囲気・清潔感などは補助になりやすくする。
const OWN_WORDS_SCORE = 3;
const STORE_MATCH_SCORE = 2;
const CATEGORY_WEIGHT: Record<AppealCategory, number> = {
  finish: 3,
  counseling: 3,
  service: 2,
  explanation: 2,
  feeling: 2,
  atmosphere: 1,
  cleanliness: 1,
  access: 1,
  satisfaction: 1,
};
/** 2つ目の主役にするのに必要な点数(良さとして評価している回答であること)。 */
const SECOND_PRIMARY_MIN_SCORE = 1;
const MAX_SUPPORT = 2;
/** これより短い、意向だけの本人の記入(「また来たいです」)は、主役ではなく締めの候補にする。 */
const INTENT_ONLY_MAX_CHARS = 10;

export interface AppealPlan {
  /** 口コミの中心にする回答(1〜2個)。 */
  primaryIds: string[];
  /** 必要なときだけ使う補助の回答。 */
  supportIds: string[];
  /** 締めに使ってよい回答(回答にある再来店の意向)。使わなくてよい。 */
  closingIds: string[];
  /** 必ず入れる回答(否定的な内容)。 */
  requiredIds: string[];
  /** 回答ごとの良さの分類(記録と表示用)。 */
  categories: Record<string, AppealCategory>;
  /** 店舗の特徴と一致したので優先した回答。 */
  storeMatchedIds: string[];
}

export function appealCategoriesOf(text: string): AppealCategory[] {
  return APPEAL_PATTERNS.filter(([, patterns]) => findPhrases(text, patterns).length > 0).map(([category]) => category);
}

function isContext(material: Material): boolean {
  // 来店回数・来店理由・メニューは背景で、お店の良さとしての評価ではない。
  return material.role === "visit" || material.role === "reason" || material.role === "menu";
}

/**
 * Customer Evidence から、伝えたい良さを決める。
 * storeDescription はオーナーが登録した説明(任意)。回答と一致する良さを優先するためだけに使う。
 */
export function buildAppealPlan(materials: readonly Material[], storeDescription?: string | null): AppealPlan {
  const storeCategories = new Set(storeDescription ? appealCategoriesOf(storeDescription) : []);
  const categories: Record<string, AppealCategory> = {};
  const storeMatchedIds: string[] = [];

  // 意向だけの回答(「また来ます」)は締めの候補にする。良さの評価や本人の体験も含む回答は主役の候補に残す。
  const intentOnly = (m: Material) =>
    m.intent && appealCategoriesOf(m.text).length === 0 && (m.kind === "choice" || [...m.text].length <= INTENT_ONLY_MAX_CHARS);
  const candidates = materials
    .filter((m) => !m.negative && !isContext(m) && !intentOnly(m))
    .map((m, order) => {
      const found = appealCategoriesOf(m.text);
      const category = found[0];
      if (category) categories[m.id] = category;
      const storeMatch = found.some((c) => storeCategories.has(c));
      if (storeMatch) storeMatchedIds.push(m.id);
      const score =
        (m.kind !== "choice" ? OWN_WORDS_SCORE : 0) +
        (category ? CATEGORY_WEIGHT[category] : 0) +
        (storeMatch ? STORE_MATCH_SCORE : 0);
      return { material: m, category, score, order };
    })
    .sort((a, b) => b.score - a.score || a.order - b.order);

  const primary = candidates.slice(0, 1);
  // 2つ目の主役は、別の種類の良さを評価している回答だけ(同じ良さを重ねない)。
  const second = candidates
    .slice(1)
    .find((c) => c.score >= SECOND_PRIMARY_MIN_SCORE && c.category !== undefined && c.category !== primary[0]?.category);
  if (second) primary.push(second);

  const primaryIds = new Set(primary.map((c) => c.material.id));
  const supportIds = candidates
    .filter((c) => !primaryIds.has(c.material.id) && c.category !== undefined)
    .slice(0, MAX_SUPPORT)
    .map((c) => c.material.id);

  return {
    primaryIds: primary.map((c) => c.material.id),
    supportIds,
    closingIds: materials.filter((m) => m.intent && !m.negative).map((m) => m.id),
    requiredIds: materials.filter((m) => m.negative).map((m) => m.id),
    categories,
    storeMatchedIds: storeMatchedIds.filter((id) => primaryIds.has(id)),
  };
}
