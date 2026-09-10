"use client";

import Link from "next/link";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import Label from "@/components/ui/Label";
import Input from "@/components/ui/Input";
import Button, { buttonClassName } from "@/components/ui/Button";

// AuthShell doesn't get a title/description for this route (see
// app/(auth)/forgot-password/page.tsx) -- the heading has to change between
// the pre-send and post-send states, which only this Client Component's
// `sent` state knows about. Both blocks below intentionally reuse the same
// classes AuthShell itself uses for its title (mb-6 wrapper, text-lg
// font-semibold text-ink h1, mt-1 text-sm text-ink-muted description) so
// this still reads as "the same shell," just driven from here instead.
export default function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    const supabase = createClient();
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });

    // Always show the same success state, regardless of whether this
    // request actually succeeded, the address is registered, or Supabase
    // returned an error -- so the UI can never be used to infer whether a
    // given email address has an account (email enumeration).
    setLoading(false);
    setSent(true);
  }

  if (sent) {
    return (
      <>
        <div className="mb-6">
          <h1 className="text-lg font-semibold text-ink">再設定メールを送信しました</h1>
          <p className="mt-1 text-sm text-ink-muted">
            メール内のリンクから新しいパスワードを設定してください。
          </p>
        </div>
        <Link href="/login" className={buttonClassName({ fullWidth: true })}>
          ログインに戻る
        </Link>
      </>
    );
  }

  return (
    <>
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-ink">パスワードをお忘れですか？</h1>
        <p className="mt-1 text-sm text-ink-muted">登録メールアドレスに再設定用リンクを送ります。</p>
      </div>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
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

        <Button type="submit" disabled={loading} fullWidth>
          {loading ? "送信中..." : "再設定メールを送る"}
        </Button>

        <Link
          href="/login"
          className="text-center text-sm text-ink-muted transition hover:text-sage-dark"
        >
          ログインに戻る
        </Link>
      </form>
    </>
  );
}
