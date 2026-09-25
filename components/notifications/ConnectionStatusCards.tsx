import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import type { MailConnection } from "@/lib/notifications/db/mailConnections";
import type { LineConnection } from "@/lib/notifications/db/lineConnections";

interface Props {
  mailConnection: MailConnection | null;
  lineConnections: LineConnection[];
}

// Gmail/LINEの接続状態を表示するだけの読み取り専用カード。新規接続・
// 再接続の操作UI(hmailのsetup step-1/2相当)は今回のスコープ外
// (既存ユーザーの移行のみが目的のため) -- 接続が無い/切れている場合も、
// ここでは状態を見せるだけにとどめる。LINEは1店舗に複数のスタッフ分の
// 送信先を持てるため、接続中の人数を表示する(内訳は下のパネルで見せる)。
export default function ConnectionStatusCards({ mailConnection, lineConnections }: Props) {
  const connectedCount = lineConnections.filter((c) => c.status === "connected").length;

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Card className="flex flex-col gap-2">
        <p className="font-medium text-ink">予約メール(Gmail)</p>
        {mailConnection ? (
          <>
            <Badge variant={mailConnection.status === "connected" ? "success" : "warning"} dot>
              {mailConnection.status === "connected" ? "接続済み" : "再接続が必要です"}
            </Badge>
            <p className="truncate text-xs text-ink-muted">{mailConnection.emailAddress}</p>
          </>
        ) : (
          <Badge variant="neutral">未接続</Badge>
        )}
      </Card>

      <Card className="flex flex-col gap-2">
        <p className="font-medium text-ink">LINE通知</p>
        {connectedCount > 0 ? (
          <Badge variant="success" dot>
            {connectedCount}件接続中
          </Badge>
        ) : (
          <Badge variant="neutral">未接続</Badge>
        )}
      </Card>
    </div>
  );
}
