"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { createClient } from "@/lib/supabase/client";
import { resendConfirmationAction } from "@/app/auth/actions";
import Label from "@/components/ui/Label";
import Input from "@/components/ui/Input";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";

export default function LoginForm({ signupEnabled = false }: { signupEnabled?: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // メールアドレスの確認が済んでいない(パスワードが正しいときだけ Supabase がこの理由を返す)
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [resendInfo, setResendInfo] = useState<string | null>(null);
  const [resending, startResend] = useTransition();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      if (signInError.code === "email_not_confirmed") {
        setUnconfirmed(true);
        setError("メールアドレスの確認が済んでいません。登録のときにお送りした確認のメールのリンクを開いてください。");
      } else {
        setUnconfirmed(false);
        setError("メールアドレスまたはパスワードが正しくありません。");
      }
      setLoading(false);
      return;
    }

    // A full navigation (not router.push) so the dashboard always starts
    // from a clean, unzoomed page load, regardless of anything odd that
    // happened to the viewport while this form was focused/filled in.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/dashboard";
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate={false}>
      <div>
        <Label htmlFor="email">メールアドレス</Label>
        <Input
          id="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div>
        <div className="flex items-baseline justify-between">
          <Label htmlFor="password">パスワード</Label>
        </div>
        <Input
          id="password"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>

      {error && <Alert variant="error">{error}</Alert>}
      {unconfirmed && (
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={resending}
            onClick={() =>
              startResend(async () => {
                const res = await resendConfirmationAction({ email });
                setResendInfo(res.ok ? (res.message ?? null) : (res.error ?? res.fieldErrors?.email ?? null));
              })
            }
          >
            {resending ? "送信しています..." : "確認のメールを再送する"}
          </Button>
          {resendInfo && <p className="text-sm text-ink-muted" role="status">{resendInfo}</p>}
        </div>
      )}

      <Button type="submit" disabled={loading} fullWidth>
        {loading ? "ログイン中..." : "ログイン"}
      </Button>

      <Link
        href="/forgot-password"
        className="text-center text-sm text-ink-muted transition hover:text-sage-dark"
      >
        パスワードをお忘れですか？
      </Link>

      {signupEnabled && (
        <div className="border-t border-border pt-4 text-center">
          <p className="text-sm text-ink-muted">初めての方はこちら</p>
          <Link href="/signup" className="mt-2 inline-flex min-h-11 items-center text-sm font-medium text-sage-dark underline underline-offset-2">
            新規登録
          </Link>
        </div>
      )}
    </form>
  );
}
