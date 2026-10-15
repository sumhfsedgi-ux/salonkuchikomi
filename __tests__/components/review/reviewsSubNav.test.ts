import { describe, expect, it } from "vitest";
import { isReviewsSubNavActive, REVIEWS_SUB_NAV_ITEMS } from "@/components/reviews/ReviewsSubNav";

// 「口コミ」の中のタブ:口コミ | アンケート | 設定。名前と並びだけを変え、URL は変えない。

describe("口コミの画面のタブ", () => {
  it("並びは 口コミ | アンケート | 設定。URL は今までと同じ", () => {
    expect(REVIEWS_SUB_NAV_ITEMS.map((i) => [i.label, i.href])).toEqual([
      ["口コミ", "/dashboard/reviews/google"],
      ["アンケート", "/dashboard/reviews"],
      ["設定", "/dashboard/reviews/settings"],
    ]);
  });

  it("選択中:口コミは一覧と詳細、アンケートは /dashboard/reviews だけ、設定は設定だけ", () => {
    const activeOn = (path: string) => REVIEWS_SUB_NAV_ITEMS.filter((i) => isReviewsSubNavActive(path, i.href)).map((i) => i.label);
    expect(activeOn("/dashboard/reviews/google")).toEqual(["口コミ"]);
    expect(activeOn("/dashboard/reviews/google/abc")).toEqual(["口コミ"]);
    expect(activeOn("/dashboard/reviews")).toEqual(["アンケート"]);
    expect(activeOn("/dashboard/reviews/settings")).toEqual(["設定"]);
  });
});
