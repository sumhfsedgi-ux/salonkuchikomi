import { describe, expect, it } from "vitest";
import { filterNavItemsByPlan, getNavItems } from "@/components/layout/navItems";

const hrefs = (items: { href: string }[]) => items.map((item) => item.href);

describe("ナビの契約プランによる出し分け", () => {
  it("salonpack モードで reviews プランの店舗には、ブログ・予約通知を出さない", () => {
    expect(hrefs(filterNavItemsByPlan(getNavItems("salonpack"), "reviews"))).toEqual([
      "/dashboard",
      "/dashboard/reviews",
    ]);
  });

  it("salonpack モードで salonpack プランの店舗にはすべて出す", () => {
    expect(hrefs(filterNavItemsByPlan(getNavItems("salonpack"), "salonpack"))).toEqual([
      "/dashboard",
      "/dashboard/reviews",
      "/dashboard/blog",
      "/dashboard/notifications",
    ]);
  });

  it("reviews モードはどちらのプランでも口コミだけ", () => {
    for (const plan of ["reviews", "salonpack"] as const) {
      expect(hrefs(filterNavItemsByPlan(getNavItems("reviews"), plan))).toEqual(["/dashboard/reviews"]);
    }
  });
});
