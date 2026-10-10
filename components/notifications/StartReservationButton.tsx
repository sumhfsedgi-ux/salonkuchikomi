"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import Alert from "@/components/ui/Alert";
import { startReservationNotificationsAction } from "@/app/dashboard/notifications/actions";

// 旧サービスを使っていない店舗が、予約通知を自分で開始するボタン。
// 開始の可否はサーバー(DB)で再確認する。旧サービス利用店舗はここから開始できない。
export default function StartReservationButton() {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (starting) return;
    setStarting(true);
    setError(null);
    const result = await startReservationNotificationsAction();
    setStarting(false);
    if (!result.ok) setError(result.error ?? "開始できませんでした。");
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-ink-muted">開始した時点から届いた予約メールを通知します(それより前の予約は通知しません)。</p>
      <Button type="button" onClick={handleClick} disabled={starting} className="w-fit">
        {starting ? "開始しています..." : "予約通知を開始する"}
      </Button>
      {error && <Alert variant="error">{error}</Alert>}
    </div>
  );
}
