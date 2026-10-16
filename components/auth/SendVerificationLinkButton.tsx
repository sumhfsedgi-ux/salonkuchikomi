"use client";

import { useState, useTransition } from "react";
import { sendVerificationLinkAction } from "@/app/auth/actions";
import { useSendWaits } from "@/components/auth/useSendWaits";
import { formatWait } from "@/lib/onboarding/signupNotice";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";

// 宛先はセッションのアカウントだけ(待ち時間もこのアカウントに1つ)。
const SELF = "self";

// 本人確認のメール(登録のアドレスにだけ届く。パスワード再設定と同じ形式のメール)を送る。
// 待ち時間は、サーバーが返した残りの秒数で数える(同じアカウントへは、前回から一定の間隔をあける)。
// 検証モードでは「送りました」と書かず、送っていないことだけを出す(文はサーバーが返す)。
export default function SendVerificationLinkButton() {
  const waits = useSendWaits();
  const wait = waits.waitSecondsFor(SELF);
  const [result, setResult] = useState<{ ok: boolean; text: string; simulated?: boolean } | null>(null);
  const [pending, startTransition] = useTransition();

  function send() {
    startTransition(async () => {
      try {
        const res = await sendVerificationLinkAction();
        waits.record(SELF, res);
        setResult(res.ok ? { ok: true, text: res.message ?? "", simulated: res.simulated } : { ok: false, text: res.error ?? "送信できませんでした。" });
      } catch {
        setResult({ ok: false, text: "処理できませんでした。通信の状態を確認して、もう一度お試しください。" });
      }
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <Button type="button" variant="secondary" onClick={send} disabled={pending || wait > 0} fullWidth>
        {pending ? "処理しています…" : wait > 0 ? `再送まであと${formatWait(wait)}` : "本人確認のメールを送る"}
      </Button>
      <div aria-live="polite">
        {result && <Alert variant={!result.ok ? "error" : result.simulated ? "warning" : "success"}>{result.text}</Alert>}
      </div>
    </div>
  );
}
