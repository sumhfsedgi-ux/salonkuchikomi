"use client";

import { useState, useTransition } from "react";
import { verifyIdentityAction } from "@/app/auth/actions";
import FormField, { fieldAria, focusFirstError } from "@/components/ui/FormField";
import Input from "@/components/ui/Input";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";
import SendVerificationLinkButton from "@/components/auth/SendVerificationLinkButton";

// 本人確認(メールのリンクで開いたセッション)。
//   confirm_or_set: 登録したパスワードを入れ直す(合わなければ、新しく設定することもできる)
//   set_new: 新しいパスワードを設定する(運営の招待・未確認のアドレスでの再登録など)
// 処理と記録はサーバーの1つの Action で行う(記録だけを行う入口は無い)。
export default function VerifyIdentityForm({ email, mode: initialMode }: { email: string; mode: "confirm_or_set" | "set_new" }) {
  const [mode, setMode] = useState<"confirm" | "set">(initialMode === "confirm_or_set" ? "confirm" : "set");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [needsNewLink, setNeedsNewLink] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await verifyIdentityAction({ mode, password, passwordConfirm });
      if (res.ok) {
        window.location.replace(res.next);
        return;
      }
      setFieldErrors(res.fieldErrors ?? {});
      setError(res.error ?? null);
      setNeedsNewLink(res.reason === "session_expired" || res.reason === "not_email_link" || res.reason === "not_signed_in");
      focusFirstError(["password", "passwordConfirm"], res.fieldErrors ?? {}, (f) => `verify-${f}`);
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      {/* パスワード管理ソフトが、どのアカウントのパスワードかを結び付けられるように */}
      <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
      <p className="text-sm text-ink [overflow-wrap:anywhere]">アカウント: {email}</p>

      {mode === "confirm" ? (
        <>
          <p className="text-sm text-ink-muted">本人確認のため、新規登録のときに決めたパスワードを入力してください。</p>
          <FormField id="verify-password" label="登録したパスワード" requirement="required" error={fieldErrors.password}>
            <Input
              id="verify-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              {...fieldAria("verify-password", { error: fieldErrors.password })}
            />
          </FormField>
        </>
      ) : (
        <>
          <p className="text-sm text-ink-muted">ログインに使うパスワードを設定してください。</p>
          <FormField id="verify-password" label="新しいパスワード" requirement="required" help="8文字以上" error={fieldErrors.password}>
            <Input
              id="verify-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              {...fieldAria("verify-password", { error: fieldErrors.password, help: true })}
            />
          </FormField>
          <FormField id="verify-passwordConfirm" label="新しいパスワード(確認)" requirement="required" error={fieldErrors.passwordConfirm}>
            <Input
              id="verify-passwordConfirm"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={passwordConfirm}
              onChange={(e) => setPasswordConfirm(e.target.value)}
              {...fieldAria("verify-passwordConfirm", { error: fieldErrors.passwordConfirm })}
            />
          </FormField>
        </>
      )}

      <div aria-live="polite">{error && <Alert variant="error">{error}</Alert>}</div>
      {needsNewLink && <SendVerificationLinkButton />}

      <Button type="submit" disabled={pending} fullWidth>
        {pending ? "確認しています..." : mode === "confirm" ? "確認して続ける" : "パスワードを設定して続ける"}
      </Button>

      {initialMode === "confirm_or_set" && (
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setMode(mode === "confirm" ? "set" : "confirm");
            setPassword("");
            setPasswordConfirm("");
            setFieldErrors({});
            setError(null);
          }}
        >
          {mode === "confirm" ? "新しいパスワードを設定する" : "登録したパスワードを入力する"}
        </Button>
      )}
    </form>
  );
}
