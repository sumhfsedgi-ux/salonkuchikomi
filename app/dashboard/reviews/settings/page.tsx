import Link from "next/link";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { loadReplySettings, type LoadedReplySettings } from "@/lib/replyGeneration/settingsRepo";
import { DEFAULT_REPLY_SETTINGS } from "@/lib/replyGeneration/settings";
import { getInboxPageContext } from "@/lib/googleReviews/pageContext";
import { INBOX_PATH } from "@/lib/googleReviews/query";
import { formatCheckedAt } from "@/lib/googleReviews/format";
import type { GbpConnectionState } from "@/lib/googleReviews/types";
import PageHeader from "@/components/ui/PageHeader";
import Card from "@/components/ui/Card";
import Alert from "@/components/ui/Alert";
import Badge from "@/components/ui/Badge";
import { buttonClassName } from "@/components/ui/Button";
import ReviewsSubNav from "@/components/reviews/ReviewsSubNav";
import ReplySettingsForm from "@/components/reviews/settings/ReplySettingsForm";
import ReviewAlertsPanel from "@/components/reviews/settings/ReviewAlertsPanel";
import { changeLocationAction, saveReplySettingsAction } from "@/app/dashboard/reviews/settings/actions";
import { loadReviewAlertPanel, type ReviewAlertPanelData } from "@/lib/reviews/alerts/ownerData";
import { reviewAlertTestDestinations } from "@/lib/reviews/alerts/ownerOps";
import { autoCheckSummary, type ReviewAlertState } from "@/lib/reviews/alerts/status";
import { isAutoSyncEnabled, isReviewAlertsEnabled } from "@/lib/reviews/alerts/config";
import { isRealLineSendAllowed, resolveLineSendPolicy } from "@/lib/notifications/line/sendPolicy";
import { getLineLoginConfig } from "@/lib/notifications/line/login/config";
import { logSafeError } from "@/lib/google/safeError";

// 口コミの設定タブ(計画 第2版 §2)。Google 連携の状態と店舗の変更、AI返信の設定、
// 新しい口コミの自動確認と LINE 通知(第2段階)。届いた口コミを使えない店舗は 404(lib/googleReviews/pageContext.ts)。
export const dynamic = "force-dynamic";

const LOCATION_MESSAGES: Record<string, string> = {
  confirm_required: "店舗を変更するときは、確認のチェックを入れてください。",
  failed: "店舗の変更を始められませんでした。画面を読み込み直して、もう一度お試しください。",
};

async function loadSettingsOrDefault(salonId: string): Promise<LoadedReplySettings> {
  try {
    return await loadReplySettings(getSupabaseAdmin(), salonId);
  } catch {
    return { settings: { ...DEFAULT_REPLY_SETTINGS }, storageAvailable: false };
  }
}

const STATUS: Record<GbpConnectionState["kind"], { label: string; tone: "success" | "warning" | "neutral" }> = {
  connected: { label: "連携済み", tone: "success" },
  selecting: { label: "店舗を選んでください", tone: "warning" },
  consent_required: { label: "取り扱いの確認が必要です", tone: "warning" },
  scope_missing: { label: "権限が不足しています", tone: "warning" },
  needs_reconnect: { label: "再接続が必要です", tone: "warning" },
  not_connected: { label: "未連携", tone: "neutral" },
};

async function loadAlertPanelOrNull(salonId: string): Promise<{ data: ReviewAlertPanelData; realTestRecipients: number } | null> {
  try {
    const [data, destinations] = await Promise.all([loadReviewAlertPanel(salonId), reviewAlertTestDestinations(salonId)]);
    const policy = resolveLineSendPolicy();
    return { data, realTestRecipients: destinations.filter((d) => isRealLineSendAllowed(policy, d.destinationId)).length };
  } catch (error) {
    logSafeError("reviews/settings alerts", error);
    return null;
  }
}

const UNUSABLE_GOOGLE: ReadonlySet<GbpConnectionState["kind"]> = new Set(["not_connected", "needs_reconnect", "scope_missing"]);

export default async function DashboardReviewsSettingsPage({ searchParams }: PageProps<"/dashboard/reviews/settings">) {
  const { access, connection } = await getInboxPageContext();
  const params = await searchParams;
  const locationMessage = typeof params.location === "string" ? LOCATION_MESSAGES[params.location] : undefined;
  const { settings, storageAvailable } = await loadSettingsOrDefault(access.salon.id);
  const status = STATUS[connection.kind];
  const email = connection.kind === "not_connected" ? null : connection.googleEmail;
  const alerts = await loadAlertPanelOrNull(access.salon.id);
  const alertState: ReviewAlertState | null = alerts && {
    alertsAvailable: isReviewAlertsEnabled(),
    enabled: alerts.data.settings.enabled,
    stopReason: alerts.data.settings.stopReason,
    notifyFrom: alerts.data.settings.notifyFrom,
    consentOk: alerts.data.consentOk,
    googleUsable: !UNUSABLE_GOOGLE.has(connection.kind) && !alerts.data.autoSync.authHold,
    hasLocation: alerts.data.hasLocation,
    activeRecipients: alerts.data.activeRecipients,
  };
  const autoCheck =
    alerts &&
    autoCheckSummary({
      available: isAutoSyncEnabled(),
      connected: connection.kind === "connected" && alerts.data.consentOk && alerts.data.hasLocation,
      authHold: alerts.data.autoSync.authHold,
      lastSuccessAt: alerts.data.autoSync.lastSuccessAt,
      consecutiveFailures: alerts.data.autoSync.consecutiveFailures,
      pushState: alerts.data.autoSync.pushState,
    });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="口コミ" description="Google連携・AI返信の案の作り方・新しい口コミのLINE通知を設定できます。" />
      <ReviewsSubNav showInbox />

      <section className="flex flex-col gap-3" aria-labelledby="google-connection-heading">
        <h2 id="google-connection-heading" className="text-sm font-semibold text-ink">
          Google連携
        </h2>
        {locationMessage && <Alert variant="warning">{locationMessage}</Alert>}
        <Card className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <p className="font-medium text-ink">Google口コミ</p>
            <Badge variant={status.tone} dot>
              {status.label}
            </Badge>
          </div>
          <dl className="grid gap-3 text-sm sm:grid-cols-[max-content_minmax(0,1fr)] sm:gap-x-6 sm:gap-y-2">
            <div className="flex min-w-0 flex-col gap-0.5 sm:contents">
              <dt className="whitespace-nowrap text-ink-muted">Googleアカウント</dt>
              <dd className="min-w-0 wrap-anywhere text-ink">{email ?? "—"}</dd>
            </div>
            <div className="flex min-w-0 flex-col gap-0.5 sm:contents">
              <dt className="whitespace-nowrap text-ink-muted">連携している店舗</dt>
              <dd className="min-w-0 break-words text-ink">
                {connection.kind === "connected" ? (connection.location.title ?? "(名前を取得できていません)") : "—"}
              </dd>
            </div>
            {connection.kind === "connected" && (
              <div className="flex min-w-0 flex-col gap-0.5 sm:contents">
                <dt className="whitespace-nowrap text-ink-muted">連携した日時</dt>
                <dd className="min-w-0 text-ink">{formatCheckedAt(connection.connectedAt)}</dd>
              </div>
            )}
          </dl>
          <div className="flex flex-wrap gap-2">
            {connection.kind !== "connected" && (
              <Link href={INBOX_PATH} className={buttonClassName({ size: "sm" })}>
                {connection.kind === "not_connected" ? "Googleと連携する" : "「口コミ」タブで続ける"}
              </Link>
            )}
            <Link href="/dashboard/settings/google" className={buttonClassName({ variant: "secondary", size: "sm" })}>
              Google連携の管理
            </Link>
          </div>
          {connection.kind === "connected" && (
            <details className="text-sm">
              <summary className="cursor-pointer text-ink-muted">連携する店舗を変更する</summary>
              <form action={changeLocationAction} className="mt-2 flex flex-col gap-2">
                <p className="text-xs text-ink-muted">
                  変更すると、今の店舗について一時保存している口コミと下書きを削除し、「口コミ」タブで店舗を選び直します。Googleに投稿済みの返信は変わりません。
                </p>
                <label className="flex items-start gap-2 text-sm text-ink">
                  <input type="checkbox" name="confirm" value="yes" required className="mt-0.5 h-5 w-5 shrink-0 accent-sage-dark" />
                  一時保存した口コミと下書きが削除されることを確認しました
                </label>
                <button type="submit" className={buttonClassName({ variant: "secondary", size: "sm", className: "w-fit" })}>
                  店舗を選び直す
                </button>
              </form>
            </details>
          )}
          <p className="text-xs text-ink-muted">利用の停止・Googleアカウントの切り替えは「Google連携の管理」からできます。予約メール(Gmail)の連携は変わりません。</p>
        </Card>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="reply-settings-heading">
        <div>
          <h2 id="reply-settings-heading" className="text-sm font-semibold text-ink">
            AI返信
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            店舗名・業種・店舗の特徴は
            <Link href="/dashboard/settings" className="text-sage-dark underline underline-offset-2">
              サロン設定
            </Link>
            の内容を使います。
          </p>
        </div>
        <ReplySettingsForm initialSettings={settings} storageAvailable={storageAvailable} save={saveReplySettingsAction} />
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="auto-check-heading">
        <h2 id="auto-check-heading" className="text-sm font-semibold text-ink">
          新しい口コミの自動確認
        </h2>
        {autoCheck ? (
          <Card className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <p className="font-medium text-ink">自動確認</p>
              <Badge variant={autoCheck.tone} dot>
                {autoCheck.label}
              </Badge>
            </div>
            <p className="text-sm text-ink-muted">{autoCheck.detail}</p>
            {alerts?.data.autoSync.lastSuccessAt && (
              <p className="text-xs text-ink-muted">最終確認 {formatCheckedAt(alerts.data.autoSync.lastSuccessAt)}</p>
            )}
            {alerts?.data.autoSync.authHold && (
              <Link href="/dashboard/settings/google" className={buttonClassName({ variant: "secondary", size: "sm", className: "w-fit" })}>
                Google連携の管理
              </Link>
            )}
          </Card>
        ) : (
          <Alert variant="warning">自動確認の状態を読み込めませんでした。画面を読み込み直してください。</Alert>
        )}
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="line-alerts-heading">
        <h2 id="line-alerts-heading" className="text-sm font-semibold text-ink">
          LINE通知
        </h2>
        {alerts && alertState ? (
          <ReviewAlertsPanel
            salonName={access.salon.name}
            data={alerts.data}
            state={alertState}
            invitesAvailable={getLineLoginConfig() !== null}
            sendMode={resolveLineSendPolicy().mode}
            realTestRecipients={alerts.realTestRecipients}
          />
        ) : (
          <Alert variant="warning">LINE通知の状態を読み込めませんでした。画面を読み込み直してください。</Alert>
        )}
      </section>
    </div>
  );
}
