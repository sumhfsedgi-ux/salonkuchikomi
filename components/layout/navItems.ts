import type { ComponentType, SVGProps } from "react";
import { HomeIcon, ReviewIcon, BlogIcon, BellIcon } from "@/components/ui/icons";
import type { AppMode, Feature } from "@/lib/appMode";
import { isFeatureEnabledForPlan, type SalonPlan } from "@/lib/access/plan";

export interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** 無ければ常時表示(例: ホーム)。あれば店舗の契約プランでも出し分ける。 */
  feature?: Feature;
}

// Shared between Sidebar (PC) and BottomNav (mobile) so the two surfaces
// can never silently drift out of sync on labels/order/icons.
//
// これはAPP_MODE(そのデプロイが提供しうる機能)だけを見た表示上の出し分け。
// 実際のアクセス可否は各ページ/Server Actionがlib/access/featureAccess.tsの
// requireFeatureAccess()で別途判定する(店舗の契約プランも見る) -- ナビを
// 出し分けるだけではアクセス制御にならない。ただし「見えるのに開けない」
// 項目を並べないよう、呼び出し側はfilterNavItemsByPlan()で店舗のplanも
// 必ず適用すること(ホーム画面のカードと同じ判定をナビにも揃えるため)。
export function getNavItems(mode: AppMode): NavItem[] {
  // reviewsモードは現状「口コミ」が唯一の主要機能のため「ホーム」を省く
  // (同じ遷移先の項目を並べない)。将来reviewsモードに機能が増えたら、
  // この配列にホームを1行足すだけで復活できる。
  if (mode === "reviews") {
    return [{ href: "/dashboard/reviews", label: "口コミ", icon: ReviewIcon, feature: "reviews" }];
  }

  return [
    { href: "/dashboard", label: "ホーム", icon: HomeIcon },
    { href: "/dashboard/reviews", label: "口コミ", icon: ReviewIcon, feature: "reviews" },
    { href: "/dashboard/blog", label: "ブログ", icon: BlogIcon, feature: "blog" },
    { href: "/dashboard/notifications", label: "予約通知", icon: BellIcon, feature: "notifications" },
  ];
}

/** 店舗の契約プランで利用できない機能のナビ項目を取り除く。featureの無い項目(ホーム等)は常に残す。 */
export function filterNavItemsByPlan(items: NavItem[], plan: SalonPlan): NavItem[] {
  return items.filter((item) => !item.feature || isFeatureEnabledForPlan(plan, item.feature));
}

export function isNavItemActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(`${href}/`);
}
