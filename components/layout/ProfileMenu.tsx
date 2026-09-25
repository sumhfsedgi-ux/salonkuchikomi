"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { SettingsIcon, LogOutIcon, UserCircleIcon } from "@/components/ui/icons";
import { logoutAction } from "@/app/dashboard/actions";

// Mobile-only: サロン設定・ログアウトの入口を、常時表示のボトムナビから
// 切り離してここに集約する (design brief: "サロン設定・アカウント等は
// プロフィールメニューなどに配置して構わない").
export default function ProfileMenu() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="アカウントメニュー"
        className="flex h-11 w-11 items-center justify-center rounded-full text-ink-muted transition hover:bg-ivory hover:text-ink"
      >
        <UserCircleIcon className="h-6 w-6" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-2 w-48 overflow-hidden rounded-xl border border-border bg-white py-1 shadow-md"
        >
          <Link
            href="/dashboard/settings"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex min-h-11 items-center gap-2.5 px-4 py-2.5 text-sm text-ink transition hover:bg-ivory"
          >
            <SettingsIcon className="h-4 w-4" />
            サロン設定
          </Link>
          <form action={logoutAction}>
            <button
              type="submit"
              role="menuitem"
              className="flex min-h-11 w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-ink transition hover:bg-ivory"
            >
              <LogOutIcon className="h-4 w-4" />
              ログアウト
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
