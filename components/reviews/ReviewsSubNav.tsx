"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

// 「口コミ」の中のタブ(計画 第2版 §2)。メニュー(Sidebar/BottomNav)は「口コミ」1項目のまま増やさない。
// 「届いた口コミ」「設定」は、届いた口コミ(google_reviews)を使える店舗にだけ出す(使えない店舗の画面は今と同じ)。
// 見た目と動きは BlogSubNav と同じ。
const ITEMS = [
  { href: "/dashboard/reviews", label: "口コミを集める", inboxOnly: false },
  { href: "/dashboard/reviews/google", label: "届いた口コミ", inboxOnly: true },
  { href: "/dashboard/reviews/settings", label: "設定", inboxOnly: true },
] as const;

export function isReviewsSubNavActive(pathname: string, href: string): boolean {
  if (href === "/dashboard/reviews") return pathname === "/dashboard/reviews";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function ReviewsSubNav({ showInbox }: { showInbox: boolean }) {
  const pathname = usePathname();
  if (!showInbox) return null;

  return (
    <nav className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" aria-label="口コミ機能内のナビゲーション">
      {ITEMS.map((item) => {
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
