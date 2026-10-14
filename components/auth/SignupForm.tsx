"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { resendConfirmationAction, signupAction } from "@/app/auth/actions";
import FormField, { fieldAria, focusFirstError } from "@/components/ui/FormField";
import Input from "@/components/ui/Input";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";

const FIELDS = ["email", "password", "passwordConfirm"] as const;
const RESEND_WAIT_SECONDS = 60;

// お客様自身の新規登録(1. メールアドレス・パスワード)。送信後は、登録済みかどうかを出さない共通の文を出す。
export default function SignupForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ message: string; simulated?: boolean } | null>(null);
  const [resendInfo, setResendInfo] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await signupAction({ email, password, passwordConfirm });
      if (!res.ok) {
        setFieldErrors(res.fieldErrors ?? {});
        setError(res.error ?? null);
        focusFirstError(FIELDS, res.fieldErrors ?? {});
        return;
      }
      setFieldErrors({});
      setPassword("");
      setPasswordConfirm("");
      setSent({ message: res.message ?? "", simulated: res.simulated });
      setWait(RESEND_WAIT_SECONDS);
    });
  }

  function resend() {
    setResendInfo(null);
    startTransition(async () => {
      const res = await resendConfirmationAction({ email });
      setResendInfo(res.ok ? (res.message ?? null) : (res.error ?? res.fieldErrors?.email ?? null));
      setWait(RESEND_WAIT_SECONDS);
    });
  }

  if (sent) {
    return (
      <div className="flex flex-col gap-4" aria-live="polite">
        <Alert variant="success">{sent.message}</Alert>
        {sent.simulated && <Alert variant="warning">検証モードのため、実際のメールは送信していません。</Alert>}
        <p className="text-sm text-ink-muted [overflow-wrap:anywhere]">送信先: {email}</p>
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-ivory p-4 text-sm text-ink-muted">
          <p className="font-medium text-ink">メールが届かない場合</p>
          <ul className="list-disc pl-5">
            <li>迷惑メールのフォルダをご確認ください。</li>
            <li>アドレスに誤りがある場合は、最初から登録し直してください。</li>
          </ul>
          <Button type="button" variant="secondary" onClick={resend} disabled={pending || wait > 0}>
            {wait > 0 ? `確認メールを再送する(${wait}秒後)` : pending ? "送信しています..." : "確認メールを再送する"}
          </Button>
          {resendInfo && <p role="status">{resendInfo}</p>}
        </div>
        <Button type="button" variant="ghost" onClick={() => setSent(null)}>
          メールアドレスを入力し直す
        </Button>
        <Link href="/login" className="text-center text-sm text-ink-muted transition hover:text-sage-dark">
          ログイン画面へ
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <FormField id="email" label="メールアドレス" requirement="required" help="ログインに使います。確認のメールをお送りします。" error={fieldErrors.email}>
        <Input
          id="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          {...fieldAria("email", { error: fieldErrors.email, help: true })}
        />
      </FormField>
      <FormField id="password" label="パスワード" requirement="required" help="8文字以上" error={fieldErrors.password}>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          {...fieldAria("password", { error: fieldErrors.password, help: true })}
        />
      </FormField>
      <FormField id="passwordConfirm" label="パスワード(確認)" requirement="required" error={fieldErrors.passwordConfirm}>
        <Input
          id="passwordConfirm"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={passwordConfirm}
          onChange={(e) => setPasswordConfirm(e.target.value)}
          {...fieldAria("passwordConfirm", { error: fieldErrors.passwordConfirm })}
        />
      </FormField>

      {error && <Alert variant="error">{error}</Alert>}

      <Button type="submit" disabled={pending} fullWidth>
        {pending ? "送信しています..." : "登録して確認メールを受け取る"}
      </Button>
      <p className="text-xs text-ink-muted">
        登録だけでは、料金のお支払いやご契約は発生しません。店舗の情報を登録したあと、運営から利用開始のご案内をお送りします。
        <Link href="/privacy" className="ml-1 underline">
          プライバシーポリシー
        </Link>
      </p>
      <Link href="/login" className="text-center text-sm text-ink-muted transition hover:text-sage-dark">
        すでにアカウントをお持ちの方はこちら(ログイン)
      </Link>
    </form>
  );
}
