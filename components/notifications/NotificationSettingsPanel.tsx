"use client";

import { useState } from "react";
import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import Alert from "@/components/ui/Alert";
import { updateMasterEnabledAction, updateLineConnectionSettingsAction } from "@/app/dashboard/notifications/actions";
import type { LineConnection } from "@/lib/notifications/db/lineConnections";

interface Props {
  initialMasterEnabled: boolean;
  recipients: LineConnection[];
}

interface ToggleRowProps {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

function ToggleRow({ id, label, checked, disabled, onChange }: ToggleRowProps) {
  return (
    <label htmlFor={id} className="flex items-center justify-between gap-3 py-1">
      <span className="text-sm text-ink">{label}</span>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-5 w-5 shrink-0 accent-sage-dark"
      />
    </label>
  );
}

// スタッフ1人分の行(destinationごとの接続状態 + イベント種別トグル)。
// トグルは変更のたびにすぐ保存する(確認ボタンを挟まない) -- 既存の
// ReferencePostListItem.tsxと同じ「楽観的更新 + 失敗時ロールバック」パターン。
function RecipientRow({
  recipient,
  masterEnabled,
}: {
  recipient: LineConnection;
  masterEnabled: boolean;
}) {
  const [state, setState] = useState(recipient);
  const [error, setError] = useState<string | null>(null);

  async function handleChange(patch: Partial<Pick<LineConnection, "newReservationEnabled" | "cancellationEnabled">>) {
    const previous = state;
    setState((s) => ({ ...s, ...patch }));
    setError(null);

    const result = await updateLineConnectionSettingsAction(recipient.id, patch);
    if (!result.ok) {
      setState(previous);
      setError(result.error ?? "保存に失敗しました。");
    }
  }

  return (
    <div className="flex flex-col gap-1 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-ink">{state.label ?? "スタッフ"}</span>
        <Badge variant={state.status === "connected" ? "success" : "neutral"} dot>
          {state.status === "connected" ? "接続済み" : "未接続"}
        </Badge>
      </div>
      <ToggleRow
        id={`notif-${recipient.id}-new-reservation`}
        label="新規予約"
        checked={state.newReservationEnabled}
        disabled={!masterEnabled}
        onChange={(checked) => handleChange({ newReservationEnabled: checked })}
      />
      <ToggleRow
        id={`notif-${recipient.id}-cancellation`}
        label="キャンセル"
        checked={state.cancellationEnabled}
        disabled={!masterEnabled}
        onChange={(checked) => handleChange({ cancellationEnabled: checked })}
      />
      {error && <Alert variant="error">{error}</Alert>}
    </div>
  );
}

export default function NotificationSettingsPanel({ initialMasterEnabled, recipients }: Props) {
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
        <h2 className="text-sm font-semibold text-ink">通知内容</h2>
        <Badge variant={masterEnabled ? "success" : "neutral"} dot>
          {masterEnabled ? "通知中" : "停止中"}
        </Badge>
      </div>
      <ToggleRow
        id="notif-master"
        label="予約通知を受け取る"
        checked={masterEnabled}
        onChange={handleMasterChange}
      />
      {error && <Alert variant="error">{error}</Alert>}

      {recipients.length > 0 && (
        <div className="flex flex-col gap-3 border-t border-border pt-3">
          <h3 className="text-xs font-semibold text-ink-muted">送信先ごとの通知設定</h3>
          {recipients.map((recipient) => (
            <RecipientRow key={recipient.id} recipient={recipient} masterEnabled={masterEnabled} />
          ))}
        </div>
      )}
    </Card>
  );
}
