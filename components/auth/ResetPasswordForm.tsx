"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import Label from "@/components/ui/Label";
import Input from "@/components/ui/Input";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";

// "reset" = ログイン画面の「パスワードをお忘れですか？」から来た通常の
// 再設定。"first" = 将来hmailの既存ユーザー等を招待する際の「初回パスワード
// 設定」。Supabase側の仕組み(recoveryリンク)は完全に同じで、文言だけを
// 出し分ける -- 実際のユーザー紐付けロジックは別途の作業(今回スコープ外)。
type Mode = "reset" | "first";

type Status = "verifying" | "ready" | "invalid";

export default function ResetPasswordForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("verifying");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const supabase = createClient();

    // The recovery link lands here with a session that supabase-js
    // establishes client-side from the URL (a hash fragment the server
    // never sees) and reports via a PASSWORD_RECOVERY auth event. If this
    // component mounts after that already fired, an existing session also
    // counts as "ready".
    const { data: listener } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") setStatus("ready");
    });

    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        setStatus((current) => (current === "verifying" ? "ready" : current));
      }
    });

    // No valid recovery session showed up in a reasonable time -> the link
    // was likely already used, expired, or opened directly without a token.
    const timeout = setTimeout(() => {
      setStatus((current) => (current === "verifying" ? "invalid" : current));
    }, 5000);

    return () => {
      listener.subscription.unsubscribe();
      clearTimeout(timeout);
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("パスワードは8文字以上で入力してください。");
      return;
    }
    if (password !== confirmPassword) {
      setError("パスワードが一致しません。");
      return;
    }

    setSaving(true);
    const supabase = createClient();
    const { error: updateError } = await supabase.auth.updateUser({ password });

    if (updateError) {
      setSaving(false);
      setError("パスワードの設定に失敗しました。もう一度お試しください。");
      return;
    }

    // 新しいパスワードで改めてログインしてもらうため、いったんサインアウトする。
    await supabase.auth.signOut();
    router.push(mode === "first" ? "/login?welcome=1" : "/login?reset=1");
  }

  if (status === "verifying") {
    return <p className="py-2 text-center text-sm text-ink-muted">確認しています...</p>;
  }

  if (status === "invalid") {
    return (
      <div className="flex flex-col gap-4">
        <Alert variant="error">
          リンクの有効期限が切れているか、無効なリンクです。お手数ですが、もう一度お試しください。
        </Alert>
        <Link
          href="/forgot-password"
          className="text-center text-sm text-ink-muted transition hover:text-sage-dark"
        >
          {mode === "first" ? "初回パスワード設定をやり直す" : "パスワード再設定をやり直す"}
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div>
        <Label htmlFor="password">新しいパスワード</Label>
        <Input
          id="password"
          type="password"
          required
          autoComplete="new-password"
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <div>
        <Label htmlFor="confirm-password">新しいパスワード（確認）</Label>
        <Input
          id="confirm-password"
          type="password"
          required
          autoComplete="new-password"
          minLength={8}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
        />
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      <Button type="submit" disabled={saving} fullWidth>
        {saving ? "設定しています..." : mode === "first" ? "パスワードを設定する" : "パスワードを再設定する"}
      </Button>
    </form>
  );
}
