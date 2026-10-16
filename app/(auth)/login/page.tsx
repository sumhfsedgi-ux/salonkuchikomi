import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import AuthShell from "@/components/auth/AuthShell";
import LoginForm from "@/components/auth/LoginForm";
import Alert from "@/components/ui/Alert";
import { isSelfSignupEnabled } from "@/lib/onboarding/authEmailPolicy";
import { RETURN_COOKIE, safeReturnPath } from "@/lib/auth/returnPath";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const params = await searchParams;
  // ログインのあとに戻る口コミ詳細(LINE の通知のリンクから来たとき。lib/auth/returnPath.ts)。形の違う値は使わない。
  const returnPath = safeReturnPath(params?.next) ?? safeReturnPath((await cookies()).get(RETURN_COOKIE)?.value);
  if (user) redirect(returnPath ?? "/dashboard");

  return (
    <AuthShell>
      <div className="flex flex-col gap-4">
        {params?.reset === "1" && (
          <Alert variant="success">パスワードを再設定しました。新しいパスワードでログインしてください。</Alert>
        )}
        {params?.welcome === "1" && (
          <Alert variant="success">パスワードを設定しました。ログインしてください。</Alert>
        )}
        {returnPath && <Alert variant="warning">口コミを確認するには、SalonPackにログインしてください。ログインのあと、その口コミを開きます。</Alert>}
        <LoginForm signupEnabled={isSelfSignupEnabled()} returnPath={returnPath} />
      </div>
    </AuthShell>
  );
}
