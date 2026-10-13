import type { EntitlementReason } from "@/lib/features/entitlements";
import { MAIL_CHECK_STALE_MS } from "@/lib/features/featureState";
import { accessState } from "@/lib/ops/featureDisplay";
import { formatJst } from "@/lib/ops/labels";
import type { GoogleBindingSummary, ReservationOpsSummary } from "@/lib/ops/queries";

// 運営管理の「連携と稼働状況」に出す、予約通知の実際の状態(DBに触れない)。
// 内部の状態(運用状態・停止期間・スイッチ)をそのまま並べず、実際に通知しているかと、止まっている理由・次に必要な対応・担当を出す。
// 新しい仕組みでの送信の条件(notifications_list_pollable_salons・notifications_begin_send)と同じ項目を見る。
// 利用許可だけを根拠に「通知中」とは出さない。ここでは状態を読むだけで、開始・再開・接続の操作はしない。

export type ReservationStatus = "sending" | "unverified" | "stopped" | "awaiting_cutover" | "setup_required" | "not_in_use";

export const RESERVATION_STATUS_LABELS: Record<ReservationStatus, string> = {
  sending: "通知中",
  unverified: "確認できません",
  stopped: "停止中",
  awaiting_cutover: "切り替え待ち",
  setup_required: "設定が必要",
  not_in_use: "利用していません",
};

export type StopReasonKey =
  | "not_entitled"
  | "hold"
  | "not_started"
  | "awaiting_cutover"
  | "operator_paused"
  | "legacy_unconfirmed"
  | "master_off"
  | "customer_stopped"
  | "gmail_missing"
  | "gmail_reconnect"
  | "no_line_recipients"
  | "mail_check_stale";

export type ActionOwner = "salon" | "operator";

export const ACTION_OWNER_LABELS: Record<ActionOwner, string> = { salon: "サロン側", operator: "運営側" };

export interface StopReason {
  key: StopReasonKey;
  /** 止まっている理由。 */
  text: string;
  /** 次に必要な対応(無ければ null)。 */
  action: string | null;
  owner: ActionOwner | null;
}

export interface ReservationSummary {
  status: ReservationStatus;
  sending: boolean;
  reasons: StopReason[];
}

/** 止める操作・停止の記録による理由(設定の不足とは分ける)。 */
const STOP_KEYS: StopReasonKey[] = ["hold", "operator_paused", "legacy_unconfirmed", "master_off", "customer_stopped"];
/** 連携・通知先・開始など、設定の不足による理由。 */
const SETUP_KEYS: StopReasonKey[] = ["not_started", "gmail_missing", "gmail_reconnect", "no_line_recipients"];

export function summarizeReservation(input: {
  /** 予約通知の利用許可の判定(DB の salon_feature_access)。読めなければ null(利用許可が無いとして扱う)。 */
  entitlement: { allowed: boolean; reason: EntitlementReason } | null;
  holdOpen: boolean;
  reservation: Pick<
    ReservationOpsSummary,
    "state" | "legacy" | "pauseReason" | "masterEnabled" | "customerSwitchOn" | "lineRecipients" | "activatedAt" | "lastMailCheckAt"
  >;
  gmail: Pick<GoogleBindingSummary, "authState" | "scopeMissingSince"> | null;
  /** LINE の通知先をサロンが自分で追加できるか(できなければ運営が登録する)。 */
  lineInvitesAvailable: boolean;
  now: Date;
}): ReservationSummary {
  const r = input.reservation;
  const entitled = Boolean(input.entitlement?.allowed);
  const started = r.state !== null && r.state !== "setup_pending";
  const reasons: StopReason[] = [];
  const add = (key: StopReasonKey, text: string, action: string | null, owner: ActionOwner | null) => reasons.push({ key, text, action, owner });

  if (!entitled) {
    const state = input.entitlement ? accessState(input.entitlement) : "not_allowed";
    const text =
      state === "not_in_plan"
        ? "契約プランの対象外です。"
        : state === "coming_soon"
          ? "提供の準備中です。"
          : state === "ended"
            ? "提供を終了しています。"
            : "利用を許可していません。";
    const action = state === "not_in_plan" || state === "not_allowed" ? "使う場合は、「契約プラン・使える機能」でプランと利用許可を見直してください。" : null;
    add("not_entitled", text, action, action ? "operator" : null);
  }
  if (input.holdOpen) {
    add(
      "hold",
      "権限による停止中です。",
      entitled ? "下の「停止を解除する」で解除してください。" : "利用を許可したあと、権限による停止を解除してください。",
      "operator",
    );
  }
  // 使っていない店舗(利用許可が無く、開始もしていない)に、連携・開始などの設定を求めない。
  if (!entitled && !started) return { status: "not_in_use", sending: false, reasons };
  if (!started) {
    // 旧サービスから移る店舗は、開始(切り替え)を運営が行う。それ以外の店舗は、サロンが予約通知の画面で開始する。
    if (r.legacy) add("not_started", "予約通知の開始前です。", "サロン側の準備が終わったら、旧サービスからの切り替えを完了してください。", "operator");
    else add("not_started", "予約通知の開始前です。", "サロンの予約通知の画面で開始してください。", "salon");
  }
  if (r.state === "awaiting_cutover") {
    add("awaiting_cutover", "旧サービスからの切り替えが完了していません。完了するまで、この仕組みからは通知しません。", "旧サービスからの切り替えを完了してください。", "operator");
  }
  if (r.state === "paused") {
    if (r.pauseReason?.startsWith("legacy_")) {
      add("legacy_unconfirmed", "旧サービスの状態を確認できないため、止めています。", "旧サービスの状態を確認してください。", "operator");
    } else {
      add("operator_paused", `運営が一時停止しています${r.pauseReason ? `(理由: ${r.pauseReason})` : ""}。`, "再開する場合は、運用手順に沿って再開してください。", "operator");
    }
  }
  if (!r.masterEnabled) add("master_off", "サロンが予約通知の受信をOFFにしています。", "再開する場合は、サロンの予約通知の画面で受信をONにしてください。", "salon");
  if (r.customerSwitchOn === false) add("customer_stopped", "サロンが予約通知の利用を停止しています。", "再開する場合は、サロンの予約通知の画面で再開してください。", "salon");
  if (!input.gmail) {
    add("gmail_missing", "予約メールを受信するGoogleアカウントが連携されていません。", "予約メールを受信するGoogleアカウントを連携してください。", "salon");
  } else if (input.gmail.authState !== "active" || input.gmail.scopeMissingSince) {
    add("gmail_reconnect", "Googleアカウントの連携が切れているか、必要な権限がありません。", "サロン設定のGoogle連携から再接続してください。", "salon");
  }
  if (r.lineRecipients === 0) add("no_line_recipients", "LINEの通知先が登録されていません。", "LINEの通知先を登録してください。", input.lineInvitesAvailable ? "salon" : "operator");

  // 条件がそろって稼働中でも、予約メールの確認が止まっていれば、通知しているとは言えない(お客様の画面の「確認中」と同じ基準)。
  if (r.state === "active" && reasons.length === 0) {
    const since = r.lastMailCheckAt ?? r.activatedAt;
    if (since && input.now.getTime() - new Date(since).getTime() > MAIL_CHECK_STALE_MS) {
      add(
        "mail_check_stale",
        r.lastMailCheckAt ? `${formatJst(r.lastMailCheckAt)}から予約メールの確認ができていません。` : "予約メールの確認ができていません。",
        "予約メールの確認(定期処理)の状態を確認してください。",
        "operator",
      );
      return { status: "unverified", sending: false, reasons };
    }
    return { status: "sending", sending: true, reasons };
  }

  const has = (keys: StopReasonKey[]) => reasons.some((x) => keys.includes(x.key));
  let status: ReservationStatus;
  if (!entitled) status = "stopped";
  else if (has(STOP_KEYS)) status = "stopped";
  else if (has(SETUP_KEYS)) status = "setup_required";
  else if (r.state === "awaiting_cutover") status = "awaiting_cutover";
  else status = "setup_required";
  return { status, sending: false, reasons };
}

/** 権限による停止を解除しても残る理由(解除の確認・結果の表示用)。 */
export function remainingAfterRelease(summary: ReservationSummary): string[] {
  return summary.reasons.filter((r) => r.key !== "hold" && r.key !== "not_entitled").map((r) => r.text);
}
