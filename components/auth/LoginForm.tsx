"use client";

import Link from "next/link";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import Label from "@/components/ui/Label";
import Input from "@/components/ui/Input";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";

export default function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
      setError("メールアドレスまたはパスワードが正しくありません。");
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

      <Button type="submit" disabled={loading} fullWidth>
        {loading ? "ログイン中..." : "ログイン"}
      </Button>

      <Link
        href="/forgot-password"
        className="text-center text-sm text-ink-muted transition hover:text-sage-dark"
      >
        パスワードをお忘れですか？
      </Link>
    </form>
  );
}
