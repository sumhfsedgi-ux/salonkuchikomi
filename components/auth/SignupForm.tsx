"use client";

import Link from "next/link";
import { useCallback, useState, useTransition } from "react";
import { resendConfirmationAction, signupAction } from "@/app/auth/actions";
import AuthHeading from "@/components/auth/AuthHeading";
import SignupSentPanel from "@/components/auth/SignupSentPanel";
import { useSendWaits } from "@/components/auth/useSendWaits";
import FormField, { fieldAria, focusFirstError } from "@/components/ui/FormField";
import Input from "@/components/ui/Input";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";
import { RESEND_ACCEPTED_TEXT, signupSubmitLabel, type SignupNoticeMode } from "@/lib/onboarding/signupNotice";

const FIELDS = ["email", "password", "passwordConfirm"] as const;

// お客様自身の新規登録(1. メールアドレス・パスワード)。送信後は、登録済みかどうかを出さない共通の文を出す。
// 送信の待ち時間は、サーバーが返した残りの秒数で数える(useSendWaits)。同じアドレスへの登録と再送は同じ間隔を共有し、
// 入力し直して同じアドレスに戻っても待ちが続く。アドレスを直したら、そのアドレスに当てはまる待ち(接続元ごとの上限)だけを出す。
export default function SignupForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ mode: SignupNoticeMode } | null>(null);
  const [reentered, setReentered] = useState(false);
  const [resendInfo, setResendInfo] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);
  const waits = useSendWaits();
  const [pending, startTransition] = useTransition();
  const waitSeconds = waits.waitSecondsFor(email);
  // 見出しが切り替わったら、そこへ移る(同じ関数なので、表示の更新のたびには動かない)
  const focusOnMount = useCallback((el: HTMLElement | null) => el?.focus(), []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      let res: Awaited<ReturnType<typeof signupAction>>;
      try {
        res = await signupAction({ email, password, passwordConfirm });
      } catch {
        setError("処理できませんでした。通信の状態を確認して、もう一度お試しください。");
        return;
      }
      waits.record(email, res);
      if (!res.ok) {
        setFieldErrors(res.fieldErrors ?? {});
        setError(res.error ?? null);
        focusFirstError(FIELDS, res.fieldErrors ?? {});
        return;
      }
      setFieldErrors({});
      setPassword("");
      setPasswordConfirm("");
      setResendInfo(null);
      setResendError(null);
      setSent({ mode: res.simulated ? "simulated" : "live" });
    });
  }

  function resend() {
    if (!sent) return;
    const mode = sent.mode;
    setResendInfo(null);
    setResendError(null);
    startTransition(async () => {
      try {
        const res = await resendConfirmationAction({ email });
        // 受付でも上限でも、サーバーが決めた残りの秒数を待つ
        waits.record(email, res);
        if (res.ok) setResendInfo(RESEND_ACCEPTED_TEXT[mode]);
        else setResendError(res.error ?? res.fieldErrors?.email ?? "処理できませんでした。時間をおいて、もう一度お試しください。");
      } catch {
        setResendError("処理できませんでした。通信の状態を確認して、もう一度お試しください。");
      }
    });
  }

  if (sent) {
    return (
      <SignupSentPanel
        mode={sent.mode}
        email={email.trim()}
        waitSeconds={waitSeconds}
        pending={pending}
        resendInfo={resendInfo}
        resendError={resendError}
        onResend={resend}
        onReenter={() => {
          setReentered(true);
          setSent(null);
        }}
        headingRef={focusOnMount}
      />
    );
  }

  return (
    <>
      <AuthHeading title="新規登録" description="メールアドレスとパスワードを登録してください。" />
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <FormField id="email" label="メールアドレス" requirement="required" help="ログインに使います。確認のメールをお送りします。" error={fieldErrors.email}>
          <Input
            ref={reentered ? focusOnMount : undefined}
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

        <Button type="submit" disabled={pending || waitSeconds > 0} fullWidth>
          {signupSubmitLabel({ pending, waitSeconds })}
        </Button>
        <p className="text-xs text-ink-muted">
          登録だけでは、料金のお支払いやご契約は発生しません。
          <Link href="/privacy" className="ml-1 underline">
            プライバシーポリシー
          </Link>
        </p>
        <Link href="/login" className="text-center text-sm text-ink-muted transition hover:text-sage-dark">
          すでにアカウントをお持ちの方はこちら(ログイン)
        </Link>
      </form>
    </>
  );
}
