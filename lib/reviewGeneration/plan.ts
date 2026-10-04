// 口コミ生成 v3 の Style Seed(docs/plans/reviews-465-plan.md §14-4)。
// 生成ごとに書き方の「傾向」を独立に選び、毎回同じ書き方に収束するのを防ぐ。
// 傾向であって hard constraint ではない(LLM には「自然さを優先して外れてよい」と伝える)。
// 事実の内容は変えない。どの素材を使うかも決めない(否定的な素材を必ず使うことは、
// プロンプトと Linter で守る)。

import { z } from "zod";
import type { Material } from "@/lib/reviewGeneration/materials";

export const LENGTH_TENDENCIES = ["short", "medium", "slightly_long"] as const;
export const EMOTION_TENDENCIES = ["none", "low", "medium"] as const;
export const EXCLAMATION_TENDENCIES = ["none", "occasional", "expressive"] as const;
export const OPENING_TENDENCIES = ["fact", "own_words", "reason", "feeling", "visit"] as const;
export const CLOSING_TENDENCIES = ["none_preferred", "neutral", "short_intention_allowed"] as const;
export const MATERIAL_AMOUNTS = ["few", "some", "many"] as const;
export const TONES = ["plain", "light", "match_voice"] as const;

export interface StyleSeed {
  length: (typeof LENGTH_TENDENCIES)[number];
  emotion: (typeof EMOTION_TENDENCIES)[number];
  exclamation: (typeof EXCLAMATION_TENDENCIES)[number];
  opening: (typeof OPENING_TENDENCIES)[number];
  closing: (typeof CLOSING_TENDENCIES)[number];
  materialAmount: (typeof MATERIAL_AMOUNTS)[number];
  tone: (typeof TONES)[number];
}

/** 再生成のときにクライアントから受け取る前回の Style Seed(素材の本文は含まない)。 */
export const previousStyleSeedSchema = z.object({
  length: z.enum(LENGTH_TENDENCIES),
  emotion: z.enum(EMOTION_TENDENCIES),
  exclamation: z.enum(EXCLAMATION_TENDENCIES),
  opening: z.enum(OPENING_TENDENCIES),
  closing: z.enum(CLOSING_TENDENCIES),
  materialAmount: z.enum(MATERIAL_AMOUNTS),
  tone: z.enum(TONES),
});

export type PreviousStyleSeed = z.infer<typeof previousStyleSeedSchema>;

type Random = () => number;
type Weighted<T> = ReadonlyArray<readonly [T, number]>;

function pickWeighted<T>(options: Weighted<T>, random: Random): T {
  const total = options.reduce((sum, [, weight]) => sum + weight, 0);
  let rest = random() * total;
  for (const [value, weight] of options) {
    rest -= weight;
    if (rest < 0) return value;
  }
  return options[options.length - 1][0];
}

function hasVoice(materials: readonly Material[]): boolean {
  return materials.some((m) => m.kind !== "choice");
}

function allowedOpenings(materials: readonly Material[]): StyleSeed["opening"][] {
  const openings: StyleSeed["opening"][] = ["fact", "feeling"];
  if (hasVoice(materials)) openings.push("own_words");
  if (materials.some((m) => m.role === "reason")) openings.push("reason");
  if (materials.some((m) => m.role === "visit")) openings.push("visit");
  return openings;
}

function candidateSeed(materials: readonly Material[], random: Random): StyleSeed {
  const content = materials.filter((m) => m.role !== "visit");
  const openings = allowedOpenings(materials);
  return {
    // 書ける内容が少ないのに長めを選ぶと水増しになるので、短め・ふつうだけにする。
    length: pickWeighted(
      content.length <= 1
        ? [["short", 3], ["medium", 2]]
        : [["short", 3], ["medium", 4], ["slightly_long", 2]],
      random,
    ),
    // 気持ちは回答と同じ方向に少し強めてよい(review-v3.1)。控えめな書き方も残す。
    emotion: pickWeighted([["none", 2], ["low", 4], ["medium", 3]], random),
    exclamation: pickWeighted([["none", 3], ["occasional", 4], ["expressive", 2]], random),
    opening: openings[Math.min(openings.length - 1, Math.floor(random() * openings.length))],
    // 意向(「また来たい」など)の締めは、回答に意向があるときだけ選べる。選んでも必ず使う必要はない。
    closing: pickWeighted(
      materials.some((m) => m.intent)
        ? [["none_preferred", 1], ["neutral", 1], ["short_intention_allowed", 1]]
        : [["none_preferred", 1], ["neutral", 1]],
      random,
    ),
    materialAmount: pickWeighted(
      content.length <= 2 ? [["few", 1], ["some", 1]] : [["few", 4], ["some", 4], ["many", 1]],
      random,
    ),
    // くだけた口調は、本人の文章があるときだけその口調に合わせる。無ければ「です・ます」の範囲で揺らす。
    tone: hasVoice(materials) ? "match_voice" : pickWeighted([["plain", 3], ["light", 2]], random),
  };
}

/** Style Seed が同じかどうかを比べるための文字列。 */
export function styleSeedSignature(seed: StyleSeed): string {
  return [seed.length, seed.emotion, seed.exclamation, seed.opening, seed.closing, seed.materialAmount, seed.tone].join("|");
}

const RETRY_ATTEMPTS = 12;

/** 前回と違う Style Seed を選ぶ(再生成と、構造の問題での作り直しに使う)。 */
export function alternativeStyleSeed(
  materials: readonly Material[],
  previous: StyleSeed,
  random: Random = Math.random,
): StyleSeed {
  const previousSignature = styleSeedSignature(previous);
  let seed = candidateSeed(materials, random);
  for (let i = 1; i < RETRY_ATTEMPTS && styleSeedSignature(seed) === previousSignature; i++) {
    seed = candidateSeed(materials, random);
  }
  // 選び直しても同じなら、感情の言葉の傾向を1段ずらす(どの素材でも3つから選べる要素)。
  if (styleSeedSignature(seed) === previousSignature) {
    const index = EMOTION_TENDENCIES.indexOf(seed.emotion);
    seed = { ...seed, emotion: EMOTION_TENDENCIES[(index + 1) % EMOTION_TENDENCIES.length] };
  }
  return seed;
}

/** Style Seed を選ぶ。previous があれば(再生成)、前回と違う組み合わせにする。 */
export function buildStyleSeed(
  materials: readonly Material[],
  options: { random?: Random; previous?: PreviousStyleSeed } = {},
): StyleSeed {
  if (materials.length === 0) throw new Error("素材がありません");
  const random = options.random ?? Math.random;
  return options.previous
    ? alternativeStyleSeed(materials, options.previous, random)
    : candidateSeed(materials, random);
}
