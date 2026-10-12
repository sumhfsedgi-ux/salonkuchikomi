import type { ComponentType, SVGProps } from "react";
import { HomeIcon, ReviewIcon, BlogIcon, BellIcon } from "@/components/ui/icons";
import type { PlanExperience } from "@/lib/features/access";
import type { FeatureKey } from "@/lib/features/registry";

export interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** 無ければ常時表示(例: ホーム)。あればその機能を利用できる店舗だけに出す。 */
  featureKey?: FeatureKey;
}

// Shared between Sidebar (PC) and BottomNav (mobile) so the two surfaces
// can never silently drift out of sync on labels/order/icons.
//
// メニューには、その店舗が利用できる機能(lib/features/access.ts の listUsableFeatureKeys。契約・APP_MODE・
// 提供状況)だけを出す。契約外・準備中の機能は出さない(SalonPack のホームでだけ紹介する)。設定が未完了の
// 機能は出し、各画面から設定へ進める。ただしメニューを隠すだけではアクセス制御にならないため、各ページ・
// Server Action・API でも requireFeatureAccess() / canAccessFeature() で同じ判定を行う。
const FEATURE_ITEMS: Array<NavItem & { featureKey: FeatureKey }> = [
  { href: "/dashboard/reviews", label: "口コミ", icon: ReviewIcon, featureKey: "reviews" },
  { href: "/dashboard/blog", label: "ブログ", icon: BlogIcon, featureKey: "blog" },
  { href: "/dashboard/notifications", label: "予約通知", icon: BellIcon, featureKey: "reservation_notifications" },
  // 届いた口コミは、受信箱などの中身と一緒に入れるまで出さない(lib/features/registry.ts の listed)。
];

/**
 * SalonPack は「ホーム + 利用できる機能」。口コミプランは機能一覧のホームを使わないため、ホームを出さない
 * (/dashboard は口コミの画面へ移動する)。サロン設定・ログアウトは、各メニューの下側に共通で置く。
 */
export function getNavItems(experience: PlanExperience, usableFeatures: readonly FeatureKey[]): NavItem[] {
  const features = FEATURE_ITEMS.filter((item) => usableFeatures.includes(item.featureKey));
  if (experience === "reviews_direct") return features;
  return [{ href: "/dashboard", label: "ホーム", icon: HomeIcon }, ...features];
}

export function isNavItemActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** サロン設定の項目を選択中にするか(その配下に別のメニュー項目がある画面では、そちらを優先する)。 */
export function isSettingsActive(pathname: string, items: readonly NavItem[]): boolean {
  if (!isNavItemActive(pathname, "/dashboard/settings")) return false;
  return !items.some((item) => item.href.startsWith("/dashboard/settings/") && isNavItemActive(pathname, item.href));
}
