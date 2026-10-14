"use client";

import { useEffect, useState, useTransition } from "react";
import { sendVerificationLinkAction } from "@/app/auth/actions";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";

const WAIT_SECONDS = 60;

// 本人確認のメール(登録のアドレスにだけ届く)を送る。続けて送れないよう、60秒あける(サーバーでも制限する)。
export default function SendVerificationLinkButton() {
  const [wait, setWait] = useState(0);
  const [result, setResult] = useState<{ ok: boolean; text: string; simulated?: boolean } | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  function send() {
    startTransition(async () => {
      const res = await sendVerificationLinkAction();
      setResult(res.ok ? { ok: true, text: res.message ?? "", simulated: res.simulated } : { ok: false, text: res.error ?? "送信できませんでした。" });
      setWait(WAIT_SECONDS);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <Button type="button" variant="secondary" onClick={send} disabled={pending || wait > 0} fullWidth>
        {wait > 0 ? `本人確認のメールを送る(${wait}秒後に再送できます)` : pending ? "送信しています..." : "本人確認のメールを送る"}
      </Button>
      <div aria-live="polite">
        {result && <Alert variant={result.ok ? "success" : "error"}>{result.text}</Alert>}
        {result?.simulated && <Alert variant="warning" className="mt-2">検証モードのため、実際のメールは送信していません。</Alert>}
      </div>
    </div>
  );
}
