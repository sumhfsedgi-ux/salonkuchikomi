import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import AuthShell from "@/components/auth/AuthShell";
import SignupForm from "@/components/auth/SignupForm";
import Alert from "@/components/ui/Alert";
import SupportContact from "@/components/support/SupportContact";
import { isSelfSignupEnabled } from "@/lib/onboarding/authEmailPolicy";
import { getSupportContact } from "@/lib/support/contact";

// お客様自身の新規登録。メールアドレスの確認 → 本人確認 → 店舗の情報 → 利用開始待ち、の順に進む。
// SELF_SIGNUP_ENABLED=1 のときだけ受け付ける(独自のメール送信の設定とテンプレートを整えてから有効にする)。
export default async function SignupPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/dashboard");

  if (!isSelfSignupEnabled()) {
    return (
      <AuthShell title="新規登録">
        <div className="flex flex-col gap-4">
          <Alert variant="warning">現在、こちらからの新規登録は受け付けていません。ご利用を希望される方は、運営までお問い合わせください。</Alert>
          <SupportContact contact={getSupportContact()} />
          <Link href="/login" className="text-center text-sm text-ink-muted transition hover:text-sage-dark">
            ログイン画面へ
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="新規登録" description="メールアドレスとパスワードを登録してください。">
      <SignupForm />
    </AuthShell>
  );
}
