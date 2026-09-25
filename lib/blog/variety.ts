// 直近の生成履歴をもとに、今回使う構成・書き出し・締め方・テーマカテゴリを
// サーバー側で決めるロジック。AIの自己判断だけに頼ると同じパターンが連続しやすいため、
// ここで先に選んだ結果を「今回の指定」としてプロンプトに渡す（lib/blog/prompts.ts参照）。
// (blog-appの lib/variety.ts を無変更で移植、import pathのみ更新)

import {
  STRUCTURE_TYPE_IDS,
  OPENING_STYLE_IDS,
  ENDING_STYLE_IDS,
  THEME_CATEGORY_IDS,
  RECENT_EXCLUDE_COUNT,
  type StructureTypeId,
  type OpeningStyleId,
  type EndingStyleId,
  type ThemeCategoryId,
} from "@/lib/blog/config/blogRules";
import type { RecentPostSummary } from "@/lib/blog/types";

interface WeightedCandidate<T extends string> {
  id: T;
  weight: number;
}

function dedupeInOrder<T>(values: T[]): T[] {
  const seen = new Set<T>();
  const result: T[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      result.push(v);
    }
  }
  return result;
}

function weightedRandomPick<T extends string>(candidates: WeightedCandidate<T>[]): T {
  const total = candidates.reduce((sum, c) => sum + c.weight, 0);
  let r = Math.random() * total;
  for (const c of candidates) {
    if (r < c.weight) return c.id;
    r -= c.weight;
  }
  return candidates[candidates.length - 1].id;
}

function pickVaried<T extends string>(
  catalogIds: T[],
  recentValuesMostRecentFirst: T[],
  forceExclude: T[] = []
): T {
  const recentExcluded = dedupeInOrder(recentValuesMostRecentFirst).slice(0, RECENT_EXCLUDE_COUNT);
  const excluded = new Set<T>([...recentExcluded, ...forceExclude]);

  let candidates = catalogIds.filter((id) => !excluded.has(id));
  if (candidates.length === 0) {
    // カタログの件数からして通常は起こらないが、万一全滅した場合の安全弁。
    candidates = catalogIds;
  }

  const recentSet = new Set(recentValuesMostRecentFirst);
  const weighted = candidates.map((id) => ({ id, weight: recentSet.has(id) ? 1 : 2 }));
  return weightedRandomPick(weighted);
}

export interface PatternSelection {
  structureType: StructureTypeId;
  openingStyle: OpeningStyleId;
  endingStyle: EndingStyleId;
  themeCategory: ThemeCategoryId;
}

export interface ForceExclude {
  structureType?: StructureTypeId[];
  openingStyle?: OpeningStyleId[];
  endingStyle?: EndingStyleId[];
  themeCategory?: ThemeCategoryId[];
}

export function pickPatterns(
  recentPosts: RecentPostSummary[],
  forceExclude: ForceExclude = {}
): PatternSelection {
  return {
    structureType: pickVaried(
      STRUCTURE_TYPE_IDS,
      recentPosts.map((p) => p.structureType),
      forceExclude.structureType ?? []
    ),
    openingStyle: pickVaried(
      OPENING_STYLE_IDS,
      recentPosts.map((p) => p.openingStyle),
      forceExclude.openingStyle ?? []
    ),
    endingStyle: pickVaried(
      ENDING_STYLE_IDS,
      recentPosts.map((p) => p.endingStyle),
      forceExclude.endingStyle ?? []
    ),
    themeCategory: pickVaried(
      THEME_CATEGORY_IDS,
      recentPosts.map((p) => p.themeCategory),
      forceExclude.themeCategory ?? []
    ),
  };
}
