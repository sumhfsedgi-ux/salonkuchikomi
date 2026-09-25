import AuthShell from "@/components/auth/AuthShell";
import ResetPasswordForm from "@/components/auth/ResetPasswordForm";

export default async function ResetPasswordPage({
  searchParams,
}: PageProps<"/reset-password">) {
  const params = await searchParams;
  const mode = params?.mode === "first" ? "first" : "reset";

  return (
    <AuthShell
      title={mode === "first" ? "初回パスワードを設定" : "新しいパスワードを設定"}
      description={
        mode === "first"
          ? "アカウントで使用する新しいパスワードを設定してください。"
          : "アカウントの新しいパスワードを設定してください。"
      }
    >
      <ResetPasswordForm mode={mode} />
    </AuthShell>
  );
}
