import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSalon } from "@/lib/supabase/queries";
import { logoutAction } from "./actions";

export default async function AuthedAdminLayout({
  children,
}: LayoutProps<"/admin">) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/admin/login");

  const salon = await getCurrentSalon(supabase);

  return (
    <div className="flex min-h-dvh flex-col bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 px-4 py-4 md:flex-row md:items-center md:justify-between">
          <p className="text-sm font-semibold text-slate-800">
            {salon?.name ?? "salonpack 管理画面"}
          </p>
          <nav className="flex flex-wrap items-center gap-4 text-sm text-slate-600">
            <Link href="/admin" className="hover:text-slate-900">
              ホーム
            </Link>
            <Link href="/admin/survey" className="hover:text-slate-900">
              アンケート設定
            </Link>
            <Link href="/admin/settings" className="hover:text-slate-900">
              店舗設定
            </Link>
            <form action={logoutAction}>
              <button type="submit" className="hover:text-slate-900">
                ログアウト
              </button>
            </form>
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">
        {children}
      </main>
    </div>
  );
}
