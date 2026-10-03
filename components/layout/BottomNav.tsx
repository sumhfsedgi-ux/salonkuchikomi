"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { SettingsIcon } from "@/components/ui/icons";
import { getNavItems, filterNavItemsByPlan, isNavItemActive } from "@/components/layout/navItems";
import { getAppMode } from "@/lib/appMode";
import type { SalonPlan } from "@/lib/access/plan";

// grid-cols-Nはtailwindが動的クラス名を解決できないため、項目数からの
// ルックアップで静的なクラス名を選ぶ(navItemsは現状2件(reviewsモード)か
// 4件(salonpackモード)のどちらか)。
const GRID_COLS_CLASS: Record<number, string> = {
  2: "grid-cols-2",
  4: "grid-cols-4",
};

// The mobile navigation surface: a fixed bottom bar (per the design brief's
// "5個以上を無理に並べない" rule)。SalonPackモードではサロン設定/アカウント/
// ログアウトはProfileMenuの方に置いている(MobileHeaderから開く)。reviewsモードは
// 主要機能が口コミ1つだけなので、常時アクセスできるよう「設定」をここに直接
// 表示する(ProfileMenu側の「サロン設定」はreviewsモードでは非表示にして
// 導線の重複を避けている -- components/layout/ProfileMenu.tsx参照)。
export default function BottomNav({ plan }: { plan: SalonPlan }) {
  const pathname = usePathname();
  const mode = getAppMode();
  const navItems = filterNavItemsByPlan(getNavItems(mode), plan);
  if (mode === "reviews") {
    navItems.push({ href: "/dashboard/settings", label: "設定", icon: SettingsIcon });
  }

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-white/95 backdrop-blur md:hidden"
      aria-label="メインナビゲーション"
    >
      <div
        className={cn("mx-auto grid max-w-md", GRID_COLS_CLASS[navItems.length] ?? "grid-cols-4")}
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {navItems.map((item) => {
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
