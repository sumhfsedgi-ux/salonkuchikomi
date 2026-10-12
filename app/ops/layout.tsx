import type { Metadata } from "next";
import Link from "next/link";
import { requireOperator } from "@/lib/ops/operator";
import { logoutAction } from "@/app/dashboard/actions";
import { LogOutIcon } from "@/components/ui/icons";
import { SERVICE_NAME } from "@/lib/brand";

export const metadata: Metadata = {
  title: `運営管理 | ${SERVICE_NAME}`,
  robots: { index: false, follow: false },
};

// 運営専用の管理画面。管理者(operator_admins に登録された、サーバーで認証したユーザー ID)以外は 404
// (画面の存在も知らせない)。各ページ・各 Server Action でも requireOperator() を呼ぶ。
// サロン利用画面と区別できるよう、上部に濃い色の「運営管理」の帯を出す。
export default async function OpsLayout({ children }: LayoutProps<"/ops">) {
  const operator = await requireOperator();
  return (
    <div className="flex min-h-dvh flex-col bg-ivory">
      <header className="bg-ink text-white">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
          <Link href="/ops/salons" className="flex items-center gap-2">
            <span className="text-base font-semibold">{SERVICE_NAME}</span>
            <span className="rounded-md bg-white/15 px-2 py-0.5 text-xs font-semibold tracking-wide">運営管理</span>
          </Link>
          <div className="flex min-w-0 items-center gap-3 text-sm">
            {operator.email && <span className="truncate text-white/80">{operator.email}</span>}
            <form action={logoutAction}>
              <button
                type="submit"
                className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-white/90 transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
              >
                <LogOutIcon className="h-4 w-4" />
                ログアウト
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:py-8">{children}</main>
    </div>
  );
}
