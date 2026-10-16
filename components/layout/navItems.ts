import type { ComponentType, SVGProps } from "react";
import { HomeIcon, ReviewIcon, BlogIcon, BellIcon } from "@/components/ui/icons";
import type { PlanExperience } from "@/lib/features/access";
import type { FeatureKey } from "@/lib/features/registry";
import { REVIEWS_SECTION_PATH, reviewsEntryPath } from "@/lib/features/reviewsEntry";

export interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** 無ければ常時表示(例: ホーム)。あればその機能を利用できる店舗だけに出す。 */
  featureKey?: FeatureKey;
  /** 選択中にする範囲(無ければ href)。「口コミ」は、どのタブでも選択中にする。 */
  activeHref?: string;
}

// Shared between Sidebar (PC) and BottomNav (mobile) so the two surfaces
// can never silently drift out of sync on labels/order/icons.
//
// メニューには、その店舗が利用できる機能(lib/features/access.ts の listUsableFeatureKeys。契約・APP_MODE・
// 提供状況)だけを出す。契約外・準備中の機能は出さない(SalonPack のホームでだけ紹介する)。設定が未完了の
// 機能は出し、各画面から設定へ進める。ただしメニューを隠すだけではアクセス制御にならないため、各ページ・
// Server Action・API でも requireFeatureAccess() / canAccessFeature() で同じ判定を行う。
const FEATURE_ITEMS: Array<NavItem & { featureKey: FeatureKey }> = [
  { href: REVIEWS_SECTION_PATH, label: "口コミ", icon: ReviewIcon, featureKey: "reviews", activeHref: REVIEWS_SECTION_PATH },
  { href: "/dashboard/blog", label: "ブログ", icon: BlogIcon, featureKey: "blog" },
  { href: "/dashboard/notifications", label: "予約通知", icon: BellIcon, featureKey: "reservation_notifications" },
  // Google口コミ(google_reviews)は単独のメニューを持たない(lib/features/registry.ts の listed)。「口コミ」の中のタブで使う。
];

/**
 * SalonPack は「ホーム + 利用できる機能」。口コミプランは機能一覧のホームを使わないため、ホームを出さない
 * (/dashboard は口コミの画面へ移動する)。サロン設定・ログアウトは、各メニューの下側に共通で置く。
 * Google口コミを使える店舗(reviewsTab)では、「口コミ」は「口コミ」タブを開く(lib/features/reviewsEntry.ts)。
 */
export function getNavItems(
  experience: PlanExperience,
  usableFeatures: readonly FeatureKey[],
  options: { reviewsTab?: boolean } = {},
): NavItem[] {
  const reviewsTab = options.reviewsTab === true;
  const features = FEATURE_ITEMS.filter((item) => usableFeatures.includes(item.featureKey) || (item.featureKey === "reviews" && reviewsTab)).map(
    (item) => (item.featureKey === "reviews" ? { ...item, href: reviewsEntryPath(reviewsTab) } : item),
  );
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
