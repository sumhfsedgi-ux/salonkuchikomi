import Card from "@/components/ui/Card";
import { formatDateTimeJST } from "@/lib/notifications/formatDateTimeJST";
import type { DeliveryView } from "@/lib/notifications/db/notificationDeliveries";
import type { LineConnection } from "@/lib/notifications/db/lineConnections";

interface Props {
  deliveries: DeliveryView[];
  /** どの送信先(スタッフ)向けの行かを表示するためのラベル解決用。 */
  recipients: LineConnection[];
}

function eventLabel(eventType: string): string {
  switch (eventType) {
    case "new_reservation":
      return "新規予約";
    case "cancellation":
      return "キャンセル";
    default:
      return "予約に関するお知らせ";
  }
}

const SKIP_REASONS: Record<string, string> = {
  recipient_toggle_off: "このスタッフの通知設定がOFFのため送っていません",
  recipient_all_off: "このスタッフの通知設定がすべてOFFのため送っていません",
  recipient_disconnected: "LINEの送信先が接続されていないため送っていません",
  destination_changed: "LINEの送信先が変わったため送っていません",
  stale_after_outage: "届いてから時間がたっていたため送っていません",
  before_fetch_start: "通知の開始前に届いた予約のため送っていません",
};

// 「LINEが受け付けた」ことと「スタッフの端末に届いた」ことは別(LINE の受付確認までしか分からない)。
function describe(row: DeliveryView): string {
  const event = eventLabel(row.eventType);
  if (row.origin === "hmail") return `${event}(以前のサービスで通知済み)`;
  switch (row.status) {
    case "sent":
      return `${event}をLINEに送信しました(LINEが受け付けました)`;
    case "pending":
    case "claimed":
      return `${event}を送信しています`;
    case "unknown":
    case "retry_wait":
      return `${event}: LINEの受付を確認中です(同じ内容で再試行します)`;
    case "failed":
      return `${event}: LINEへの送信に失敗しました`;
    case "needs_review":
      return `${event}: 運営で確認しています`;
    case "skipped":
      if (row.skipReason?.startsWith("received_while_stopped")) return `${event}: 通知を止めていた間に届いたため送っていません`;
      return `${event}: ${SKIP_REASONS[row.skipReason ?? ""] ?? "送っていません"}`;
  }
}

export default function RecentNotificationsList({ deliveries, recipients }: Props) {
  const labelById = new Map(recipients.map((r) => [r.id, r.label]));
  const showRecipientLabel = recipients.length > 1;

  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-ink">最近の通知</h2>
      {deliveries.length === 0 ? (
        <p className="text-sm text-ink-muted">まだ通知はありません。</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {deliveries.map((row) => {
            const recipientLabel = labelById.get(row.lineConnectionId);
            return (
              <li key={row.id} className="flex flex-col gap-0.5 text-sm">
                <span className="text-xs text-ink-muted">{formatDateTimeJST(row.mailReceivedAt ?? row.updatedAt)}</span>
                <span className="text-ink">
                  {describe(row)}
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
