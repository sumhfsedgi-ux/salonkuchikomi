import type { ComponentType, SVGProps } from "react";
import { HomeIcon, ReviewIcon, BlogIcon, BellIcon } from "@/components/ui/icons";
import type { AppMode } from "@/lib/appMode";

export interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}

// Shared between Sidebar (PC) and BottomNav (mobile) so the two surfaces
// can never silently drift out of sync on labels/order/icons.
//
// これはAPP_MODE(そのデプロイが提供しうる機能)だけを見た表示上の出し分け。
// 実際のアクセス可否は各ページ/Server Actionがlib/access/featureAccess.tsの
// requireFeatureAccess()で別途判定する(店舗の契約プランも見る) -- ナビを
// 出し分けるだけではアクセス制御にならない。
export function getNavItems(mode: AppMode): NavItem[] {
  // reviewsモードは現状「口コミ」が唯一の主要機能のため「ホーム」を省く
  // (同じ遷移先の項目を並べない)。将来reviewsモードに機能が増えたら、
  // この配列にホームを1行足すだけで復活できる。
  if (mode === "reviews") {
    return [{ href: "/dashboard/reviews", label: "口コミ", icon: ReviewIcon }];
  }

  return [
    { href: "/dashboard", label: "ホーム", icon: HomeIcon },
    { href: "/dashboard/reviews", label: "口コミ", icon: ReviewIcon },
    { href: "/dashboard/blog", label: "ブログ", icon: BlogIcon },
    { href: "/dashboard/notifications", label: "予約通知", icon: BellIcon },
  ];
}

export function isNavItemActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(`${href}/`);
}
