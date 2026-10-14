import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthedUser, getCurrentSalon } from "@/lib/supabase/queries";
import { getAccountState } from "@/lib/onboarding/accountState";
import { resolveNextStep } from "@/lib/onboarding/nextStep";
import { logoutAction } from "@/app/dashboard/actions";
import AuthShell from "@/components/auth/AuthShell";
import VerifyIdentityForm from "@/components/auth/VerifyIdentityForm";
import SendVerificationLinkButton from "@/components/auth/SendVerificationLinkButton";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";

export const metadata: Metadata = { title: "本人確認", robots: { index: false, follow: false } };

// 本人確認。店舗の操作は、メールのリンクで本人を確認し、パスワードを確かめた(または設定した)あとだけ。
//   - 本人確認が済んでいない & メールのリンクのセッション → パスワードの入れ直し・設定
//   - 本人確認が済んでいない & パスワードでログインしたセッション → 確認のメールを送る(登録のアドレスにだけ届く)
//   - 本人確認は済んでいるが、このセッションは本人確認より前のもの → ログインし直し
export default async function VerifyPage() {
  const supabase = await createClient();
  const user = await getAuthedUser(supabase);
  if (!user) redirect("/login");
  const account = await getAccountState(supabase);
  if (!account) redirect("/login");
  if (account.sessionTrusted) {
    const salon = await getCurrentSalon(supabase);
    redirect(resolveNextStep({ account, salon }));
  }

  if (account.verified) {
    return (
      <AuthShell title="ログインし直してください">
        <div className="flex flex-col gap-4">
          <Alert variant="warning">このログインの状態は使えなくなりました(パスワードの変更や本人確認のあとなど)。もう一度ログインしてください。</Alert>
          <form action={logoutAction}>
            <Button type="submit" fullWidth>
              ログイン画面へ
            </Button>
          </form>
        </div>
      </AuthShell>
    );
  }

  if (account.emailLinkSession && account.emailConfirmed) {
    return (
      <AuthShell title="本人確認" description="メールアドレスを確認しました。続けて、パスワードを確認してください。">
        <VerifyIdentityForm email={user.email ?? ""} mode={account.verificationMode} />
      </AuthShell>
    );
  }

  return (
    <AuthShell title="本人確認が必要です">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink">
          店舗の情報を扱う前に、ご本人の確認が必要です。登録のメールアドレスに本人確認のメールをお送りします。メールのリンクを開いて、手続きを続けてください。
        </p>
        <p className="text-sm text-ink-muted [overflow-wrap:anywhere]">送信先: {user.email}</p>
        <SendVerificationLinkButton />
        <form action={logoutAction}>
          <Button type="submit" variant="ghost" fullWidth>
            ログアウト
          </Button>
        </form>
        <Link href="/privacy" className="text-center text-xs text-ink-muted underline">
          プライバシーポリシー
        </Link>
      </div>
    </AuthShell>
  );
}
