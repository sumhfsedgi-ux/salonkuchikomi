"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

// ブログ機能内のサブナビゲーション。/dashboard配下のメインナビ(Sidebar/BottomNav)は
// 「ブログ」1項目しか持たないため、旧blog-appの3タブ(ブログ作成/過去の記事/
// ブログ設定)相当をここで代替する。/dashboard/blog/** のどのページでも表示する。
const ITEMS = [
  { href: "/dashboard/blog", label: "作成" },
  { href: "/dashboard/blog/history", label: "過去の記事" },
  { href: "/dashboard/blog/settings", label: "ブログ設定" },
] as const;

function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard/blog") return pathname === "/dashboard/blog";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function BlogSubNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-wrap gap-2" aria-label="ブログ機能内のナビゲーション">
      {ITEMS.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "min-h-9 rounded-full px-4 py-1.5 text-sm font-medium transition",
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
