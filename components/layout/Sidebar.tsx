"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import Logo from "@/components/ui/Logo";
import { SettingsIcon, LogOutIcon } from "@/components/ui/icons";
import { getNavItems, filterNavItemsByPlan, isNavItemActive } from "@/components/layout/navItems";
import { getAppMode } from "@/lib/appMode";
import type { SalonPlan } from "@/lib/access/plan";
import { logoutAction } from "@/app/dashboard/actions";

// The PC navigation surface: always-visible left sidebar, per the design
// brief's "PCはサイドバー+メインコンテンツを第一候補にする" direction.
// Hidden below the md breakpoint -- BottomNav takes over there.
//
// md:h-dvh + md:sticky md:top-0 + md:self-start: without these, this
// <aside> is just a plain flex child that stretches (CSS flexbox's default
// align-items: stretch) to match the height of the sibling content column
// -- which on a tall page (e.g. /dashboard/reviews with many survey
// questions) is much taller than one viewport, pushing サロン設定/ログアウト
// (at the bottom of this aside) below the fold. self-start opts this
// element out of that stretch; h-dvh caps it to exactly one viewport; sticky
// top-0 then pins that one-viewport box to the top as the (now taller,
// uncapped) page scrolls, so the whole nav stays on screen on every
// /dashboard/** page. md:overflow-y-auto is a safety net for short/zoomed
// viewports where even this one-viewport box can't fit logo+nav+footer --
// it scrolls internally instead of clipping, independent of main's scroll.
export default function Sidebar({ plan }: { plan: SalonPlan }) {
  const pathname = usePathname();
  const settingsActive = isNavItemActive(pathname, "/dashboard/settings");
  const mode = getAppMode();
  const navItems = filterNavItemsByPlan(getNavItems(mode), plan);
  // reviewsモードは/dashboardが結局/dashboard/reviewsへredirectするだけなので、
  // ロゴのリンク先は直接そこへ向ける(遠回りのredirectを挟まない)。
  const homeHref = mode === "reviews" ? "/dashboard/reviews" : "/dashboard";

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-white md:flex md:h-dvh md:sticky md:top-0 md:self-start md:overflow-y-auto">
      <div className="px-5 pb-4 pt-6">
        <Link href={homeHref}>
          <Logo />
        </Link>
      </div>

      <nav className="flex flex-1 flex-col gap-1 px-3">
        {navItems.map((item) => {
          const active = isNavItemActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition",
                active
                  ? "bg-sage-soft text-sage-dark"
                  : "text-ink-muted hover:bg-ivory hover:text-ink",
              )}
            >
              <Icon className="h-5 w-5 shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-border px-3 py-4">
        <Link
          href="/dashboard/settings"
          aria-current={settingsActive ? "page" : undefined}
          className={cn(
            "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition",
            settingsActive
              ? "bg-sage-soft text-sage-dark"
              : "text-ink-muted hover:bg-ivory hover:text-ink",
          )}
        >
          <SettingsIcon className="h-5 w-5 shrink-0" />
          サロン設定
        </Link>
        <form action={logoutAction}>
          <button
            type="submit"
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-ink-muted transition hover:bg-ivory hover:text-ink"
          >
            <LogOutIcon className="h-5 w-5 shrink-0" />
            ログアウト
          </button>
        </form>
      </div>
    </aside>
  );
}
