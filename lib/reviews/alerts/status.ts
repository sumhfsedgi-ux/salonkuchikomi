// 口コミの設定タブに出す、自動確認と LINE 通知の状態(画面の文言の決め方。DB の値から作る)。
//   「通知中」は、実際に送れる状態のときだけ表示する(止まっている理由があれば、それを出す)。

export type StopReason = "owner" | "entitlement" | "target_changed" | "consent" | null;
export type PushState = "ours" | "foreign" | "none" | "error" | null;

export interface ReviewAlertState {
  /** REVIEW_ALERTS_ENABLED(このデプロイで LINE 通知を提供しているか)。 */
  alertsAvailable: boolean;
  enabled: boolean;
  stopReason: StopReason;
  notifyFrom: string | null;
  consentOk: boolean;
  googleUsable: boolean;
  hasLocation: boolean;
  activeRecipients: number;
}

export type AlertBadge = { label: string; tone: "success" | "warning" | "neutral" };

/** 開始ボタンを出せるか(開始の条件)。足りないものの一覧も返す。 */
export function startChecklist(s: ReviewAlertState) {
  return [
    { key: "consent", label: "口コミの取り扱いへの同意(最新の版)", ok: s.consentOk },
    { key: "google", label: "Google連携", ok: s.googleUsable },
    { key: "location", label: "店舗の選択と最初の取り込み", ok: s.hasLocation },
    { key: "recipients", label: "口コミ通知がONの通知先(1人以上)", ok: s.activeRecipients > 0 },
  ];
}

/** 止まっている理由(優先順に1つ)。無ければ null。 */
export function blockingReason(s: ReviewAlertState): string | null {
  if (!s.consentOk) return "口コミの取り扱いの確認(同意)の更新が必要です。「口コミ」タブで内容を確認してください。";
  if (!s.googleUsable) return "Googleとの連携の確認が必要です。「Google連携の管理」から再連携してください。";
  if (!s.hasLocation) return "店舗の選択と最初の取り込みが終わっていません。「口コミ」タブで続けてください。";
  return null;
}

export function stopReasonText(reason: StopReason): string | null {
  switch (reason) {
    case "entitlement":
      return "ご利用の状態が変わったため、LINE通知を止めました。再開するには「LINE通知を再開する」を押してください。";
    case "target_changed":
      return "連携しているGoogleアカウント・店舗が変わったため、LINE通知を止めました。確認のうえ、再開してください。";
    case "consent":
      return "口コミの取り扱いの確認(同意)が更新されたため、LINE通知を止めました。同意のあと、再開してください。";
    default:
      return null;
  }
}

export function alertBadge(s: ReviewAlertState): AlertBadge {
  if (!s.alertsAvailable) return { label: "準備中", tone: "neutral" };
  if (!s.enabled) return s.stopReason && s.stopReason !== "owner" ? { label: "止まっています", tone: "warning" } : s.notifyFrom ? { label: "停止中", tone: "neutral" } : { label: "開始前", tone: "neutral" };
  if (blockingReason(s) || s.activeRecipients === 0) return { label: "止まっています", tone: "warning" };
  return { label: "通知中", tone: "success" };
}

export interface AutoCheckState {
  /** GBP_AUTO_SYNC_ENABLED。 */
  available: boolean;
  connected: boolean;
  authHold: boolean;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  pushState: PushState;
}

export function autoCheckSummary(s: AutoCheckState, now: number = Date.now()): { label: string; tone: AlertBadge["tone"]; detail: string } {
  if (!s.available) return { label: "準備中", tone: "neutral", detail: "画面を開いていないときの自動確認は、まだ行っていません。［更新］で取り込めます。" };
  if (!s.connected) return { label: "停止中", tone: "neutral", detail: "Google連携と店舗の選択が終わると、自動で確認を始めます。" };
  if (s.authHold) return { label: "止まっています", tone: "warning", detail: "Googleとの連携の確認が必要です。「Google連携の管理」から再連携してください。" };
  const stale = !s.lastSuccessAt || now - Date.parse(s.lastSuccessAt) > 30 * 60_000;
  if (stale && s.consecutiveFailures > 0) {
    return { label: "確認できていません", tone: "warning", detail: "Googleから口コミを確認できていません。しばらくすると自動でもう一度確認します。" };
  }
  const how =
    s.pushState === "ours"
      ? "Googleからの通知を使い、すぐに確認しています(念のため60分ごとにも確認します)。"
      : s.pushState === "foreign"
        ? "ほかのサービスがGoogleの通知を使っているため、15分ごとに確認しています。"
        : "15分ごとに確認しています。";
  return { label: "自動で確認しています", tone: "success", detail: how };
}

const DELIVERY_STATUS: Record<string, string> = {
  pending: "送信待ち",
  claimed: "送信中(取り消せません)",
  sent: "送信済み",
  unknown: "結果を確認中(同じ内容で再試行します)",
  retry_wait: "再試行を待っています",
  failed: "送れませんでした",
  skipped: "送りませんでした",
  expired: "届いたか確認できませんでした",
};

const SKIP_REASONS: Record<string, string> = {
  stopped_by_owner: "停止したため",
  recipient_off: "口コミ通知をOFFにしたため",
  recipient_removed: "通知先を解除したため",
  recipient_reregistered: "通知先を登録し直したため",
  alerts_off: "LINE通知が止まっていたため",
  not_entitled: "ご利用の状態が変わったため",
  target_changed: "連携先が変わったため",
  stale: "時間が経ちすぎたため",
  review_gone: "口コミが見つからなくなったため",
};

export function deliveryStatusText(status: string, skipReason: string | null, retryStopped: boolean, inFlight: boolean): string {
  if (status === "claimed" && !inFlight) return "送信待ち";
  if (retryStopped && (status === "unknown" || status === "retry_wait")) return "送信済みかもしれません(再試行は止めました)";
  const base = DELIVERY_STATUS[status] ?? status;
  if (status === "skipped" && skipReason && SKIP_REASONS[skipReason]) return `${base}(${SKIP_REASONS[skipReason]})`;
  return base;
}
