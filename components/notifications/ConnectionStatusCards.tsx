import Link from "next/link";
import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import SupportContact from "@/components/support/SupportContact";
import type { FeatureState, GoogleConnectionSnapshot } from "@/lib/features/featureState";
import type { SupportContact as Contact } from "@/lib/support/contact";
import StartReservationButton from "@/components/notifications/StartReservationButton";

interface Props {
  reservation: FeatureState;
  gmail: GoogleConnectionSnapshot;
  lineRecipientCount: number;
  supportContact: Contact | null;
}

const STATUS_VARIANT: Record<string, "success" | "warning" | "neutral"> = {
  active: "success",
  ready: "success",
  setup_complete: "success",
  ready_to_start: "warning",
  reconnect_required: "warning",
  checking: "warning",
  paused: "neutral",
  setup_required: "neutral",
  google_connect_required: "neutral",
  not_selected: "neutral",
  coming_soon: "neutral",
};

// 予約通知の画面の上部。Google との接続(認証)・LINE の通知先・予約通知の状態(実際に通知しているか)を
// 分けて表示する(Google に接続できたことと、通知が始まったことを混同させない)。旧サービスからの切り替えの
// 内部状態は表示しない。運営による停止・動作を確認できない状態では、運営への問い合わせの導線を出す。
// 開始ボタンは、お客様が自分で開始できる店舗(新規店舗)だけ。
export default function ConnectionStatusCards({ reservation, gmail, lineRecipientCount, supportContact }: Props) {
  const needsGoogleAction = !gmail.bound || gmail.authState !== "active" || !gmail.scopeGranted;

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-2" data-testid="reservation-status">
        <div className="flex items-center justify-between gap-2">
          <p className="font-medium text-ink">予約通知の状態</p>
          <Badge variant={STATUS_VARIANT[reservation.status] ?? "neutral"} dot>
            {reservation.statusLabel}
          </Badge>
        </div>
        {reservation.message && <p className="whitespace-pre-line text-sm text-ink-muted">{reservation.message}</p>}
        {reservation.suggestSupport && <SupportContact contact={supportContact} />}
        {reservation.status === "ready_to_start" && <StartReservationButton />}
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="flex flex-col gap-2">
          <p className="font-medium text-ink">予約メール(Googleとの連携)</p>
          {gmail.bound ? (
            <>
              <Badge variant={needsGoogleAction ? "warning" : "success"} dot>
                {needsGoogleAction ? "再接続が必要です" : "連携済み"}
              </Badge>
              {gmail.email && <p className="truncate text-xs text-ink-muted">{gmail.email}</p>}
            </>
          ) : (
            <Badge variant="neutral">未連携</Badge>
          )}
          <Link href="/dashboard/settings/google" className="mt-1 text-xs text-sage-dark underline underline-offset-2">
            {needsGoogleAction ? (gmail.bound ? "Googleに再接続する" : "Googleと連携する") : "Google連携を確認する"}
          </Link>
        </Card>

        <Card className="flex flex-col gap-2">
          <p className="font-medium text-ink">LINEの通知先</p>
          {lineRecipientCount > 0 ? (
            <Badge variant="success" dot>
              {lineRecipientCount}件 連携済み
            </Badge>
          ) : (
            <Badge variant="neutral">未登録</Badge>
          )}
          <a href="#recipients" className="mt-1 text-xs text-sage-dark underline underline-offset-2">
            通知先を確認・追加する
          </a>
        </Card>
      </div>
    </div>
  );
}
