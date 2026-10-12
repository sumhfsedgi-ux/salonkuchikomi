"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import Alert from "@/components/ui/Alert";
import { resumeReservationNotificationsAction } from "@/app/dashboard/notifications/actions";

// 「予約通知の利用を停止する」で止めた予約通知を再開するボタン。再開の可否はサーバーで確かめ直す
// (運営による停止・受信の ON/OFF・旧サービスからの切り替えの状態は、このボタンでは変わらない)。
export default function ResumeReservationButton() {
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (resuming) return;
    setResuming(true);
    setError(null);
    const result = await resumeReservationNotificationsAction();
    setResuming(false);
    if (!result.ok) setError(result.error ?? "再開できませんでした。");
  }

  return (
    <div className="flex flex-col gap-2">
      <Button type="button" onClick={handleClick} disabled={resuming} className="w-fit">
        {resuming ? "再開しています..." : "予約通知を再開する"}
      </Button>
      {error && <Alert variant="error">{error}</Alert>}
    </div>
  );
}
