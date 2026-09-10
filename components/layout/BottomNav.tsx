"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { NAV_ITEMS, isNavItemActive } from "@/components/layout/navItems";

// The mobile navigation surface: a fixed bottom bar with exactly 4 items
// (per the design brief's "5個以上を無理に並べない" rule) -- サロン設定 /
// アカウント / ログアウト live in ProfileMenu instead, reached from
// MobileHeader.
export default function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-white/95 backdrop-blur md:hidden"
      aria-label="メインナビゲーション"
    >
      <div
        className="mx-auto grid max-w-md grid-cols-4"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {NAV_ITEMS.map((item) => {
          const active = isNavItemActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              // min-h-14 (56px) keeps the tap target comfortably above the
              // 44px minimum even with the label text underneath the icon.
              className={cn(
                "flex min-h-14 flex-col items-center justify-center gap-1 py-2 text-xs font-medium transition",
                active ? "text-sage-dark" : "text-ink-muted",
              )}
            >
              <Icon className="h-6 w-6" />
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
