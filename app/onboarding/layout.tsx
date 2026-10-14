import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthedUser } from "@/lib/supabase/queries";
import { logoutAction } from "@/app/dashboard/actions";
import Logo from "@/components/ui/Logo";
import { SERVICE_NAME } from "@/lib/brand";

export const metadata: Metadata = {
  title: `お申し込み | ${SERVICE_NAME}`,
  robots: { index: false, follow: false },
};

// 店舗の登録・利用開始待ちの画面の枠(サービスのメニューは出さない)。各ページが、次に進む場所を判定する。
export default async function OnboardingLayout({ children }: LayoutProps<"/onboarding">) {
  const supabase = await createClient();
  const user = await getAuthedUser(supabase);
  if (!user) redirect("/login");

  return (
    <div className="flex min-h-dvh flex-col bg-ivory">
      <header className="border-b border-border bg-white">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-3 px-4 py-3">
          <Logo />
          <form action={logoutAction}>
            <button type="submit" className="min-h-11 rounded-lg px-3 text-sm text-ink-muted transition hover:bg-sage-soft hover:text-sage-dark">
              ログアウト
            </button>
          </form>
        </div>
      </header>
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-8 sm:py-12">{children}</main>
    </div>
  );
}
