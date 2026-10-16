import type { ReviewFilter, ReviewListQuery, ReviewRatingFilter, ReviewSort } from "@/lib/googleReviews/types";

// 一覧の絞り込み・並び順を URL のクエリで持つ。既定値はクエリに書かない。一覧と詳細の間のリンクでは、このクエリを引き継ぐ。

export const DEFAULT_LIST_QUERY: ReviewListQuery = { filter: "unreplied", rating: "all", sort: "newest" };

const FILTERS: readonly ReviewFilter[] = ["unreplied", "attention", "replied", "all", "new"];
const RATINGS: readonly ReviewRatingFilter[] = ["all", "5", "4", "3", "low"];
const SORTS: readonly ReviewSort[] = ["newest", "lowest"];

/** 絞り込みの表示名(並びもこの順)。 */
export const FILTER_LABELS: ReadonlyArray<{ value: ReviewFilter; label: string }> = [
  { value: "unreplied", label: "未返信" },
  { value: "attention", label: "確認が必要" },
  { value: "replied", label: "返信済み" },
  { value: "all", label: "すべて" },
];

type ParamsLike = { get(name: string): string | null };

function pick<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export function parseListQuery(params: ParamsLike): ReviewListQuery {
  return {
    filter: pick(params.get("filter"), FILTERS, DEFAULT_LIST_QUERY.filter),
    rating: pick(params.get("rating"), RATINGS, DEFAULT_LIST_QUERY.rating),
    sort: pick(params.get("sort"), SORTS, DEFAULT_LIST_QUERY.sort),
  };
}

export function isListFilter(value: unknown): value is ReviewFilter {
  return typeof value === "string" && (FILTERS as readonly string[]).includes(value);
}

export function isRatingFilter(value: unknown): value is ReviewRatingFilter {
  return typeof value === "string" && (RATINGS as readonly string[]).includes(value);
}

export function isSort(value: unknown): value is ReviewSort {
  return typeof value === "string" && (SORTS as readonly string[]).includes(value);
}

/** 既定値を除いたクエリ文字列("" か "filter=all&sort=lowest" の形)。 */
export function listQueryString(query: ReviewListQuery): string {
  const params = new URLSearchParams();
  if (query.filter !== DEFAULT_LIST_QUERY.filter) params.set("filter", query.filter);
  if (query.rating !== DEFAULT_LIST_QUERY.rating) params.set("rating", query.rating);
  if (query.sort !== DEFAULT_LIST_QUERY.sort) params.set("sort", query.sort);
  return params.toString();
}

export function withQuery(path: string, query: ReviewListQuery): string {
  const qs = listQueryString(query);
  return qs ? `${path}?${qs}` : path;
}

export function sameListQuery(a: ReviewListQuery, b: ReviewListQuery): boolean {
  return a.filter === b.filter && a.rating === b.rating && a.sort === b.sort;
}

export const INBOX_PATH = "/dashboard/reviews/google";

export function reviewDetailPath(id: string, query: ReviewListQuery, basePath: string = INBOX_PATH): string {
  return withQuery(`${basePath}/${encodeURIComponent(id)}`, query);
}
