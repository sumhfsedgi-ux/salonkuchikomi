import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import AuthShell from "@/components/auth/AuthShell";
import LoginForm from "@/components/auth/LoginForm";
import Alert from "@/components/ui/Alert";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/dashboard");

  const params = await searchParams;

  return (
    <AuthShell>
      <div className="flex flex-col gap-4">
        {params?.reset === "1" && (
          <Alert variant="success">パスワードを再設定しました。新しいパスワードでログインしてください。</Alert>
        )}
        {params?.welcome === "1" && (
          <Alert variant="success">パスワードを設定しました。ログインしてください。</Alert>
        )}
        <LoginForm />
      </div>
    </AuthShell>
  );
}
