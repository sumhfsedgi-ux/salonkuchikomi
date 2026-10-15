"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { REVIEWS_SETTINGS_TAB_PATH, REVIEWS_TAB_PATH, SURVEY_TAB_PATH } from "@/lib/features/reviewsEntry";

// 「口コミ」の中のタブ:口コミ | アンケート | 設定。メニュー(Sidebar/BottomNav)は「口コミ」1項目のまま増やさない。
// タブは Google口コミ(google_reviews)を使える店舗にだけ出す(使えない店舗はアンケートの画面だけで、今と同じ)。
// タブの名前だけを変えたので、URL は変えない(lib/features/reviewsEntry.ts)。見た目と動きは BlogSubNav と同じ。
export const REVIEWS_SUB_NAV_ITEMS = [
  { href: REVIEWS_TAB_PATH, label: "口コミ" },
  { href: SURVEY_TAB_PATH, label: "アンケート" },
  { href: REVIEWS_SETTINGS_TAB_PATH, label: "設定" },
] as const;

export function isReviewsSubNavActive(pathname: string, href: string): boolean {
  if (href === SURVEY_TAB_PATH) return pathname === SURVEY_TAB_PATH;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function ReviewsSubNav({ showInbox }: { showInbox: boolean }) {
  const pathname = usePathname();
  if (!showInbox) return null;

  return (
    <nav className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" aria-label="口コミ機能内のナビゲーション">
      {REVIEWS_SUB_NAV_ITEMS.map((item) => {
        const active = isReviewsSubNavActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "min-h-9 shrink-0 whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/50 focus-visible:ring-offset-2 focus-visible:ring-offset-ivory",
              active ? "bg-sage-soft text-sage-dark" : "text-ink-muted hover:bg-ivory hover:text-ink",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
