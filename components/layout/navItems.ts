import type { ComponentType, SVGProps } from "react";
import { HomeIcon, ReviewIcon, BlogIcon, BellIcon } from "@/components/ui/icons";

export interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}

// Shared between Sidebar (PC) and BottomNav (mobile) so the two surfaces
// can never silently drift out of sync on labels/order/icons.
export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "ホーム", icon: HomeIcon },
  { href: "/dashboard/reviews", label: "口コミ", icon: ReviewIcon },
  { href: "/dashboard/blog", label: "ブログ", icon: BlogIcon },
  { href: "/dashboard/notifications", label: "予約通知", icon: BellIcon },
];

export function isNavItemActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(`${href}/`);
}
