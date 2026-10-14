"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { resendInvitationAction } from "@/app/ops/salons/[id]/actions";
import { formatJst } from "@/lib/ops/labels";
import { invitationStatusText, verificationText, VERIFICATION_BASIS, DAILY_SEND_LIMIT, type InvitationKindKey } from "@/lib/ops/onboardingDisplay";
import Alert from "@/components/ui/Alert";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";

// 招待と案内(運営が登録した店舗)。本人確認(招待手続き)の状態と、案内のメールの送信の状態を分けて出す。
// 「送信を受け付けた」は届いた・読まれたという意味ではない。利用区分(使えるかどうか)は別の枠で出す。
export interface InvitationPanelProps {
  salonId: string;
  loginEmail: string | null;
  ownerEmailConfirmed: boolean;
  ownerVerified: boolean;
  ownerVerificationMethod: "legacy" | "password_confirmed" | "password_set" | null;
  lastKind: InvitationKindKey | null;
  lastAttemptAt: string | null;
  lastResult: "sending" | "accepted" | "failed" | "simulated" | null;
  lastError: string | null;
  lastAcceptedAt: string | null;
  firstAcceptedAt: string | null;
  attempts24h: number;
  nextSendAt: string | null;
  /** サーバーで描画した時刻(サーバーとブラウザで同じ表示から始めるため)。 */
  serverNow: string;
}

export default function InvitationPanel(props: InvitationPanelProps) {
  const router = useRouter();
  const [now, setNow] = useState(() => new Date(props.serverNow));
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const verification = verificationText(props);
  const status = invitationStatusText(props, now);

  useEffect(() => {
    if (status.waitSeconds <= 0) return;
    const t = setTimeout(() => setNow(new Date()), 1000);
    return () => clearTimeout(t);
  }, [status.waitSeconds, now]);

  function resend() {
    setResult(null);
    startTransition(async () => {
      const res = await resendInvitationAction({ salonId: props.salonId });
      setResult(res.ok ? { ok: true, text: res.message } : { ok: false, text: res.error });
      router.refresh();
      setNow(new Date());
    });
  }

  const nextKindText = !props.ownerEmailConfirmed
    ? "招待(パスワードの設定)"
    : !props.ownerVerified
      ? "本人確認のご案内(パスワードの設定)"
      : "店舗登録のお知らせ(ログインのご案内)";

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-ink-muted">本人確認(招待手続き):</span>
          <Badge variant={verification.complete ? "neutral" : "warning"}>{verification.label}</Badge>
        </p>
        <p className="text-xs text-ink-muted">{VERIFICATION_BASIS}</p>
        <p className="text-sm text-ink [overflow-wrap:anywhere]">招待先: {props.loginEmail ?? "—"}</p>
      </div>

      <dl className="grid gap-2 text-sm sm:grid-cols-[12rem_1fr]">
        <dt className="text-ink-muted">初回の案内の送信の受付</dt>
        <dd className="text-ink">{props.firstAcceptedAt ? formatJst(props.firstAcceptedAt) : "まだ受け付けていません"}</dd>
        <dt className="text-ink-muted">最終送信日時(送信の受付)</dt>
        <dd className="text-ink">{formatJst(props.lastAcceptedAt)}</dd>
        <dt className="text-ink-muted">最後の送信</dt>
        <dd className="text-ink">
          {status.lastResultText ?? "まだ送っていません"}
          {props.lastAttemptAt && <span className="block text-xs text-ink-muted">試行: {formatJst(props.lastAttemptAt)}</span>}
        </dd>
      </dl>

      {status.failure && (
        <Alert variant="error">
          送信失敗: {status.failure}
        </Alert>
      )}

      <div aria-live="polite">{result && <Alert variant={result.ok ? "success" : "error"}>{result.text}</Alert>}</div>

      <div className="flex flex-col gap-1.5">
        <Button type="button" variant="secondary" onClick={resend} disabled={pending || !status.canResend}>
          {pending ? "送信しています..." : status.waitSeconds > 0 ? `再送できるまで ${status.waitSeconds} 秒` : `${nextKindText}を再送する`}
        </Button>
        <p className="text-xs text-ink-muted">
          同じサロンへの送信は60秒あけ、24時間で{DAILY_SEND_LIMIT}回までです(この24時間: {props.attempts24h}回)。
          本人確認が済んでいても、店舗登録のお知らせは再送できます。
        </p>
      </div>
    </Card>
  );
}
