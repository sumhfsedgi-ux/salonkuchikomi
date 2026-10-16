"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { SettingsIcon } from "@/components/ui/icons";
import { getNavItems, isNavItemActive } from "@/components/layout/navItems";
import type { PlanExperience } from "@/lib/features/access";
import type { FeatureKey } from "@/lib/features/registry";

// grid-cols-Nはtailwindが動的クラス名を解決できないため、項目数からの
// ルックアップで静的なクラス名を選ぶ(項目は店舗が利用できる機能の数で1〜4件)。
const GRID_COLS_CLASS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-4",
};

// The mobile navigation surface: a fixed bottom bar (per the design brief's
// "5個以上を無理に並べない" rule)。SalonPackモードではサロン設定/アカウント/
// ログアウトはProfileMenuの方に置いている(MobileHeaderから開く)。口コミプランは
// 主要機能が口コミ1つだけなので、常時アクセスできるよう「設定」をここに直接
// 表示する(ProfileMenu側の「サロン設定」は口コミプランでは非表示にして
// 導線の重複を避けている -- components/layout/ProfileMenu.tsx参照)。
export default function BottomNav({
  experience,
  usableFeatures,
  reviewsTab,
}: {
  experience: PlanExperience;
  usableFeatures: FeatureKey[];
  reviewsTab: boolean;
}) {
  const pathname = usePathname();
  const navItems = getNavItems(experience, usableFeatures, { reviewsTab });
  if (experience === "reviews_direct") {
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
          const active = isNavItemActive(pathname, item.activeHref ?? item.href);
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
