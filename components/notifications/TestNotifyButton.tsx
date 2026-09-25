"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import Toast from "@/components/Toast";
import { sendTestNotificationAction } from "@/app/dashboard/notifications/actions";

interface Props {
  disabled?: boolean;
}

export default function TestNotifyButton({ disabled }: Props) {
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState<{ message: string; variant: "success" | "error" } | null>(null);

  async function handleClick() {
    if (sending) return;
    setSending(true);
    const result = await sendTestNotificationAction();
    setSending(false);
    setToast(
      result.ok
        ? { message: "テスト通知を送信しました", variant: "success" }
        : { message: result.error ?? "送信に失敗しました", variant: "error" }
    );
  }

  return (
    <>
      <Button type="button" variant="secondary" onClick={handleClick} disabled={disabled || sending}>
        {sending ? "送信しています..." : "LINEにテスト通知を送る"}
      </Button>
      <Toast message={toast?.message ?? null} variant={toast?.variant} onDismiss={() => setToast(null)} />
    </>
  );
}
