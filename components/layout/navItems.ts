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
  const items: NavItem[] = [
    { href: "/dashboard", label: "ホーム", icon: HomeIcon },
    { href: "/dashboard/reviews", label: "口コミ", icon: ReviewIcon },
  ];
  if (mode === "salonpack") {
    items.push(
      { href: "/dashboard/blog", label: "ブログ", icon: BlogIcon },
      { href: "/dashboard/notifications", label: "予約通知", icon: BellIcon },
    );
  }
  return items;
}

export function isNavItemActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(`${href}/`);
}
