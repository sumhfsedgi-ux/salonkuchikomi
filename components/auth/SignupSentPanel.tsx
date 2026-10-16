import Link from "next/link";
import type { Ref } from "react";
import AuthHeading from "@/components/auth/AuthHeading";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";
import { resendButtonLabel, SIGNUP_ACCEPTED_TEXT, type SignupNoticeMode } from "@/lib/onboarding/signupNotice";

interface SignupSentPanelProps {
  mode: SignupNoticeMode;
  email: string;
  waitSeconds: number;
  pending: boolean;
  resendInfo: string | null;
  resendError: string | null;
  onResend: () => void;
  onReenter: () => void;
  headingRef?: Ref<HTMLHeadingElement>;
}

const TEXT_LINK = "font-medium text-sage-dark underline underline-offset-2";

// 新規登録の送信のあとの案内(表示だけ。送信と再送の処理は SignupForm)。
// 並び: 見出し → 案内 → 入力したメールアドレス → 届かない場合と再送(実際に送る環境だけ)→ 入力し直す → ログイン画面へ。
// 登録済みかどうかで変わる値は受け取らない(どのアドレスでも同じ表示になる)。
export default function SignupSentPanel({ mode, email, waitSeconds, pending, resendInfo, resendError, onResend, onReenter, headingRef }: SignupSentPanelProps) {
  const text = SIGNUP_ACCEPTED_TEXT[mode];
  const resend = (
    <div>
      <Button type="button" variant="secondary" fullWidth onClick={onResend} disabled={pending || waitSeconds > 0}>
        {resendButtonLabel(mode, { pending, waitSeconds })}
      </Button>
      <div role="status" className="text-sm text-ink">
        {resendInfo && <p className="mt-2">{resendInfo}</p>}
      </div>
      {resendError && (
        <Alert variant="error" className="mt-2">
          {resendError}
        </Alert>
      )}
    </div>
  );

  return (
    <>
      <AuthHeading ref={headingRef} title={text.title} description={text.body} />
      <div className="flex min-w-0 flex-col gap-4">
        <dl className="min-w-0 rounded-lg border border-border px-3 py-2 text-sm">
          <dt className="text-xs text-ink-muted">入力したメールアドレス</dt>
          <dd className="mt-0.5 font-medium text-ink [overflow-wrap:anywhere]">{email}</dd>
        </dl>
        {mode === "live" ? (
          <section aria-labelledby="signup-not-arrived" className="flex flex-col gap-3 rounded-lg border border-border bg-ivory p-4 text-sm text-ink-muted">
            <h2 id="signup-not-arrived" className="font-medium text-ink">
              メールが届かない場合
            </h2>
            <ul className="flex list-disc flex-col gap-1 pl-5">
              <li>迷惑メールフォルダをご確認ください。</li>
              <li>メールアドレスに誤りがないかご確認ください。</li>
              <li>
                登録済みの方は、
                <Link href="/login" className={TEXT_LINK}>
                  ログイン
                </Link>
                または
                <Link href="/forgot-password" className={TEXT_LINK}>
                  パスワードの再設定
                </Link>
                をご利用ください。
              </li>
            </ul>
            {resend}
          </section>
        ) : (
          resend
        )}
        <Button type="button" variant="ghost" onClick={onReenter}>
          メールアドレスを入力し直す
        </Button>
        <Link href="/login" className="text-center text-sm text-ink-muted transition hover:text-sage-dark">
          ログイン画面へ
        </Link>
      </div>
    </>
  );
}
