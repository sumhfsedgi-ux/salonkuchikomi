import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthedUser, getCurrentSalon } from "@/lib/supabase/queries";
import { logoutAction } from "./actions";

export default async function AuthedAdminLayout({
  children,
}: LayoutProps<"/admin">) {
  const supabase = await createClient();
  const user = await getAuthedUser(supabase);
  if (!user) redirect("/admin/login");

  const salon = await getCurrentSalon(supabase);

  return (
    <div className="flex min-h-dvh min-w-0 flex-col bg-ivory">
      <header className="min-w-0 bg-white">
        <div className="mx-auto flex w-full min-w-0 max-w-4xl flex-col gap-3 px-4 py-4 md:flex-row md:items-center md:justify-between">
          <p className="min-w-0 text-sm font-semibold text-stone-800">
            {salon?.name ?? "salonpack 管理画面"}
          </p>
          <nav className="flex flex-wrap items-center gap-5 text-sm text-stone-500">
            <Link href="/admin" className="hover:text-sage-dark">
              ホーム
            </Link>
            <Link href="/admin/survey" className="hover:text-sage-dark">
              お客様への質問
            </Link>
            <Link href="/admin/settings" className="hover:text-sage-dark">
              店舗設定
            </Link>
            <form action={logoutAction}>
              <button type="submit" className="hover:text-sage-dark">
                ログアウト
              </button>
            </form>
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full min-w-0 max-w-4xl flex-1 px-4 py-8">
        {children}
      </main>
    </div>
  );
}
