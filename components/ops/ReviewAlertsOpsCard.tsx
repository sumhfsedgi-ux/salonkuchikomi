import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import { formatJst } from "@/lib/ops/labels";
import { loadReviewAlertPanel } from "@/lib/reviews/alerts/ownerData";
import { autoCheckSummary, deliveryStatusText, stopReasonText } from "@/lib/reviews/alerts/status";
import { isAutoSyncEnabled, isReviewAlertsEnabled } from "@/lib/reviews/alerts/config";
import { logSafeError } from "@/lib/google/safeError";

// 運営画面(閲覧だけ): 口コミの自動確認と LINE 通知の状態。開始・停止はお客様の画面だけで行う(ここからは変えない)。
// 利用許可は口コミ(reviews)の許可に連動する(0032)。口コミの LINE 通知だけの個別のスイッチは無い。
// 通知先の宛先・口コミの内容は表示しない(件数と状態だけ)。

const PUSH_LABELS: Record<string, string> = {
  ours: "SalonPackが登録済み",
  foreign: "ほかのサービスが使用中(定期確認のみ)",
  none: "未登録",
  error: "登録・確認に失敗",
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 py-2 sm:grid-cols-[12rem_1fr] sm:gap-4">
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-sm text-ink [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

export default async function ReviewAlertsOpsCard({ salonId }: { salonId: string }) {
  let data: Awaited<ReturnType<typeof loadReviewAlertPanel>>;
  try {
    data = await loadReviewAlertPanel(salonId);
  } catch (error) {
    logSafeError("ops/reviewAlerts", error);
    return (
      <Card>
        <h3 className="text-base font-semibold text-ink">口コミの自動確認・LINE通知</h3>
        <p className="mt-2 text-sm text-ink-muted">状態を読み込めませんでした。</p>
      </Card>
    );
  }
  const auto = autoCheckSummary({
    available: isAutoSyncEnabled(),
    connected: data.consentOk && data.hasLocation,
    authHold: data.autoSync.authHold,
    lastSuccessAt: data.autoSync.lastSuccessAt,
    consecutiveFailures: data.autoSync.consecutiveFailures,
    pushState: data.autoSync.pushState,
  });
  const counts = new Map<string, number>();
  for (const d of data.recent) counts.set(d.status, (counts.get(d.status) ?? 0) + 1);
  const stop = data.settings.enabled ? null : stopReasonText(data.settings.stopReason);

  return (
    <Card className="flex flex-col gap-3" data-review-alerts={data.settings.enabled ? "enabled" : "disabled"}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold text-ink">口コミの自動確認・LINE通知</h3>
        <Badge variant={auto.tone} className="whitespace-nowrap">
          自動確認: {auto.label}
        </Badge>
        <Badge variant={data.settings.enabled ? "success" : "neutral"} className="whitespace-nowrap">
          LINE通知: {!isReviewAlertsEnabled() ? "準備中" : data.settings.enabled ? "開始済み" : data.settings.notifyFrom ? "停止中" : "開始前"}
        </Badge>
      </div>
      {stop && <p className="text-sm text-ink">{stop}</p>}
      <dl className="divide-y divide-border">
        <Row label="同意(最新の版)">{data.consentOk ? "済み" : "未(または古い版)"}</Row>
        <Row label="店舗の選択と最初の取り込み">{data.hasLocation ? "済み" : "未"}</Row>
        <Row label="最後の自動確認">{data.autoSync.lastSuccessAt ? formatJst(data.autoSync.lastSuccessAt) : "—"}</Row>
        <Row label="連続の失敗">{data.autoSync.consecutiveFailures}回{data.autoSync.authHold ? "(Googleの再連携が必要)" : ""}</Row>
        <Row label="Googleの通知(Pub/Sub)">{data.autoSync.pushState ? PUSH_LABELS[data.autoSync.pushState] : "—"}</Row>
        <Row label="通知の開始・再開">{data.settings.notifyFrom ? formatJst(data.settings.notifyFrom) : "—"}</Row>
        <Row label="口コミ通知がONの通知先">{data.activeRecipients}人</Row>
        <Row label="直近の配信(最大20件)">
          {data.recent.length === 0 ? "—" : [...counts.entries()].map(([status, n]) => `${deliveryStatusText(status, null, false, true)} ${n}件`).join("・")}
        </Row>
      </dl>
    </Card>
  );
}
