"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import Toast from "@/components/Toast";
import { sendTestNotificationAction } from "@/app/dashboard/notifications/actions";
import {
  TEST_SEND_RESULT_MESSAGES,
  testSendConfirmation,
  testSendNotice,
  type TestSendMode,
} from "@/lib/notifications/recipients/messages";

interface Props {
  disabled?: boolean;
  /** この環境での送り方(サーバーの判定。lib/notifications/line/sendPolicy.ts)。 */
  mode: TestSendMode;
  /** 実際に送る通知先の人数(シミュレーションでは 0)。 */
  realRecipientCount: number;
}

// テスト通知。本番では、登録済みの通知先へ実際にテストメッセージが届くことを、押す前に表示して確認する。
// 本番以外では実際には送らない(サーバー側で止める)ことを、押す前と結果の両方で表示する。
export default function TestNotifyButton({ disabled, mode, realRecipientCount }: Props) {
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [toast, setToast] = useState<{ message: string; variant: "success" | "error" } | null>(null);
  const sendsForReal = mode !== "simulated" && realRecipientCount > 0;

  async function send() {
    if (sending) return;
    setSending(true);
    setConfirming(false);
    const result = await sendTestNotificationAction();
    setSending(false);
    setToast(
      result.ok
        ? { message: result.message ?? TEST_SEND_RESULT_MESSAGES[mode], variant: "success" }
        : { message: result.error ?? "送信に失敗しました", variant: "error" }
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-ink-muted" data-testid="test-send-notice">
        {testSendNotice(mode, realRecipientCount)}
      </p>
      {confirming ? (
        <div role="group" aria-label="テスト通知の確認" className="flex flex-col gap-2 rounded-lg border border-border bg-white p-3">
          <p className="text-sm text-ink">{testSendConfirmation(realRecipientCount)}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={send} disabled={sending}>
              送信する
            </Button>
            <Button type="button" variant="secondary" onClick={() => setConfirming(false)} disabled={sending}>
              やめる
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button
            type="button"
            variant="secondary"
            onClick={sendsForReal ? () => setConfirming(true) : send}
            disabled={disabled || sending}
          >
            {sending ? "送信しています..." : sendsForReal ? "LINEにテスト通知を送る" : "テスト通知をシミュレーションする"}
          </Button>
        </div>
      )}
      <Toast message={toast?.message ?? null} variant={toast?.variant} onDismiss={() => setToast(null)} />
    </div>
  );
}
