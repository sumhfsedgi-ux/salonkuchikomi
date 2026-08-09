import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import LoginForm from "@/components/admin/LoginForm";

export default async function AdminLoginPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/admin");

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="mb-1 text-lg font-semibold text-slate-800">
          サロン管理画面
        </h1>
        <p className="mb-6 text-sm text-slate-500">
          発行されたアカウントでログインしてください。
        </p>
        <LoginForm />
      </div>
    </div>
  );
}
