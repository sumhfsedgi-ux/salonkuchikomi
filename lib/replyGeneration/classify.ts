import { findNegativeMarkers, normalize } from "@/lib/ai/naturalJapanese/analyze";
import { NEGATION_AFTER_MARKER } from "@/lib/ai/naturalJapanese/phrases";

// 口コミの★と本文から、返信の方針(モード)を決める(docs/plans/google-reviews-inbox-plan.md §9-2)。
// LLM には決めさせず、コードで決める。★だけでは決めない:
//   ・★4〜5でも、本文に不満・要望が書かれていれば「混合」にする。
//   ・★の数にかかわらず、けが・肌の異常・返金の要求・衛生・暴言など、トラブルにつながる内容が
//     書かれていれば「慎重」にする。

export type StarRating = 1 | 2 | 3 | 4 | 5;

export type ReplyMode =
  /** 評価によらず本文が無い。出来事・意見を想定しない。 */
  | "thanks_only"
  /** ★3以上で、明確な不満・要望・トラブルを検出していない(中立を含む)。 */
  | "positive"
  /** ★3以上で、不満・要望が書かれている。 */
  | "mixed"
  /** ★1〜2、または★にかかわらずトラブルにつながる内容が書かれている。慎重モード。 */
  | "careful";

/** モードを決めた理由(イベントの記録用。本文は含めない)。 */
export type ReplyModeTrigger = "rating" | "serious_text" | "complaint_text" | "no_text" | "none";

export interface ReviewClassification {
  mode: ReplyMode;
  trigger: ReplyModeTrigger;
  rating: StarRating;
  hasText: boolean;
  /** 本文に見つかった不満・要望の目印(ログには出さない)。 */
  complaintMarkers: string[];
  /** 本文に見つかった、トラブルにつながる内容の目印(ログには出さない)。 */
  seriousMarkers: string[];
}

// 口コミ生成の NEGATIVE_MARKERS(phrases.ts)に無い、返信で拾いたい不満・要望の言い方。
const COMPLAINT_MARKERS = [
  "取りにく",
  "取りづら",
  "取れにく",
  "あればもっと",
  "あれば嬉し",
  "あればうれし",
  "あれば助か",
  "してほしい",
  "してほしかった",
  "して欲しい",
  "してもらいたい",
  "改善してほし",
  "悪かった",
  "最悪",
  "説明と違",
  "聞いていな",
  "聞いてな",
  "冷たく感じ",
  "イメージと少し違",
  "イメージと違",
];

// ★の数にかかわらず慎重に返信すべき内容(体・お金・衛生・安全・法的な話)。
// 「赤みが引いた」「アレルギーに配慮してくれた」のような良い内容に当たらないよう、起きたことを表す形にしている。
const SERIOUS_MARKERS = [
  "けが",
  "怪我",
  "ケガ",
  "火傷",
  "やけど",
  "赤くな",
  "腫れて",
  "腫れ上が",
  "かぶれて",
  "ただれ",
  "出血",
  "悪化し",
  "皮膚科",
  "返金",
  "お金を返",
  "治療費",
  "慰謝料",
  "弁償",
  "訴え",
  "訴訟",
  "弁護士",
  "警察",
  "保健所",
  "消費者センター",
  "不衛生",
  "盗ま",
  "紛失",
  "壊され",
  "破損",
  "セクハラ",
  "暴言",
  "怒鳴",
  "詐欺",
  "ぼったくり",
  "二度と行",
];

/** 目印を探す。直後で打ち消されている目印(「けがもなく」など)は除く。 */
function findMarkers(text: string, markers: readonly string[]): string[] {
  const target = normalize(text);
  const found: string[] = [];
  for (const marker of markers) {
    const needle = normalize(marker);
    let from = 0;
    for (;;) {
      const index = target.indexOf(needle, from);
      if (index === -1) break;
      if (!NEGATION_AFTER_MARKER.test(target.slice(index + needle.length))) {
        found.push(marker);
        break;
      }
      from = index + needle.length;
    }
  }
  return found;
}

export function isStarRating(value: unknown): value is StarRating {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

export function classifyReview(reviewText: string, rating: StarRating): ReviewClassification {
  const text = reviewText.trim();
  const hasText = text.length > 0;
  const seriousMarkers = hasText ? findMarkers(text, SERIOUS_MARKERS) : [];
  const complaintMarkers = hasText
    ? [...new Set([...findNegativeMarkers(text), ...findMarkers(text, COMPLAINT_MARKERS)])]
    : [];
  // 英語の補助語彙。多言語全般や複雑な否定を網羅する分類ではない。
  if (/\b(?:refund|burned|burnt|rash|unhygienic|injur\w*|medical bills?|rude)\b/i.test(text)) seriousMarkers.push("english_serious");
  if (/\b(?:waited|disappointed|expensive|dirty|unfriendly|overcharged)\b|(?:hard|difficult) to book|not (?:good|happy|satisfied)/i.test(text)) complaintMarkers.push("english_complaint");

  let mode: ReplyMode;
  let trigger: ReplyModeTrigger;
  if (!hasText) {
    mode = "thanks_only";
    trigger = "no_text";
  } else if (rating <= 2) {
    mode = "careful";
    trigger = "rating";
  } else if (seriousMarkers.length > 0) {
    mode = "careful";
    trigger = "serious_text";
  } else if (complaintMarkers.length > 0) {
    mode = "mixed";
    trigger = "complaint_text";
  } else {
    mode = "positive";
    trigger = "none";
  }

  return { mode, trigger, rating, hasText, complaintMarkers, seriousMarkers };
}
