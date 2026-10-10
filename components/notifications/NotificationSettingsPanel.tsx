"use client";

import { useState } from "react";
import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import Alert from "@/components/ui/Alert";
import SupportContact from "@/components/support/SupportContact";
import { updateMasterEnabledAction } from "@/app/dashboard/notifications/actions";
import { LOCKED_SETTING_MESSAGE } from "@/lib/notifications/recipients/messages";
import type { SupportContact as Contact } from "@/lib/support/contact";

interface Props {
  initialMasterEnabled: boolean;
  /** 切り替え待ちの間は変更できない(DB の notification_settings_set_master と同じ判定)。 */
  locked: boolean;
  supportContact: Contact | null;
}

// 予約通知の全体スイッチ。バッジは「受け取る設定」の ON/OFF だけを表す
// (実際に通知しているか=稼働状態は、上の「予約通知の状態」で表示する。ここで「通知中」とは書かない)。
// 通知先ごとの設定は RecipientsPanel。
export default function NotificationSettingsPanel({ initialMasterEnabled, locked, supportContact }: Props) {
  const [masterEnabled, setMasterEnabled] = useState(initialMasterEnabled);
  const [error, setError] = useState<string | null>(null);

  async function handleMasterChange(checked: boolean) {
    const previous = masterEnabled;
    setMasterEnabled(checked);
    setError(null);
    const result = await updateMasterEnabledAction(checked);
    if (!result.ok) {
      setMasterEnabled(previous);
      setError(result.error ?? "保存に失敗しました。");
    }
  }

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">通知の受け取り</h2>
        <Badge variant={masterEnabled ? "success" : "neutral"} dot>
          {masterEnabled ? "ON" : "OFF"}
        </Badge>
      </div>
      <label htmlFor="notif-master" className="flex items-center justify-between gap-3 py-1">
        <span className="text-sm text-ink">予約通知を受け取る</span>
        <input
          id="notif-master"
          type="checkbox"
          checked={masterEnabled}
          disabled={locked}
          onChange={(e) => handleMasterChange(e.target.checked)}
          className="h-5 w-5 shrink-0 accent-sage-dark"
        />
      </label>
      <p className="text-xs text-ink-muted">
        OFFの間に届いた予約は、ONに戻してもまとめて送りません(新しく届いた予約から通知します)。
      </p>
      {locked && (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-ink-muted">{LOCKED_SETTING_MESSAGE}</p>
          <SupportContact contact={supportContact} />
        </div>
      )}
      {error && <Alert variant="error">{error}</Alert>}
    </Card>
  );
}
