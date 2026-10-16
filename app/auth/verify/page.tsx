import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthedUser, getCurrentSalon } from "@/lib/supabase/queries";
import { getAccountState } from "@/lib/onboarding/accountState";
import { resolveNextStep } from "@/lib/onboarding/nextStep";
import { RETURN_COOKIE, safeReturnPath, withReturnPath } from "@/lib/auth/returnPath";
import { logoutAction } from "@/app/dashboard/actions";
import AuthShell from "@/components/auth/AuthShell";
import VerifyIdentityForm from "@/components/auth/VerifyIdentityForm";
import SendVerificationLinkButton from "@/components/auth/SendVerificationLinkButton";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";

export const metadata: Metadata = { title: "パスワードの確認・設定", robots: { index: false, follow: false } };

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
    // 店舗の画面へ進むときだけ、ログインの前に開こうとしていた口コミ詳細へ戻す(cookie は期限で消える)。
    redirect(withReturnPath(resolveNextStep({ account, salon }), safeReturnPath((await cookies()).get(RETURN_COOKIE)?.value)));
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
      // 見出しは VerifyIdentityForm が出す(入れ直す/新しく設定するの切り替えに合わせて変わる)
      <AuthShell>
        <VerifyIdentityForm email={user.email ?? ""} mode={account.verificationMode} />
      </AuthShell>
    );
  }

  return (
    <AuthShell title="メールでの確認が必要です">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink">
          店舗の情報を扱う前に、メールでのご本人の確認が必要です。下のボタンを押すと、登録のメールアドレスに、パスワード再設定と同じ形式のメールをお送りします。
          メールのリンクを開き、パスワードを入力または設定して、手続きを続けてください。
        </p>
        <p className="text-sm text-ink-muted [overflow-wrap:anywhere]">登録のメールアドレス: {user.email}</p>
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
