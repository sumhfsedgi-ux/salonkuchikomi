import Card from "@/components/ui/Card";
import { formatDateTimeJST } from "@/lib/notifications/formatDateTimeJST";
import type { NotificationHistoryRow } from "@/lib/notifications/db/notificationHistory";
import type { LineConnection } from "@/lib/notifications/db/lineConnections";

interface Props {
  history: NotificationHistoryRow[];
  /** どの送信先(スタッフ)向けの行かを表示するためのラベル解決用。 */
  recipients: LineConnection[];
}

function describeRow(row: NotificationHistoryRow): string {
  if (row.status === "sent") {
    switch (row.eventType) {
      case "new_reservation":
        return "新規予約を通知しました";
      case "cancellation":
        return "キャンセルを通知しました";
      case "test":
        return "テスト通知を送信しました";
      default:
        return "予約に関する通知を送信しました";
    }
  }
  if (row.status === "test") return "テスト通知を送信しました";
  if (row.status === "skipped_disabled") return "通知設定によりスキップしました";
  return "通知の送信に失敗しました";
}

export default function RecentNotificationsList({ history, recipients }: Props) {
  const labelById = new Map(recipients.map((r) => [r.id, r.label]));
  const showRecipientLabel = recipients.length > 1;

  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-ink">最近の通知</h2>
      {history.length === 0 ? (
        <p className="text-sm text-ink-muted">まだ通知はありません。</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {history.map((row) => {
            const recipientLabel = row.lineConnectionId ? labelById.get(row.lineConnectionId) : null;
            return (
              <li key={row.id} className="flex flex-col gap-0.5 text-sm">
                <span className="text-xs text-ink-muted">{formatDateTimeJST(row.sentAt)}</span>
                <span className="text-ink">
                  {describeRow(row)}
                  {showRecipientLabel && recipientLabel ? `(${recipientLabel})` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
